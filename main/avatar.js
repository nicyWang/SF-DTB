// main/avatar.js — 火山实时互动数字人（FlowAct-R1）主进程网关
// 协议：wss://openspeech.bytedance.com/virtual_human/avatar_live/live
// 上行：|CTL|00| 开播初始化 / |DAT|02| 二进制PCM音频 / |CTL|12| 音频结束 / |CTL|01| 关播
// 下行：ByteRTC 视频流（WebRTC，渲染进程用 @volcengine/rtc 拉流）+ 状态事件
// 鉴权：火山 OpenAPI 预签名 URL（需账号 AK/SK，主进程生成——密钥绝不进渲染层）
const { ipcMain } = require('electron');
const WebSocket = require('ws');
const crypto = require('crypto');

const AV_URL = 'wss://openspeech.bytedance.com/virtual_human/avatar_live/live';

// ---------- 火山预签名 URL（V4 签名，服务侧生成 token） ----------
/**
 * 生成火山 OpenAPI 预签名 URL（数字人 token）
 * @param {object} cfg {accessKey, secretKey, accountId} 设置面板配置
 * 参考：火山"获取预签名URL"官方示例（HMAC-SHA256 链式签名）
 */
function buildSignedToken(cfg) {
  const ak = cfg.accessKey, sk = cfg.secretKey, account = cfg.accountId;
  if (!ak || !sk || !account) throw new Error('数字人配置不全（需账号ID/AccessKey/SecretKey）');
  const service = 'avatar_live';
  const region = 'cn-north-1';
  // 简化流程：数字人文档的 token=预签名URL。此处按官方模板实现。
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const shortDate = date.slice(0, 8);
  const credentials = [shortDate, region, service, 'request'];
  const query = {
    Action: 'StartWebsocket', Version: '2024-06-06',
    'X-Date': date, 'X-Algorithm': 'HMAC-SHA256',
    'X-Credential': [ak, ...credentials.slice(0, 3)].join('/'),
    'X-Signed-Headers': '', 'X-Signed-Query': '',
    'X-Expires': '900',
  };
  const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const canonical = `GET\n/\n${qs}\n`;
  const hashPayload = crypto.createHash('sha256').update('').digest('hex');
  const signStr = `HMAC-SHA256\n${date}\n${[shortDate, region, service, 'request'].join('/')}\n${crypto.createHash('sha256').update(canonical + '\n' + hashPayload).digest('hex')}`;
  let key = crypto.createHmac('sha256', sk).update(shortDate).digest();
  for (const part of [region, service, 'request']) key = crypto.createHmac('sha256', key).update(part).digest();
  const signature = crypto.createHmac('sha256', key).update(signStr).digest('hex');
  return `https://visual.volcengineapi.com/?${qs}&X-Signature=${signature}&AccountID=${account}`;
}

// ---------- 帧编码 ----------
function ctlFrame(cmd, body = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const header = Buffer.from(`|CTL|${cmd}|`, 'utf8');
  return Buffer.concat([header, payload]);
}
function audioFrame(pcm) {
  const header = Buffer.from('|DAT|02|', 'utf8');
  return Buffer.concat([header, pcm]);
}

let ws = null;
let sender = null;
let starting = null;

function sendToRenderer(channel, payload) {
  try { sender?.send(channel, payload); } catch { /* ignore */ }
}

function killAvatar() {
  const w = ws;
  ws = null;
  starting = null;
  if (w) { try { w.removeAllListeners(); } catch {} try { w.terminate(); } catch {} }
}

function initAvatarIPC(ipcMain) {
  // 开播：cfg {accountId, accessKey, secretKey, roleImageUrl, rtcAppId, rtcToken, voicePrompt}
  ipcMain.handle('avatar-start', async (e, cfg = {}) => {
    sender = e.sender;
    if (starting) return starting;
    let token;
    try { token = buildSignedToken(cfg); } catch (err) {
      return { ok: false, error: err.message };
    }
    const liveId = `petball_${Date.now()}`;
    const roomId = 'room_' + crypto.randomUUID().slice(0, 12);
    const uid = 'u' + crypto.randomBytes(4).toString('hex');
    starting = new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; starting = null; resolve(r); } };
      try {
        ws = new WebSocket(AV_URL);
      } catch (err) { return done({ ok: false, error: 'WS创建失败: ' + err.message }); }
      const timer = setTimeout(() => done({ ok: false, error: '开播超时(15s)' }), 15000);
      ws.on('open', () => {
        // 开播初始化
        ws.send(ctlFrame('00', {
          live: { live_id: liveId, keep_alive_duration: 60 },
          avatar: {
            avatar_type: 'flowact-r1',
            input_mode: 'audio',
            role: cfg.roleImageUrl, // 公网可访问的形象图
          },
          streaming: {
            type: 'bytertc',
            rtc_app_id: cfg.rtcAppId,
            rtc_room_id: roomId,
            rtc_uid: uid,
            rtc_token: cfg.rtcToken,
          },
        }));
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = data.toString('utf8');
        // 格式 |MSG|xx|{json} 或 |DAT|02|{json}
        const m = text.match(/^\|(MSG|CTL|DAT)\|(\d+)\|/);
        const json = m ? text.slice(m[0].length) : text;
        let body = null;
        try { body = JSON.parse(json); } catch { body = { raw: json.slice(0, 120) }; }
        const code = body?.code;
        if (m && m[2] === '00' && code === 1000) {
          // 开播成功 → 下发 RTC 参数给渲染进程拉流
          clearTimeout(timer);
          sendToRenderer('avatar-event', {
            type: 'live-started',
            rtc: {
              appId: cfg.rtcAppId,
              roomId: body?.data?.rtc?.room_id || roomId,
              innerUid: body?.data?.rtc?.inner_uid,
              localUid: uid,
              token: cfg.rtcToken,
            },
          });
          done({ ok: true, liveId });
        } else if (code && code !== 1000) {
          clearTimeout(timer);
          sendToRenderer('avatar-event', { type: 'error', data: body });
          done({ ok: false, error: `开播失败 code=${code}: ${body?.message || ''}` });
        } else {
          // 状态事件（voice_start/continue/end 等）
          sendToRenderer('avatar-event', { type: 'event', data: body });
        }
      });
      ws.on('error', (err) => { clearTimeout(timer); done({ ok: false, error: 'WS错误: ' + err.message }); });
      ws.on('close', () => { sendToRenderer('avatar-event', { type: 'closed' }); ws = null; });
    });
    return starting;
  });

  // 推音频（PCM 16k，渲染进程转发——接豆包 TTS 输出驱动口型）
  ipcMain.on('avatar-audio-in', (_e, buf) => {
    if (!ws || ws.readyState !== 1) return;
    try {
      const b = Buffer.from(buf.buffer || buf);
      ws.send(audioFrame(b));
    } catch { /* ignore */ }
  });

  // 音频段结束（驱动口型收尾）
  ipcMain.on('avatar-audio-end', () => {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(ctlFrame('12', {})); } catch { /* ignore */ }
  });

  // 关播
  ipcMain.handle('avatar-stop', () => {
    try { if (ws && ws.readyState === 1) ws.send(ctlFrame('01', {})); } catch { /* ignore */ }
    killAvatar();
    return { ok: true };
  });
}

module.exports = { initAvatarIPC };
