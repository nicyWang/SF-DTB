// 五任务 E2E：UI修复 + 说话静止 + Edge TTS + 知识库 + 感知视觉模型
import WebSocket from 'ws';
import http from 'node:http';

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = await new Promise((res, rej) => http.get('http://127.0.0.1:9240/json', (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
const page = pages.find(p => p.type === 'page' && p.url.includes('index'));
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise(r => ws.on('open', r));
let id = 0; const pend = new Map();
const consoleLogs = [];
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLogs.push(`[${m.params.type}] ${text.slice(0, 160)}`);
  }
});
const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');

const ev = async (expr, ms = 20000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
    new Promise(r2 => setTimeout(() => r2({ timeout: true }), ms)),
  ]);
  if (r.timeout) return { timeout: true };
  if (r.result?.exceptionDetails) return { err: String(r.result.exceptionDetails.exception?.description || '').slice(0, 200) };
  return { v: r.result?.result?.value };
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
};

// ============ T5: UI 修复 ============
log('== T5: UI 修复 ==');
const dock = await ev(`(function(){
  const dock = document.getElementById('dock');
  const mic = document.getElementById('mic-btn');
  const bar = document.getElementById('chat-bar');
  const input = document.getElementById('chat-input');
  const r = mic.getBoundingClientRect();
  return {
    dockOk: !!dock && !!dock.contains(mic) && dock.contains(bar),
    micSize: Math.round(r.width) + 'x' + Math.round(r.height),
    micVisible: r.width > 0 && r.height > 0,
    micPos: Math.round(r.left) + ',' + Math.round(r.bottom),
    winH: window.innerHeight,
    pinnedHook: typeof window.__uiPinned === 'function',
  };
})()`);
const dv = dock.v || {};
check('T5: dock 容器（mic+输入条统一）', dv.dockOk === true, JSON.stringify(dv).slice(0, 120));
check('T5: mic 按钮可见且 40px', dv.micVisible === true && dv.micSize === '40x40', dv.micSize);

// mic 真实点击（合成事件 → voiceChat 状态翻转）
const clickRes = await ev(`(async function(){
  const mic = document.getElementById('mic-btn');
  mic.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 3500)); // 等 SR network error → VAD 降级
  const phase = mic.dataset.phase;
  const active = window.pet.voice.getVoiceLoopActive ? window.pet.voice.getVoiceLoopActive() : null;
  const vadState = window.pet._voiceActive;
  // 关掉，不留会话
  window.pet.stopVoiceChat();
  return { phase, active, vadState };
})()`, 12000);
const cv = clickRes.v || {};
check('T5+T1: mic 可点击（click → VAD 会话启动）', cv.phase !== undefined && (cv.active === true || cv.vadState === true || cv.phase === 'listening'), JSON.stringify(cv).slice(0, 120));

// 输入条：双击打开 → 聚焦 → blur → 再聚焦
const focusRes = await ev(`(async function(){
  const input = document.getElementById('chat-input');
  const bar = document.getElementById('chat-bar');
  // 模拟 openChatBar（双击路径的内部函数效果）
  bar.style.display = 'flex';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  input.focus();
  const f1 = document.activeElement === input;
  input.blur();
  const f0 = document.activeElement === input;
  input.focus();
  const f2 = document.activeElement === input;
  const val = input.setSelectionRange ? (input.setSelectionRange(0,0), 'ok') : 'n/a';
  bar.style.display = 'none';
  return { firstFocus: f1, blurred: !f0, refocus: f2, caret: val };
})()`);
const fv = focusRes.v || {};
check('T5: 输入条失焦后可再次聚焦', fv.blurred === true && fv.refocus === true, JSON.stringify(fv));

// ============ T2: 说话静止 ============
log('== T2: 说话静止 ==');
const frozenRes = await ev(`(async function(){
  const ball = window.liveRefs.sprite;
  if (typeof ball.setFrozen !== 'function') return { api: false };
  const x0 = ball._root.x, y0 = ball._root.y;
  ball.setFrozen(true);
  await new Promise(r => setTimeout(r, 1200));
  const x1 = ball._root.x, y1 = ball._root.y;
  const still = Math.abs(x1 - x0) < 3 && Math.abs(y1 - y0) < 3; // 允许呼吸微幅
  ball.setFrozen(false);
  await new Promise(r => setTimeout(r, 800));
  return { api: true, stillWhileFrozen: still, moved0: [Math.round(x0),Math.round(y0)], moved1: [Math.round(x1),Math.round(y1)] };
})()`, 15000);
const fzv = frozenRes.v || {};
check('T2: setFrozen API + 冻结期间静止', fzv.api === true && fzv.stillWhileFrozen === true, JSON.stringify(fzv).slice(0, 140));

// ============ T1: Edge TTS ============
log('== T1: Edge TTS ==');
const edgeRes = await ev(`(async function(){
  const v = window.pet.voice;
  if (typeof v.speakEdge !== 'function') return { api: false };
  const ok = await v.speakEdge('你好呀主人，我是小球毛毛，这是我的新声音哦！');
  return { api: true, played: ok };
})()`, 45000);
const etv = edgeRes.v || {};
check('T1: speakEdge 真实合成+播放（晓伊音色）', etv.api === true && etv.played === true, JSON.stringify(etv));

// ============ T3: 知识库 ============
log('== T3: 知识库 ==');
const kbRes = await ev(`(async function(){
  const kb = window.liveRefs.knowledge;
  if (!kb) return { api: false };
  const stats0 = kb.stats();
  // 直接 add（向量用真实智谱 embedding；余额不足自动降级关键词模式）
  const r1 = await kb.add('主人正在测试小球的知识库功能');
  const stats1 = kb.stats();
  const hits = await kb.search('知识库 测试');
  return { api: true, added: r1, count: stats0.count + '->' + stats1.count, hits: hits.length, mode: stats1.vectorized > 0 ? 'vector' : 'keyword' };
})()`, 60000);
const kv = kbRes.v || {};
check('T3: 知识库 add+search', kv.api === true && kv.added === true && kv.hits >= 1, JSON.stringify(kv));

// ============ T4: 感知 + 视觉模型 ============
log('== T4: 屏幕感知 ==');
const percepRes = await ev(`(async function(){
  const llm = window.liveRefs.llm;
  const perception = window.liveRefs.perception;
  const cfg = llm.getConfig();
  return {
    visionModel: cfg.visionModel || null,
    percepEnabled: perception.getStatus().enabled,
  };
})()`);
const pv = percepRes.v || {};
check('T4: visionModel 已配置（glm-4v-flash）', pv.visionModel === 'glm-4v-flash', 'visionModel=' + pv.visionModel);
check('T4: 感知默认开启', pv.percepEnabled === true, 'enabled=' + pv.percepEnabled);

// pet._proactiveWithCause 存在性（动因逻辑）
const causeRes = await ev(`typeof window.pet._proactiveWithCause === 'function'`);
check('T4: _proactiveWithCause 动因交流方法', causeRes.v === true);

// ============ 汇总 ============
const fails = results.filter(r => !r.ok).length;
console.log(`\n======== E2E 结果: ${results.length - fails} passed, ${fails} failed ============`);
const rel = consoleLogs.filter(l => /edge|Edge|knowledge|Knowledge|frozen|perception|vision|tts|TTS/i.test(l)).slice(-10);
if (rel.length) { console.log('--- 相关 console ---'); rel.forEach(l => console.log(l)); }
try { ws.close(); } catch { }
process.exit(fails ? 1 : 0);
