// 完整链路验证：voiceChat → SR(network error) → 自动降级 VAD → chat → TTS
import WebSocket from 'ws';
import http from 'node:http';

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getPages() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9240/json', (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

const pages = await getPages();
const page = pages.find((p) => p.type === 'page' && p.url.includes('index'));
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r) => ws.on('open', r));
log('ws open');

let id = 0;
const pend = new Map();
const consoleLogs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLogs.push(`[${m.params.type}] ${text.slice(0, 150)}`);
  }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');

// Node 侧超时兜底的 evaluate（页面 await 挂起也不阻塞）
const ev = async (expr, ms = 20000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise((r2) => setTimeout(() => r2({ timeout: true }), ms)),
  ]);
  if (r.timeout) return { timeout: true };
  if (r.result?.exceptionDetails) return { err: String(r.result.exceptionDetails.exception?.description || '').slice(0, 150) };
  return { v: r.result?.result?.value };
};

// 1) 调 voiceChat（点击麦克风等效）
log('调 pet.voiceChat()…');
const vc = await ev(`window.pet.voiceChat().then(() => 'called')`, 15000);
log('voiceChat 返回: ' + JSON.stringify(vc.v ?? vc.err ?? vc.timeout));

// 2) 等 SR 报 network 错 + 自动降级（2.5s 足够 onerror 触发）
await sleep(2500);
const st1 = await ev(`(function(){
  return {
    mode: window.pet.voice.getASRMode(),
    srFatal: !!window.pet.voice._srFatal,
    vadActive: window.pet.voice.getVoiceLoopActive(),
    vadPaused: window.pet.voice.getVADPaused(),
    voiceActive: window.pet._voiceActive,
  };
})()`);
log('降级状态: ' + JSON.stringify(st1.v ?? st1.err ?? st1.timeout));

const s1 = st1.v || {};
const degraded = s1.srFatal === true && s1.mode === 'recorder';

// 3) 降级成功 → 等 VAD 真正起来（getUserMedia 权限可能弹窗，给 10s）
if (degraded) {
  await sleep(8000);
  const st2 = await ev(`(function(){
    return {
      vadActive: window.pet.voice.getVoiceLoopActive(),
      vadPaused: window.pet.voice.getVADPaused(),
      listening: window.pet.voice.getListening(),
    };
})()`);
  log('VAD 状态(8s后): ' + JSON.stringify(st2.v ?? st2.err ?? st2.timeout));

  const s2 = st2.v || {};
  if (s2.vadActive) {
    // 4) VAD 活了 → 模拟一句完整转写文本直接注入 _processVoiceText（绕开真实说话，
    //    验证 chat→TTS 播报→恢复听 全循环）
    log('注入转写文本「你好小球」→ 验证 chat+TTS+恢复听循环…');
    const loop = await ev(`(async function(){
      const pet = window.pet;
      const states = [];
      const handler = ({phase}) => states.push(phase);
      window.PetEvents.on('voice:state', handler);
      try {
        await pet._processVoiceText('你好小球，简单介绍下你自己');
      } finally {
        try { window.PetEvents.off && window.PetEvents.off('voice:state', handler); } catch (e) {}
      }
      return { states, voiceActive: pet._voiceActive, vadActive: pet.voice.getVoiceLoopActive(), vadPaused: pet.voice.getVoiceLoopPaused ? 'n/a' : pet.voice.getVADPaused() };
    })()`, 90000);
    log('对话循环: ' + JSON.stringify(loop.v ?? loop.err ?? loop.timeout).slice(0, 300));
    const L = loop.v || {};
    const loopOk = L.vadActive === true && L.vadPaused === false && Array.isArray(L.states);
    console.log((loopOk ? 'PASS' : 'FAIL') + ': 循环对话（chat→TTS→恢复VAD监听）');

    // 结束会话
    await ev(`window.pet.stopVoiceChat(); 'stopped'`);
    const st3 = await ev(`({ vadActive: window.pet.voice.getVoiceLoopActive(), voiceActive: window.pet._voiceActive })`);
    log('停止后: ' + JSON.stringify(st3.v ?? st3.err ?? st3.timeout));
    console.log((st3.v && st3.v.vadActive === false && st3.v.voiceActive === false ? 'PASS' : 'FAIL') + ': stopVoiceChat 彻底停止');
  } else {
    console.log('SKIP: VAD 未激活（macOS 麦克风权限弹窗未确认？），请手动授权后重试');
  }
} else {
  console.log('FAIL: SR→VAD 自动降级（srFatal=' + s1.srFatal + ' mode=' + s1.mode + '）');
}

if (consoleLogs.length) {
  console.log('--- 页面 console（相关）---');
  consoleLogs.filter((l) => /voice|Voice|ASR|asr|TTS|tts|VAD|SR|Speech/i.test(l)).slice(-8).forEach((l) => console.log(l));
}
try { ws.close(); } catch { }
process.exit(0);
