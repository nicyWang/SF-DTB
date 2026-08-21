// main/doubao.js — 豆包端到端实时语音：主进程 WS 网关
// 协议（对照 GitHub MarkShawn2020/realtime-dialog 参考实现修正）：
//   - payload 一律 gzip 压缩（compression=0b0001）
//   - StartConnection/FinishConnection：event + payload（无 session id）
//   - Session 级事件（100/102/200）：event + session_id_size + session_id + payload
//   - session_id 由客户端生成（UUID）
//   - 音频上行：Audio-only request + TaskRequest(200) 事件，payload 为原始 PCM（不压缩）
const { ipcMain } = require('electron');
const WebSocket = require('ws');
const crypto = require('crypto');
const zlib = require('zlib');

const DB_URL = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const RESOURCE_ID = 'volc.speech.dialog';
const APP_KEY_FIXED = 'PlgvMymc7f3tQnJ6';

const MT_FULL_CLIENT_REQ = 0b0001;
const MT_AUDIO_ONLY_REQ = 0b0010;
const EV_START_CONNECTION = 1;
const EV_FINISH_CONNECTION = 2;
const EV_START_SESSION = 100;
const EV_FINISH_SESSION = 102;
const EV_TASK_REQUEST = 200;
const EV_CHAT_TTS_TEXT = 300; // ChatTTSText：客户端推文本让豆包直接TTS播报（工具结果用）

/** 通用帧编码：header + [event] + [session] + gzip(payload) */
function encodeFrame({ msgType, event, sessionId = null, payload = null, gzip = true, rawAudio = null }) {
  const parts = [];
  const ser = rawAudio ? 0b0000 : 0b0001; // raw : JSON
  const comp = (gzip && !rawAudio) ? 0b0001 : 0b0000;
  // header 4B
  const header = Buffer.alloc(4);
  header[0] = 0x11;
  header[1] = (msgType << 4) | 0b0100; // MSG_WITH_EVENT
  header[2] = (ser << 4) | comp;
  header[3] = 0x00;
  parts.push(header);
  // event 4B
  const ev = Buffer.alloc(4);
  ev.writeUInt32BE(event);
  parts.push(ev);
  // session id（Session 级事件）
  if (sessionId != null) {
    const sid = Buffer.from(sessionId, 'utf8');
    const sz = Buffer.alloc(4);
    sz.writeUInt32BE(sid.length);
    parts.push(sz, sid);
  }
  // payload
  let data = rawAudio;
  if (data == null && payload != null) {
    let json = Buffer.from(JSON.stringify(payload), 'utf8');
    if (gzip) json = zlib.gzipSync(json);
    data = json;
  }
  const psz = Buffer.alloc(4);
  psz.writeUInt32BE(data ? data.length : 0);
  parts.push(psz);
  if (data && data.length) parts.push(data);
  return Buffer.concat(parts);
}

/** 解析服务端帧（响应 payload 也可能 gzip，需按 compression 位解压） */
function parseFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 4) return null;
  const msgType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const compression = (buf[2] & 0x0f);
  let o = 4;
  let event = null;
  let sessionId = null;
  let seq = null;
  if (flags & 0b0001) { seq = buf.readUInt32BE(o); o += 4; }       // NEG_SEQUENCE
  if (flags & 0b0010) { seq = buf.readUInt32BE(o); o += 4; }       // POS_SEQUENCE
  if (flags & 0b0100) { event = buf.readUInt32BE(o); o += 4; }     // MSG_WITH_EVENT
  // connect id（connect 级事件）
  // session id
  if (o + 4 <= buf.length) {
    const ssz = buf.readUInt32BE(o); o += 4;
    if (ssz > 0 && o + ssz <= buf.length) {
      sessionId = buf.toString('utf8', o, o + ssz);
      o += ssz;
    }
  }
  let payload = null;
  if (o + 4 <= buf.length) {
    const psz = buf.readUInt32BE(o); o += 4;
    if (psz > 0 && o + psz <= buf.length) {
      let p = buf.subarray(o, o + psz);
      if (compression === 0b0001) {
        try { p = zlib.gunzipSync(p); } catch { /* 保持原样 */ }
      }
      payload = p;
    }
  }
  return { event, sessionId, payload, msgType, seq };
}

let ws = null;          // 当前活跃连接
let sessionId = null;
let sender = null;
let connectId = null;
let connecting = null;  // 建连中的 promise（防并发 start 建多个连接！）

let dbgAudioSent = 0;
let dbgTtsStart = 0; // 调试：每连接发送的音频帧计数（排查叠加）
function sendToRenderer(channel, payload) {
  if (channel === 'doubao-audio') {
    dbgAudioSent++;
    if (dbgAudioSent % 50 === 1) console.log(`[doubao-dbg] audio sent #${dbgAudioSent} (ws=${ws ? 'Y' : 'N'})`);
  }
  try { sender?.send(channel, payload); } catch { /* ignore */ }
}

/** 强制关闭当前连接（无论状态），同步置空引用 */
function killConnection() {
  const w = ws;
  try {
    if (w && w.stats) {
      console.log(`[db] 连接结束统计: 上行${w.stats.up}帧 | ASR识别${w.stats.asrTexts.length}次 ${JSON.stringify(w.stats.asrTexts)} | TTS开始${w.stats.ttsStart}次 | 音频${w.stats.audio352}包`);
    }
  } catch { /* ignore */ }
  ws = null;
  sessionId = null;
  connecting = null;
  if (w) {
    try { w.removeAllListeners(); } catch { /* ignore */ }
    try { w.terminate(); } catch { /* ignore */ } // terminate 立即断（close 可能有握手延迟）
  }
}

function safeJson(buf) {
  if (!buf || !buf.length) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return buf.toString('utf8').slice(0, 200); }
}

function initDoubaoIPC(ipcMain) {
  ipcMain.handle('doubao-start', (e, cfg = {}) => {
    sender = e.sender;
    // 并发 start 防护：建连中复用同一 promise（并发会建 N 个连接 → 音频重复 N 遍）
    if (connecting) return connecting;
    // 每次会话全新连接：不复用旧连接（服务端可能残留上一 session 的音频队列，
    // 旧连接复用会把残留回复混进新会话 → 语音叠加）
    if (ws && ws.readyState === 1) killConnection();
    connectId = crypto.randomUUID();
    sessionId = crypto.randomUUID(); // 客户端生成（参考实现同款）
    // ⚠️ 必须 return！之前把 new Promise 赋给 connecting 时丢了 return，
    // handler 返回 undefined → 渲染侧判失败降级 VAD，而主进程连接实际建成
    // 僵尸连接（继续收豆包音频却没人消费）——快速开关 N 轮 = N 个僵尸连接
    // 同 sendToRenderer → 音频重复 N 遍的真正元凶
    connecting = new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        connecting = null; // 建连结束（成功/失败都不再是 connecting 态）
        resolve(r);
      };
      // 通信审计：每连接统计（定位语音重复的确切层）
      const stats = { up: 0, ttsStart: 0, audio352: 0, asrTexts: [], reply350Texts: [] };
      try {
        ws = new WebSocket(DB_URL, {
          headers: {
            'X-Api-App-ID': String(cfg.appId || ''),
            'X-Api-Access-Key': String(cfg.accessToken || ''),
            'X-Api-Resource-Id': RESOURCE_ID,
            'X-Api-App-Key': APP_KEY_FIXED,
            'X-Api-Connect-Id': connectId,
          },
        });
        ws.stats = stats;
      } catch (err) {
        return done({ ok: false, error: 'WS创建失败: ' + err.message });
      }
      const timer = setTimeout(() => done({ ok: false, error: '连接超时(12s)' }), 12000);
      const conn = { stats }; // 事件回调闭包统一走 ws.stats（防作用域错位）
      ws.on('open', () => {
        // StartConnection（无 session id）
        ws.send(encodeFrame({
          msgType: MT_FULL_CLIENT_REQ, event: EV_START_CONNECTION,
          payload: { user: { uid: 'pet-ball' } }, sessionId: null,
        }));
      });
      ws.on('message', (data) => {
        const f = parseFrame(data);
        if (!f) return;
        switch (f.event) {
          case 50: // ConnectionStarted → StartSession（带 session id + 完整配置）
            ws.send(encodeFrame({
              msgType: MT_FULL_CLIENT_REQ, event: EV_START_SESSION,
              sessionId,
              payload: {
                asr: { extra: { end_smooth_window_ms: 800 } },
                dialog: {
                  bot_name: cfg.botName || '毛毛',
                  // 工具能力写入人设：豆包知道自己"有手"，收到指令先爽快应答，
                  // 真正执行由客户端分流完成（它不知道细节，只负责答应和收尾）
                  system_role: (cfg.systemRole ? cfg.systemRole + '\n' : '') + '你连接着主人电脑，拥有真实能力，能力清单（只有这些，清单外的事要么用清单内能力组合完成，要么诚实说这个还不会并提替代方案）：①执行类——定时提醒、打开应用、查看/整理文件、键盘打字、点击屏幕坐标、发微信消息（需微信在Mac登录）。②视觉类——实时截屏分析画面与位置。应答规则：主人指令在能力内→爽快应答"好嘞马上"并等待系统执行（执行结果会自动播报，你只负责应答，不要自己编造执行结果！）；问"能看到我屏幕吗"→"能看到呀，我看看"；指令在能力外（如视频剪辑/装软件/支付）→诚实说"这个我还不会"并给替代建议。铁律：系统没播报执行结果前，绝不说"已发送/已完成/已打开"——那是撒谎。',
                  speaking_style: cfg.speakingStyle || '甜美活泼、口语自然、语句简短',
                  extra: {
                    model: cfg.model || '1.2.1.1',
                    input_mod: 'server_vad',
                    recv_timeout: 60,
                  },
                },
                tts: {
                  speaker: cfg.voice || 'zh_female_xiaohe_jupiter_bigtts',
                  audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 },
                },
              },
            }));
            break;
          case 150: // SessionStarted
            clearTimeout(timer);
            sendToRenderer('doubao-event', { type: 'session-started', dialogId: safeJson(f.payload) });
            done({ ok: true, sessionId });
            break;
          case 51:
            clearTimeout(timer);
            done({ ok: false, error: '连接被拒: ' + String(safeJson(f.payload) || '').slice(0, 150) });
            break;
          case 153:
            sendToRenderer('doubao-event', { type: 'session-failed', data: safeJson(f.payload) });
            break;
          case 450: sendToRenderer('doubao-event', { type: 'user-speech-start' }); break;
          case 451: {
            const j = safeJson(f.payload);
            const txt = j?.results?.[0]?.text;
            if (txt && !j?.results?.[0]?.is_interim) { conn.stats.asrTexts.push(txt); console.log('[db] ASR最终:', txt); }
            sendToRenderer('doubao-event', { type: 'user-text', data: j });
            break;
          }
          case 459: sendToRenderer('doubao-event', { type: 'user-speech-end' }); break;
          case 350: {
            conn.stats.ttsStart++;
            const j = safeJson(f.payload);
            if (j?.text) { conn.stats.reply350Texts.push(j.text); console.log(`[db] 回复#${conn.stats.ttsStart}:`, String(j.text).slice(0, 50)); }
            sendToRenderer('doubao-event', { type: 'tts-start', data: j });
            break;
          }
          case 550: sendToRenderer('doubao-event', { type: 'reply-text', data: safeJson(f.payload) }); break;
          case 352: // TTS 音频
            conn.stats.audio352++;
            if (f.payload && f.payload.length) sendToRenderer('doubao-audio', f.payload);
            break;
          case 359: sendToRenderer('doubao-event', { type: 'tts-end' }); break;
          case 154: sendToRenderer('doubao-event', { type: 'usage', data: safeJson(f.payload) }); break;
          case 599: sendToRenderer('doubao-event', { type: 'error', data: safeJson(f.payload) }); break;
          default: break;
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, error: 'WS错误: ' + err.message });
        sendToRenderer('doubao-event', { type: 'conn-error', data: { message: err.message } });
      });
      ws.on('close', () => {
        // 仅当 close 的是"当前"连接才广播+清理（killConnection 已 removeAllListeners，
        // 这里不会触发；防止旧连接的 close 把新连接状态搞乱）
        sendToRenderer('doubao-event', { type: 'conn-closed' });
        ws = null;
        connecting = null;
      });
    });
    return connecting; // ← 关键：handler 必须返回 promise（IPC invoke 的返回值）
  });

  // 豆包代播文本（工具结果）：ChatTTSText {content, start, end} —— 豆包音色直接合成，
  // 不进对话模型。用户视角：所有回答都是"豆包"说的（门面统一）
  ipcMain.on('doubao-say', (_e, text) => {
    if (!ws || ws.readyState !== 1 || !sessionId) return;
    try {
      ws.send(encodeFrame({
        msgType: MT_FULL_CLIENT_REQ, event: EV_CHAT_TTS_TEXT, sessionId,
        payload: { content: String(text || '').slice(0, 300), start: true, end: true },
      }));
    } catch { /* ignore */ }
  });

  // 渲染进程推麦克风 PCM16k（raw 不压缩）
  ipcMain.on('doubao-audio-in', (_e, buf) => {
    if (!ws || ws.readyState !== 1 || !sessionId) return;
    try {
      if (ws.stats) ws.stats.up++;
      const b = Buffer.from(buf.buffer || buf);
      ws.send(encodeFrame({ msgType: MT_AUDIO_ONLY_REQ, event: EV_TASK_REQUEST, sessionId, rawAudio: b }));
    } catch { /* ignore */ }
  });

  ipcMain.handle('doubao-stop', () => {
    // 礼貌收尾 + 强制断开（terminate 立即生效，绝不留尾巴连接）
    try {
      if (ws && ws.readyState === 1) {
        ws.send(encodeFrame({ msgType: MT_FULL_CLIENT_REQ, event: EV_FINISH_SESSION, sessionId, payload: {} }));
        ws.send(encodeFrame({ msgType: MT_FULL_CLIENT_REQ, event: EV_FINISH_CONNECTION, payload: {}, sessionId: null }));
      }
    } catch { /* ignore */ }
    killConnection();
    return { ok: true };
  });
}

module.exports = { initDoubaoIPC };
