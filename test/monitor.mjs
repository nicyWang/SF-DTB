// 实时监听面板：用户说话 → 全链路每一环打点。用法：node test/monitor.mjs（Ctrl+C 退出）
import { cdp } from './cdp-helper.mjs';
import readline from 'node:readline';

const d = await cdp();
console.log('════════ 语音全链路监听面板 ════════');
console.log('确保小球语音已开启（点麦克风），然后正常说话。');
console.log('每环状态会实时打出，Ctrl+C 退出\n');

// 环节1：VAD 帧级监控（RMS + 阈值 + 状态机）——注入页面
await d.ev(`(function(){
  window.__mon = { rms: [], events: [], pipes: 0 };
  const v = window.pet.voice;
  if (!v || !v._vadActive) { console.log('[MON] VAD 未激活！先点麦克风开语音'); }
  // 每 500ms 快照 VAD 内部状态
  window.__monTimer = setInterval(() => {
    const vv = window.pet.voice;
    window.__mon.snap = {
      t: new Date().toLocaleTimeString(),
      vad: !!vv._vadActive,
      gen: vv._vadGen,
      cal: !!vv._vadCalibrating,
      speech: !!vv._vadSpeechStarted,
      chunks: vv._vadSpeechChunks.length,
      silentChunks: vv._vadSilentChunks.length,
      paused: !!vv._vadPaused,
      outloud: !!vv._ttsPlayingOutloud,
      ctx: vv._vadCtx?.state,
      rec: vv._vadRecorder?.state,
      toolRouting: !!window.pet._toolRouting,
      chatting: !!window.pet._chatting,
    };
  }, 500);
})()`);

// console 日志实时打印（关键事件）
const KEY = /self-pipe|你说|transcribing|转写|VAD|自适应|DO|tools|豆包TTS|在听|没听清/i;
const seen = new Set();
let lastSnap = null;

setInterval(() => {
  // 打关键日志
  d.logs.forEach((l, i) => {
    if (seen.has(i)) return;
    if (KEY.test(l)) {
      seen.add(i);
      console.log('[日志] ' + l.slice(0, 110));
    }
  });
  // 状态快照变化打印
  void lastSnap;
}, 800);

// 周期性输出状态行
setInterval(async () => {
  const r = await d.ev('(function(){ return window.__mon ? window.__mon.snap : null; })()').catch(() => null);
  if (r && r.v) {
    const s = r.v;
    const line = [s.t,
      'VAD:' + (s.vad ? '开' : '关'),
      '引擎:' + s.ctx,
      '录音:' + s.rec,
      s.cal ? '【校准中】' : '',
      s.speech ? '【听到说话】chunks:' + s.chunks : '静音',
      s.paused ? '【暂停】' : '',
      s.outloud ? '【她播报中】' : '',
      s.toolRouting ? '【工具执行中】' : '',
      s.chatting ? '【GLM思考】' : '',
    ].filter(Boolean).join(' | ');
    console.log(line);
  }
}, 2000);

// 持续运行
await new Promise(() => {});
