// cdp-helper.js — CDP 调试通用库（沉淀，别再写一次性脚本）
// 用法：
//   import { cdp } from './cdp-helper.mjs';
//   const d = await cdp();                    // 连接当前运行的小球
//   const r = await d.ev('window.pet._voiceActive');  // 求值（带超时）
//   await d.click('#mic-btn');                // 真实点击元素
//   d.check('VAD已启动', v.vad === true);     // 断言+计数
//   d.summary();                              // 输出结果
import WebSocket from 'ws';
import http from 'node:http';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function cdp(port = 9240) {
  const pages = await new Promise((res, rej) =>
    http.get(`http://127.0.0.1:${port}/json`, (r) => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej));
  const page = pages.find(p => p.type === 'page' && p.url.includes('index'));
  if (!page) throw new Error('未找到小球页面（Electron 起了吗？）');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise(r => ws.on('open', r));
  let id = 0; const pend = new Map();
  const logs = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled') {
      const t = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      logs.push(`[${m.params.type}] ${String(t).slice(0, 160)}`);
    }
  });
  const send = (method, params = {}) => new Promise(res => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');

  // evaluate：页面求值（Node 侧超时兜底，页面挂起也不阻塞）
  const ev = async (expr, ms = 20000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      new Promise(r2 => setTimeout(() => r2({ timeout: true }), ms)),
    ]);
    if (r.timeout) return { timeout: true };
    return { v: r.result?.result?.value, err: r.result?.exceptionDetails?.exception?.description };
  };
  // 等待条件成立（轮询）：waitFor('window.pet._voiceActive === true', 10000)
  const waitFor = async (condExpr, ms = 10000, step = 500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await ev(`!!(${condExpr})`, 5000);
      if (r.v === true) return true;
      await sleep(step);
    }
    return false;
  };

  // 断言计数
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    if (ok) { pass++; console.log('PASS: ' + name); }
    else { fail++; console.log('FAIL: ' + name + (detail ? ' (' + detail + ')' : '')); }
  };
  const summary = (exit = true) => {
    console.log(`\n===== ${pass} passed, ${fail} failed =====`);
    if (fail && exit) process.exit(1);
    if (exit) process.exit(0);
  };

  return {
    ws, ev, waitFor, sleep, check, summary, logs,
    // 常用快捷方式
    async startVoice() { await ev("window.pet.voiceChat().then(() => 'ok')"); },
    async stopVoice() { await ev("window.pet.stopVoiceChat(); 'ok'"); },
    async restartApp() { await ev("location.reload(); 'ok')").catch(() => {}); await sleep(6000); },
    voiceState: () => ev("(function(){ const d = window.liveRefs?.doubao; return { doubao: !!d?.active, vad: !!window.pet?.voice?.getVoiceLoopActive?.(), active: !!window.pet?._voiceActive, phase: document.getElementById('mic-btn')?.dataset.phase }; })()"),
    close() { try { ws.close(); } catch { /* ignore */ } },
  };
}
