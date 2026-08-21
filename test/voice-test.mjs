// voice.js + pet.js voiceChat 自动化验证脚本（node 运行，stub speechSynthesis /
// SpeechRecognition / MediaRecorder / navigator.mediaDevices / localStorage / clock）
// 运行：node test/voice-test.mjs

// ---------- 测试基建 ----------
let pass = 0, fail = 0;
const assert = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.error('FAIL:', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stub localStorage
const makeStorage = () => {
  const kv = new Map();
  return {
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => kv.set(k, String(v)),
    removeItem: (k) => kv.delete(k),
    dump: () => Object.fromEntries(kv),
  };
};

// ---------- stub 浏览器全局 ----------
const g = globalThis;
g.window = g; // voice.js 经 window 访问 SpeechRecognition/MediaRecorder
// node 22 的 globalThis.navigator 是只读 getter，需 defineProperty 覆盖
const setNavigator = (value) => {
  try {
    Object.defineProperty(g, 'navigator', { value, configurable: true, writable: true });
  } catch { /* ignore */ }
};

// --- stub speechSynthesis ---
class FakeUtterance {
  constructor(text) { this.text = text; }
}
const synthState = {
  voices: [
    { name: 'Tingting', lang: 'zh-CN' },
    { name: 'Meijia', lang: 'zh-TW' },
    { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
    { name: 'Alex', lang: 'en-US' },
  ],
  spoken: [],
  cancelled: 0,
  autoEndMs: 15,
};
g.speechSynthesis = {
  getVoices: () => synthState.voices,
  cancel: () => { synthState.cancelled++; },
  speak: (u) => {
    synthState.spoken.push(u);
    setTimeout(() => u.onstart && u.onstart(), 0);
    setTimeout(() => u.onend && u.onend(), synthState.autoEndMs);
  },
};
g.SpeechSynthesisUtterance = FakeUtterance;

// --- stub webkitSpeechRecognition ---
class FakeRecognition {
  constructor() { FakeRecognition.instances.push(this); this.lang = ''; }
  start() { this.started = true; }
  stop() { if (!this._ended) { this._ended = true; this.onend && this.onend(); } }
  abort() { this._ended = true; this.onend && this.onend(); }
  emitResult(items) { // items: [[transcript, isFinal], ...]
    this.onresult({
      resultIndex: 0,
      results: items.map(([t, isFinal]) => ({ isFinal, 0: { transcript: t }, length: 1 })),
    });
  }
  emitError(code) { this.onerror && this.onerror({ error: code }); }
}
FakeRecognition.instances = [];

const { default: VoiceService, VOICE_CONFIG_KEY, DEFAULT_VOICE_CONFIG } = await import('../src/core/voice.js');

// ============================================================
// 1. 配置读写
// ============================================================
{
  const storage = makeStorage();
  const v = new VoiceService({ storage });
  const cfg = v.getConfig();
  assert('默认配置: tts开/语速1.0/asr开', cfg.ttsEnabled === true && cfg.ttsRate === 1.0 && cfg.asrEnabled === true);
  v.setConfig({ ttsRate: 1.2, voiceName: 'Tingting', ttsEnabled: false });
  const saved = JSON.parse(storage.getItem(VOICE_CONFIG_KEY));
  assert('setConfig 持久化合并', saved.ttsRate === 1.2 && saved.voiceName === 'Tingting' && saved.ttsEnabled === false);
  assert('setConfig 不覆盖未传字段', saved.asrEnabled === true);
  // 重新实例例化读取持久化配置
  const v2 = new VoiceService({ storage });
  assert('重启加载持久化配置', v2.getConfig().ttsEnabled === false && v2.getConfig().ttsRate === 1.2);
  // 边界：语速越界截断
  v2.setConfig({ ttsRate: 99 });
  assert('语速越界截断到2', v2.getConfig().ttsRate === 2);
}

// ============================================================
// 2. TTS：音色挑选 / 打断 / 分句 / 停止
// ============================================================
{
  const v = new VoiceService({ storage: makeStorage() });
  assert('isTTSAvailable', v.isTTSAvailable() === true);
  const zh = v.getChineseVoices();
  assert('getChineseVoices 过滤中文音色', zh.length === 3 && !zh.some((x) => x.lang === 'en-US'));

  // 音色挑选：优先 zh-CN 女声（Tingting）
  const picked = v._pickVoice('');
  assert('_pickVoice 自动挑选zh-CN女声', picked && picked.name === 'Tingting', JSON.stringify(picked));
  const named = v._pickVoice('Google 普通话（中国大陆）');
  assert('_pickVoice 指定名称优先', named && named.name === 'Google 普通话（中国大陆）');
  const fallback = v._pickVoice('不存在的音色');
  assert('_pickVoice 未知名称回退女声', fallback && fallback.name === 'Tingting');

  // speak：cancel 打断上一段 + promise resolve
  synthState.cancelled = 0;
  synthState.spoken.length = 0;
  let onStart = 0, onEnd = 0;
  const r = await v.speak('你好呀主人', { onStart: () => onStart++, onEnd: () => onEnd++ });
  assert('speak 完整播报 resolve(true)', r === true);
  assert('speak 触发 onStart/onEnd', onStart === 1 && onEnd === 1);
  assert('speak 前 cancel 打断上一段', synthState.cancelled >= 1);
  assert('speak 选中中文女声', synthState.spoken[0].voice.name === 'Tingting');
  assert('utterance lang 跟随音色', synthState.spoken[0].lang === 'zh-CN');

  // 长文本分句：多个 utterance 排队
  synthState.spoken.length = 0;
  const long = '第一句话。' + '这是第二句比较长的话，'.repeat(20) + '最后一句！';
  const r2 = await v.speak(long);
  assert('长文本分句排队播完', r2 === true && synthState.spoken.length > 1);
  assert('分句保留全部文本', synthState.spoken.map((u) => u.text).join('') === long.replace(/\s+/g, '').replace(/\s/g, ''));

  // ttsEnabled=false → 不播报直接 resolve(false)
  v.setConfig({ ttsEnabled: false });
  synthState.spoken.length = 0;
  const r3 = await v.speak('不应该播');
  assert('TTS关闭时不播报', r3 === false && synthState.spoken.length === 0);
  v.setConfig({ ttsEnabled: true });

  // stopSpeak 中断
  synthState.autoEndMs = 100; // 拉长播报时间
  const p = v.speak('这段话很长会被打断' + '，继续说'.repeat(50));
  await sleep(10);
  v.stopSpeak();
  const r4 = await p;
  assert('stopSpeak 中断播报 resolve(false)', r4 === false);
  synthState.autoEndMs = 15;
}

// TTS 不可用环境（无 speechSynthesis）
{
  const savedSynth = g.speechSynthesis;
  delete g.speechSynthesis;
  const v = new VoiceService({ storage: makeStorage() });
  assert('无 speechSynthesis → isTTSAvailable=false', v.isTTSAvailable() === false);
  let onEnd = 0;
  const r = await v.speak('测试', { onEnd: () => onEnd++ });
  assert('TTS不可用 → speak 直接resolve(false)+onEnd', r === false && onEnd === 1);
  g.speechSynthesis = savedSynth;
}

// ============================================================
// 3. ASR：模式探测 / partial/final / 错误映射 / 停止
// ============================================================
{
  g.webkitSpeechRecognition = FakeRecognition;
  FakeRecognition.instances.length = 0;
  const v = new VoiceService({ storage: makeStorage() });
  assert('有Recognition类 → recognition模式', v.getASRMode() === 'recognition' && v.isASRAvailable() === true);

  const events = { partial: [], final: [], errors: [] };
  const ok = v.startListen({
    onPartial: (t) => events.partial.push(t),
    onFinal: (t) => events.final.push(t),
    onError: (m) => events.errors.push(m),
  });
  assert('startListen 启动成功', ok === true && v.getListening() === true);
  const rec = FakeRecognition.instances[FakeRecognition.instances.length - 1];
  assert('识别器配置 zh-CN + continuous + interim', rec.lang === 'zh-CN' && rec.continuous === true && rec.interimResults === true);

  rec.emitResult([['你好', false]]);
  assert('onPartial 实时中间结果', events.partial.length === 1 && events.partial[0] === '你好');
  rec.emitResult([['你好呀', true]]);
  assert('onFinal 完整语句', events.final.length === 1 && events.final[0] === '你好呀');

  v.stopListen();
  assert('stopListen 后状态复位', v.getListening() === false);

  // 错误映射：not-allowed → 友好提示 + 会话终止
  v.startListen({ onError: (m) => events.errors.push(m) });
  const rec2 = FakeRecognition.instances[FakeRecognition.instances.length - 1];
  rec2.emitError('not-allowed');
  assert('not-allowed → 麦克风权限提示', events.errors.some((m) => m.includes('麦克风权限')));
  assert('出错后 listening=false', v.getListening() === false);
  // no-speech 瞬时错误：忽略不打断会话
  v.startListen({ onError: (m) => events.errors.push(m) });
  const rec3 = FakeRecognition.instances[FakeRecognition.instances.length - 1];
  rec3.emitError('no-speech');
  assert('no-speech 瞬时错误不打断', v.getListening() === true && events.errors.length === 1);
  v.stopListen();
  delete g.webkitSpeechRecognition;
}

// 无 Recognition → recorder 模式探测
{
  delete g.SpeechRecognition;
  delete g.webkitSpeechRecognition;
  g.MediaRecorder = class { start() {} stop() {} };
  setNavigator({ mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
  const v = new VoiceService({ storage: makeStorage() });
  assert('无Recognition有mediaDevices → recorder模式', v.getASRMode() === 'recorder');
  // 全无 → none
  setNavigator({});
  const v2 = new VoiceService({ storage: makeStorage() });
  assert('能力全无 → none', v2.getASRMode() === 'none' && v2.isASRAvailable() === false);
}

// ============================================================
// 4. pet.js voiceChat 全流程（recognition 模式）
// ============================================================
{
  g.webkitSpeechRecognition = FakeRecognition;
  FakeRecognition.instances.length = 0;

  // stub 全套 pet 依赖
  const bus = { on() {}, off() {}, emit() {} };
  g.window.PetEvents = bus;
  const bubbles = [];
  const bubble = {
    showText: (t) => bubbles.push({ kind: 'text', t }),
    showHint: (t) => bubbles.push({ kind: 'hint', t }),
    streamAppend: (t) => bubbles.push({ kind: 'stream', t }),
    streamEnd: () => bubbles.push({ kind: 'streamEnd' }),
  };
  const lipCalls = [];
  const live2d = { playMotion: () => {}, lipSpeak: (d) => lipCalls.push(d) };
  const llm = {
    getConfig: () => ({ model: 'mock' }),
    async chatStream(_msgs, onChunk) { onChunk('你好主人'); return '你好主人'; },
  };
  const personality = {
    getSystemPrompt: () => 'sys',
    getTraits: () => ({}),
    applyEvent: () => {},
    async updateOwnerProfile() {},
  };
  const memory = { async add() {}, async getContext() { return []; } };

  // fake voice service（记录调用序列，行为可控）
  const calls = [];
  const fakeVoice = {
    isASRAvailable: () => true,
    getASRMode: () => 'recognition',
    startListen: (h) => { calls.push('listen'); fakeVoice._h = h; return true; },
    stopListen: () => { calls.push('stopListen'); fakeVoice._listening = false; },
    abortListen: () => { calls.push('abortListen'); },
    stopSpeak: () => { calls.push('stopSpeak'); },
    getListening: () => !!fakeVoice._listening,
    speak: (text, opts) => {
      calls.push('speak:' + text);
      fakeVoice._speaking = true;
      return new Promise((resolve) => {
        // onStart 稍后触发；播报 1250ms 后自然结束（口型续命 interval 周期 1200ms）
        setTimeout(() => opts.onStart?.(), 1);
        setTimeout(() => {
          fakeVoice._speaking = false;
          opts.onEnd?.();
          resolve(true);
        }, 1250);
      });
    },
  };

  const { default: PetController } = await import('../src/core/pet.js');
  const pet = new PetController(
    { llm, memory, personality, live2d, bubble, voice: fakeVoice },
    { characterId: 'handsome' },
  );
  await pet.init();

  // 4.1 无 voice 依赖时降级提示
  const petNoVoice = new PetController({ llm, memory, personality, live2d, bubble }, { characterId: 'handsome' });
  await petNoVoice.init();
  await petNoVoice.voiceChat();
  assert('无voice依赖 → 气泡提示不影响主流程', bubbles.some((b) => b.kind === 'hint' && b.t.includes('不支持语音')));

  // 4.2 voiceChat 启动 → listening
  await pet.voiceChat();
  assert('voiceChat → 开始听', calls[0] === 'listen' && pet.getState().voiceActive === true);
  assert('气泡显示在听提示', bubbles.some((b) => b.kind === 'hint' && b.t.includes('在听')));

  // 4.3 partial 实时显示
  fakeVoice._h.onPartial('今天天气');
  assert('onPartial → 气泡"你说：xxx"', bubbles.some((b) => b.kind === 'hint' && b.t === '你说：今天天气'));

  // 4.4 final → chat（LLM mock 流式）→ speak → 播完继续听
  const chatPromise = (async () => fakeVoice._h.onFinal('今天天气怎么样'))();
  await sleep(20); // 等 chat 完成进入 speak
  assert('final → 停止听(防回声)', calls.includes('stopListen'));
  assert('final → TTS 播报回复', calls.some((c) => c.startsWith('speak:')));
  assert('播报期间 speaking 标志', pet.getState().speaking === true);
  // 播报未结束时不应重启听（回声防护）
  assert('播报期间不重启ASR', !calls.slice(calls.indexOf('speak:你好主人') + 1).includes('listen'));
  await chatPromise; // 等播报自然结束（~1250ms）
  assert('播报结束 → 口型续命调用过', lipCalls.length > 0, 'lipCalls=' + lipCalls.length);
  assert('播报结束 → 继续听（循环对话）', calls.filter((c) => c === 'listen').length === 2);
  assert('播报结束 → speaking 复位', pet.getState().speaking === false);

  // 4.5 再次点击 → 结束会话
  await pet.voiceChat();
  assert('再次voiceChat → 停止语音会话', pet.getState().voiceActive === false && calls.includes('abortListen') && calls.includes('stopSpeak'));

  // 4.6 ASR 出错 → 友好提示 + 会话终止（文字聊天不受影响）
  const errs = [];
  fakeVoice.startListen = (h) => { fakeVoice._h = h; return true; };
  calls.length = 0;
  await pet.voiceChat();
  fakeVoice._h.onError('麦克风权限被拒绝');
  assert('onError → 会话终止', pet.getState().voiceActive === false);
  await pet.chat('文字聊天还能用');
  assert('语音出错后文字聊天不受影响', bubbles.some((b) => b.kind === 'stream' && b.t === '你好主人'));

  pet.destroy();
  petNoVoice.destroy();
  delete g.window.PetEvents;
  delete g.webkitSpeechRecognition;
}

// ============================================================
// 5. pet.js 按住说话（recorder 降级模式）
// ============================================================
{
  g.MediaRecorder = class {
    start() {}
    stop() {}
  };
  setNavigator({ mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });

  const bubbles2 = [];
  const bubble = {
    showText: (t) => bubbles2.push({ kind: 'text', t }),
    showHint: (t) => bubbles2.push({ kind: 'hint', t }),
    streamAppend: () => {},
    streamEnd: () => {},
  };
  const llm = {
    getConfig: () => ({ model: 'mock' }),
    async chatStream(_m, onChunk) { onChunk('回复内容'); return '回复内容'; },
  };
  const personality = {
    getSystemPrompt: () => 'sys', getTraits: () => ({}),
    applyEvent: () => {}, async updateOwnerProfile() {},
  };
  const memory = { async add() {}, async getContext() { return []; } };
  const live2d = { playMotion: () => {}, lipSpeak: () => {} };

  const storage = makeStorage();
  const v = new VoiceService({ storage });
  assert('降级模式探测 recorder', v.getASRMode() === 'recorder');

  const { default: PetController } = await import('../src/core/pet.js');
  const pet = new PetController(
    { llm, memory, personality, live2d, bubble, voice: v },
    { characterId: 'handsome' },
  );
  await pet.init();

  // 按住 → 录音启动
  await pet.voiceHoldStart();
  assert('voiceHoldStart → 录音中会话激活', pet.getState().voiceActive === true);
  // 未配置转写服务 → 松开后友好降级（不崩溃）
  await pet.voiceHoldEnd();
  assert('无转写服务 → 松开友好提示终止会话', pet.getState().voiceActive === false
    && bubbles2.some((b) => b.kind === 'hint'));
  pet.destroy();
}

// ============================================================
// 6. digitalhuman.js 抽象层（配置读取 + 接口预留）
// ============================================================
{
  const { default: DigitalHumanEngine, DH_CONFIG_KEY, DEFAULT_DH_CONFIG } = await import('../src/core/digitalhuman.js');
  const storage = makeStorage();
  assert('DH默认配置 off', DigitalHumanEngine.loadConfig(storage).mode === 'off');
  storage.setItem(DH_CONFIG_KEY, JSON.stringify({ mode: 'local', endpoint: 'http://127.0.0.1:8000' }));
  const cfg = DigitalHumanEngine.loadConfig(storage);
  assert('DH配置读取 local+endpoint', cfg.mode === 'local' && cfg.endpoint === 'http://127.0.0.1:8000');
  const eng = new DigitalHumanEngine({ storage });
  let threw1 = false, threw2 = false;
  try { await eng.connect(); } catch { threw1 = true; }
  try { await eng.speak('hi'); } catch { threw2 = true; }
  assert('connect/speak 未实现抛错（预留接口）', threw1 && threw2);
  let frame = null;
  eng.onFrame((f) => { frame = f; });
  eng._emitFrame({ timestamp: 1 });
  assert('onFrame 回调生效', frame && frame.timestamp === 1);
  await eng.disconnect();
  assert('disconnect 释放', eng.connected === false);
  assert('默认配置导出', DEFAULT_DH_CONFIG.mode === 'off');
}

// ---------- 汇总 ----------
console.log('\n========================================');
console.log(`voice-test 结果: ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
