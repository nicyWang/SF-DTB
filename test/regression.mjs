// regression.mjs — 一键回归套件（语音/豆包/UI 分组，按需跑）
// 用法：node test/regression.mjs [voice|doubao|ui|all]
import { cdp } from './cdp-helper.mjs';

const group = process.argv[2] || 'all';

// ---------- 语音组（VAD 链路 + 播报） ----------
async function voice(d) {
  console.log('== 语音（VAD 兜底链路）==');
  await d.ev("localStorage.removeItem('pet-doubao-realtime-config')");
  await d.startVoice();
  const s = await d.voiceState();
  d.check('VAD会话启动', s.v?.vad === true, JSON.stringify(s.v));
  await d.stopVoice();
  const s2 = await d.voiceState();
  d.check('会话停止', s2.v?.vad === false && s2.v?.active === false);
}

// ---------- 豆包组（实时语音） ----------
async function doubao(d) {
  console.log('== 豆包实时语音 ==');
  await d.ev("localStorage.setItem('pet-doubao-realtime-config', JSON.stringify({ appId: '7889599946', accessToken: '8DkN3mLYq0bMx51bWcMSPD2za3pBvmNz', botName: '毛毛', systemRole: '你是桌面小球宠物毛毛，甜美粘人', voice: 'zh_female_xiaohe_jupiter_bigtts' }))");
  await d.startVoice();
  await d.sleep(4000);
  const s = await d.voiceState();
  d.check('豆包会话建立', s.v?.doubao === true, JSON.stringify(s.v));
  d.check('麦克风推流', (await d.ev('!!window.liveRefs.doubao._micStream')).v === true);
  await d.stopVoice();
  await d.ev("(async()=>{ try{ await window.doubaoAPI.stop(); }catch(e){} return 'ok'; })()");
}

// ---------- UI 组 ----------
async function ui(d) {
  console.log('== UI ==');
  const dock = await d.ev("(function(){ const m = document.getElementById('mic-btn'); const r = m.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), pinned: typeof window.__uiPinned === 'function' }; })()");
  d.check('mic按钮40px+穿透钩子', dock.v?.w === 40 && dock.v?.pinned === true, JSON.stringify(dock.v));
  const focus = await d.ev("(function(){ const i = document.getElementById('chat-input'); const b = document.getElementById('chat-bar'); b.style.display='flex'; i.focus(); const f1 = document.activeElement === i; i.blur(); i.focus(); const f2 = document.activeElement === i; b.style.display='none'; return f1 && f2; })()");
  d.check('输入条失焦后可再聚焦', focus.v === true);
  const frozen = await d.ev("(async function(){ const b = window.liveRefs.sprite; const x0 = b._root.x; b.setFrozen(true); await new Promise(r=>setTimeout(r,900)); const dx = Math.abs(b._root.x - x0); b.setFrozen(false); return dx < 3; })()");
  d.check('说话冻结静止', frozen.v === true);
}

const d = await cdp();
try {
  if (group === 'voice' || group === 'all') await voice(d);
  if (group === 'doubao' || group === 'all') { await d.sleep(1200); await doubao(d); } // 组间等待：麦克风/连接释放
  if (group === 'ui' || group === 'all') await ui(d);
  d.summary();
} catch (e) {
  console.error('ERROR:', e.message);
  process.exit(1);
}
