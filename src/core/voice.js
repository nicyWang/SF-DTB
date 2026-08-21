// ============================================================
// voice.js — 语音服务：TTS 播报 + ASR 语音识别（数字人语音对话）
//
// TTS：Web Speech API speechSynthesis（Electron/Chromium 原生支持）
//   - 中文音色自动挑选（zh-CN 优先女声）；voices 异步加载（onvoiceschanged）
//   - 长文本自动分句排队（规避 Chromium 长语音 ~15s 被截断的已知问题）
//   - speak 前 cancel 打断上一段
//
// ASR：优先 Web Speech API SpeechRecognition（Chromium 支持，Electron
//   多数版本未编译该 API → 运行时探测）；不可用时降级为
//   getUserMedia + MediaRecorder 录音 + 智谱 GLM-ASR 转写（与 LLM 同 key）。
//   录音模式下支持 VAD 持续听：检测到说话自动分段，静音约1秒自动断句送转写。
//
// TTS：优先智谱 GLM-TTS（/audio/speech，与 LLM 同 key，音色 tongtong 等）；
//   未配置/失败时降级 Web Speech API speechSynthesis。
//
// 配置：localStorage 'pet-voice-config'
//   { ttsEnabled, ttsRate, voiceName, asrEnabled }
//
// Node 可测性：所有浏览器 API 均在调用时惰性探测（typeof 守卫），
// storage 可注入，test/voice-test.mjs stub 后可直接 node 运行。
// ============================================================

const VOICE_CONFIG_KEY = 'pet-voice-config';
const LLM_CONFIG_KEY = 'pet-llm-config';

const DEFAULT_VOICE_CONFIG = {
  ttsEnabled: true,   // TTS 播报开关
  ttsRate: 1.0,       // 语速 0.8~1.2
  voiceName: '',      // 指定音色名（空=自动挑选中文女声）
  asrEnabled: true,   // 语音识别开关
};

// 已知中文女声音色名（自动挑选优先命中）
const FEMALE_VOICE_RE = /tingting|meijia|sinji|yating|xiaoxiao|xiaoyi|yaoyao|huihui|yunyang.*female|female|女/i;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

const readJSON = (storage, key, fallback) => {
  try {
    const raw = storage && storage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
};

/** ASR 错误码 → 用户友好提示 */
const asrErrorMessage = (code) => {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限被拒绝，请在系统设置中允许';
    case 'audio-capture':
      return '麦克风不可用（未检测到录音设备）';
    case 'network':
      return '语音服务网络异常';
    default:
      return '语音识别出错（' + (code || 'unknown') + '）';
  }
};

class VoiceService {
  /**
   * @param {object} [opts]
   *   opts.storage: 持久化对象（默认 localStorage，测试可注入）
   */
  constructor(opts = {}) {
    this.storage = opts.storage
      || (typeof localStorage !== 'undefined' ? localStorage : null);
    this._config = readJSON(this.storage, VOICE_CONFIG_KEY, DEFAULT_VOICE_CONFIG);

    // TTS 状态
    this._voices = [];
    this._speaking = false;
    this._speakAbort = false;

    // ASR 状态
    this._listening = false;
    this._manualStop = false;
    this._recognition = null;
    this._asrHandlers = null;

    // 录音降级状态
    this._recorder = null;
    this._recChunks = [];
    this._mediaStream = null;

    this._loadVoices();
  }

  // ---------- 配置 ----------

  getConfig() { return { ...this._config }; }

  /** 合并更新配置并持久化 */
  setConfig(patch = {}) {
    this._config = {
      ...this._config,
      ttsEnabled: typeof patch.ttsEnabled === 'boolean' ? patch.ttsEnabled : this._config.ttsEnabled,
      ttsRate: patch.ttsRate !== undefined ? clamp(patch.ttsRate, 0.5, 2) : this._config.ttsRate,
      voiceName: patch.voiceName !== undefined ? String(patch.voiceName) : this._config.voiceName,
      asrEnabled: typeof patch.asrEnabled === 'boolean' ? patch.asrEnabled : this._config.asrEnabled,
    };
    try {
      this.storage?.setItem(VOICE_CONFIG_KEY, JSON.stringify(this._config));
    } catch { /* ignore */ }
    return this.getConfig();
  }

  // ---------- 能力探测 ----------

  _synth() {
    return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  }

  _win() {
    return typeof window !== 'undefined' ? window : globalThis;
  }

  _recognitionClass() {
    const w = this._win();
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }

  isTTSAvailable() { return !!this._synth(); }

  /** ASR 工作模式：'recognition'=实时识别 | 'recorder'=按住说话+云端转写 | 'none'=不可用 */
  getASRMode() {
    // _srFatal（含持久化标记）：SpeechRecognition 曾失效（Electron 缺 Google key：
    // network error 或 6s 探针无结果）→ 直接走 recorder（VAD+云端转写），
    // 不再浪费"先试 SR 再降级"的 6 秒黑窗（用户前几秒的话会被吃掉）
    if (!this._srFatal && !this._srFatalStored() && this._recognitionClass()) return 'recognition';
    const w = this._win();
    const hasMedia = typeof navigator !== 'undefined' && navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (hasMedia && typeof w.MediaRecorder !== 'undefined') return 'recorder';
    return 'none';
  }

  /** SR 失效持久化（跨重启记住：这台机器的 SR 不可用，直接 VAD） */
  _srFatalStored() {
    try { return this.storage?.getItem?.('pet-sr-fatal') === '1'; } catch { return false; }
  }

  _markSrFatal() {
    this._srFatal = true;
    try { this.storage?.setItem?.('pet-sr-fatal', '1'); } catch { /* ignore */ }
  }

  isASRAvailable() { return this.getASRMode() !== 'none'; }

  // ---------- TTS ----------

  /** 当前可用的中文音色（设置面板下拉用） */
  getChineseVoices() {
    return this._voices
      .filter((v) => /^zh/i.test(v.lang || ''))
      .map((v) => ({ name: v.name, lang: v.lang }));
  }

  _loadVoices() {
    const synth = this._synth();
    if (!synth) return;
    const update = () => { this._voices = synth.getVoices() || []; };
    update(); // 部分环境同步已就绪
    // voices 异步加载：onvoiceschanged 就绪后刷新缓存（单实例独占该回调）
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', update);
    } else if ('onvoiceschanged' in synth) {
      synth.onvoiceschanged = update;
    }
  }

  /** 音色挑选：指定名 → zh-CN 女声 → 任一 zh 音色 → null */
  _pickVoice(preferredName) {
    const voices = this._voices;
    if (!voices.length) return null;
    if (preferredName) {
      const hit = voices.find((v) => v.name === preferredName);
      if (hit) return hit;
    }
    const zh = voices.filter((v) => /^zh/i.test(v.lang || ''));
    if (!zh.length) return null;
    const cn = zh.filter((v) => /^zh[-_]CN/i.test(v.lang || ''));
    const pool = cn.length ? cn : zh;
    return pool.find((v) => FEMALE_VOICE_RE.test(v.name || '')) || pool[0];
  }

  /**
   * 长文本分句（≤max 字符，优先在标点断开），规避 Chromium 长语音截断
   */
  _chunkText(text, max = 90) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    const sentences = clean.split(/(?<=[。！？!?；;\n])/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const s of sentences) {
      if (s.length <= max) { out.push(s); continue; }
      // 超长无标点句：按逗号再切，仍超长则硬切
      let pieces = s.split(/(?<=[，,、：:])/);
      if (pieces.length === 1) {
        for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
        continue;
      }
      let buf = '';
      for (const p of pieces) {
        if ((buf + p).length > max && buf) { out.push(buf); buf = p; }
        else buf += p;
      }
      if (buf) out.push(buf);
    }
    return out.length ? out : [clean.slice(0, max)];
  }

  _makeUtterance(text, opts) {
    const w = this._win();
    const U = w.SpeechSynthesisUtterance;
    const u = new U(text);
    const voice = this._pickVoice(opts.voiceName || this._config.voiceName);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = 'zh-CN';
    }
    u.rate = clamp(opts.rate !== undefined ? opts.rate : this._config.ttsRate, 0.5, 2);
    if (typeof opts.pitch === 'number') u.pitch = clamp(opts.pitch, 0, 2);
    return u;
  }

  /**
   * TTS 播报（打断上一段）
   * @param {string} text
   * @param {object} [opts] {rate, pitch, voiceName, onStart, onEnd}
   * @returns {Promise<boolean>} 是否完整播完（false=被中断/失败/关闭）
   */
  speak(text, opts = {}) {
    const synth = this._synth();
    const chunks = (synth && this._config.ttsEnabled) ? this._chunkText(text) : [];
    if (!synth || !chunks.length) {
      opts.onEnd?.();
      return Promise.resolve(false);
    }
    try { synth.cancel(); } catch { /* ignore */ }
    this._speakAbort = false;
    this._speaking = true;

    return new Promise((resolve) => {
      let idx = 0;
      let started = false;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        this._speaking = false;
        opts.onEnd?.();
        resolve(ok);
      };
      const next = () => {
        if (done) return;
        if (this._speakAbort) return finish(false);
        if (idx >= chunks.length) return finish(true);
        const u = this._makeUtterance(chunks[idx++], opts);
        u.onstart = () => {
          if (!started) { started = true; opts.onStart?.(); }
        };
        u.onend = next;
        u.onerror = () => finish(false);
        try { synth.speak(u); } catch { finish(false); }
      };
      next();
      // 兜底：部分实现不触发 onstart（500ms 后补发，保证口型续命启动）
      setTimeout(() => {
        if (!started && !done) { started = true; opts.onStart?.(); }
      }, 500);
    });
  }

  /** 停止播报 */
  stopSpeak() {
    this._speakAbort = true;
    this._speaking = false;
    try { this._synth()?.cancel(); } catch { /* ignore */ }
  }

  getSpeaking() { return this._speaking; }

  // ---------- ASR（实时识别模式） ----------

  /**
   * 开始持续听（SpeechRecognition，zh-CN，continuous + interimResults）
   * @param {object} [handlers] {onPartial, onFinal, onError}
   * @returns {boolean} 是否成功启动
   */
  startListen(handlers = {}) {
    const Rec = this._recognitionClass();
    if (!Rec) {
      handlers.onError?.(asrErrorMessage('unsupported'));
      return false;
    }
    if (this._listening) return true;
    if (!this._config.asrEnabled) {
      handlers.onError?.('语音识别已在设置中关闭');
      return false;
    }
    this.stopListen();
    this._manualStop = false;
    this._asrHandlers = handlers;

    const rec = new Rec();
    rec.lang = 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      this._srGotEvent = true; // 活性信号：SR 真的在工作
      let interim = '';
      let final = '';
      const results = e.results || [];
      for (let i = e.resultIndex || 0; i < results.length; i++) {
        const r = results[i];
        if (!r || !r[0]) continue;
        const t = r[0].transcript || '';
        if (r.isFinal) final += t;
        else interim += t;
      }
      const h = this._asrHandlers;
      if (!h) return;
      const f = final.trim();
      if (f) h.onFinal?.(f);
      else if (interim.trim()) h.onPartial?.(interim.trim());
    };

    rec.onerror = (e) => {
      const code = e && e.error;
      // no-speech / aborted 属瞬时状态：continuous 模式下忽略，等 onend 重启
      if (code === 'no-speech' || code === 'aborted') return;
      // network / service-not-allowed：Electron 无 Google API key 的典型表现，
      // SR 实际不可用 → 标记致命，本次会话自动降级 recorder（VAD+云端转写）
      if (code === 'network' || code === 'service-not-allowed') this._markSrFatal();
      this._listening = false;
      this._asrHandlers?.onError?.(asrErrorMessage(code));
      this._asrHandlers = null;
    };

    rec.onstart = () => { /* 注意：onstart 不算活性信号——Electron 里 SR
      会正常触发 onstart 但之后永远不出结果（缺 Google key），只有 onresult 才是真活性 */ };

    rec.onend = () => {
      this._recognition = null;
      if (this._listening && !this._manualStop) {
        // continuous 模式被系统自动截断 → 短暂延迟后重启
        setTimeout(() => {
          if (this._listening && !this._manualStop && this._asrHandlers) {
            const h = this._asrHandlers;
            this.startListen(h);
          }
        }, 250);
      } else {
        this._listening = false;
      }
    };

    try {
      rec.start();
      this._recognition = rec;
      this._listening = true;
      // 活性探针：6s 内无任何事件（result/start/error）→ SR 静默失效
      // （Electron 常态：不报错但永远不出结果）→ 标记致命降级 VAD
      if (this._srProbeTimer) clearTimeout(this._srProbeTimer);
      this._srGotEvent = false;
      this._srProbeTimer = setTimeout(() => {
        this._srProbeTimer = null;
        if (this._listening && !this._srGotEvent) {
          console.warn('[VoiceService] SR 6s 无活性事件，判定静默失效 → 降级 VAD');
          this._markSrFatal();
          this._listening = false;
          try { rec.stop(); } catch { /* ignore */ }
          const h = this._asrHandlers;
          this._asrHandlers = null;
          h?.onError?.('实时识别无响应'); // → pet._onVoiceError → getASRMode 已是 recorder → 转 VAD
        }
      }, 6000);
      return true;
    } catch (err) {
      this._listening = false;
      handlers.onError?.(asrErrorMessage('start-failed'));
      return false;
    }
  }

  /** 停止听 */
  stopListen() {
    this._manualStop = true;
    this._listening = false;
    if (this._srProbeTimer) { clearTimeout(this._srProbeTimer); this._srProbeTimer = null; }
    const rec = this._recognition;
    this._recognition = null;
    if (rec) {
      try { rec.stop(); } catch { /* ignore */ }
    }
    // 不清 _asrHandlers：onend 重启守卫用它判断会话仍在
  }

  /** 放弃当前会话（stopListen + 清理 handler，阻止 onend 重启） */
  abortListen() {
    this.stopListen();
    this._asrHandlers = null;
  }

  getListening() { return this._listening; }

  // ---------- ASR 降级（录音 + 云端转写） ----------

  /**
   * 开始录音（降级模式）
   * @param {object} [handlers] {onError}
   * @returns {Promise<boolean>}
   */
  async startRecording(handlers = {}) {
    if (this._recorder) return true;
    if (!this._config.asrEnabled) {
      handlers.onError?.('语音识别已在设置中关闭');
      return false;
    }
    const w = this._win();
    const hasMedia = typeof navigator !== 'undefined' && navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (!hasMedia || typeof w.MediaRecorder === 'undefined') {
      handlers.onError?.('当前环境不支持录音');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true, // 消回声：TTS 播报时避免自听自说
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this._mediaStream = stream;
      this._recChunks = [];
      const rec = new w.MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) this._recChunks.push(e.data);
      };
      rec.start();
      this._recorder = rec;
      return true;
    } catch (err) {
      const name = err && err.name;
      handlers.onError?.(name === 'NotAllowedError'
        ? asrErrorMessage('not-allowed')
        : name === 'NotFoundError' ? asrErrorMessage('audio-capture') : '录音启动失败');
      return false;
    }
  }

  /** 结束录音，返回音频 Blob（无数据返回 null） */
  async stopRecording() {
    const rec = this._recorder;
    if (!rec) return null;
    this._recorder = null;
    const chunks = this._recChunks;
    this._recChunks = [];
    const blob = await new Promise((resolve) => {
      let settled = false;
      const finish = (b) => { if (!settled) { settled = true; resolve(b); } };
      rec.onstop = () => finish(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      try { rec.stop(); } catch { finish(null); }
      setTimeout(() => finish(chunks.length ? new Blob(chunks, { type: 'audio/webm' }) : null), 2000);
    });
    try {
      this._mediaStream?.getTracks?.().forEach((t) => t.stop());
    } catch { /* ignore */ }
    this._mediaStream = null;
    return blob && blob.size > 0 ? blob : null;
  }

  /**
   * 云端转写（智谱 GLM-ASR，与 LLM 同 key；OpenAI 兼容端点亦可）
   * @param {Blob} blob
   * @returns {Promise<string>} 识别文本（失败抛错）
   */
  async transcribe(blob) {
    // ASR 配置解析：独立配置（pet-asr-config）> 跟随 LLM（兼容旧版）
    // provider=volc → 火山大模型极速版（独立协议）；其余走 OpenAI 兼容 /audio/transcriptions
    const asrCfg0 = readJSON(this.storage, 'pet-asr-config', {});
    const llmCfg0 = readJSON(this.storage, LLM_CONFIG_KEY, {});
    // 火山直连模式：显式 provider=volc，或（appId+accessToken 且无 baseURL）
    const volcDirect = asrCfg0.provider === 'volc'
      || (asrCfg0.appId && asrCfg0.accessToken && !asrCfg0.baseURL);
    if (volcDirect) {
      const dbCfg = readJSON(this.storage, 'pet-doubao-realtime-config', {});
      const appId = asrCfg0.appId || dbCfg.appId;
      const accessToken = asrCfg0.accessToken || dbCfg.accessToken;
      if (appId && accessToken) return await this._transcribeVolc(blob, appId, accessToken);
    }
    const cfg = (asrCfg0.baseURL && asrCfg0.apiKey) ? asrCfg0 : llmCfg0;
    const base = String(cfg.baseURL || '').replace(/\/+$/, '');
    if (!base || !cfg.apiKey) throw new Error('未配置 LLM 服务（转写需要智谱 API Key）');

    // 智谱 ASR 仅收 wav/mp3 → webm/opus 需解码重编码为 16k mono wav
    let payload = blob;
    let filename = 'speech.webm';
    try {
      const wav = await this._encodeWav(blob);
      if (wav) { payload = new Blob([wav], { type: 'audio/wav' }); filename = 'speech.wav'; }
    } catch (e) {
      console.warn('[VoiceService] WAV 重编码失败，按原始格式上传:', e);
    }

    const model = asrCfg0.model || cfg.sttModel || 'glm-asr-2512';
    const fd = new FormData();
    fd.append('file', payload, filename);
    fd.append('model', model);
    fd.append('stream', 'false');
    const res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.apiKey },
      body: fd,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      let hint = '';
      try { hint = JSON.parse(errBody)?.error?.message || ''; } catch { /* ignore */ }
      throw new Error(`转写服务 HTTP ${res.status}${hint ? ': ' + hint.slice(0, 100) : ''}`);
    }
    const data = await res.json().catch(() => ({}));
    return String(data.text || '').trim();
  }

  /**
   * 火山大模型录音极速版转写（api/v3/auc/bigmodel/recognize/flash）
   * 协议：base64(wav) JSON → 一次请求返回文本；鉴权 X-Api-App-Key/Access-Key（复用豆包实时语音凭证）
   */
  async _transcribeVolc(blob, appId, accessToken) {
    // 统一转 16k mono wav（_encodeWav 返回 ArrayBuffer 或 null）
    let wavArr = null;
    try {
      const w = await this._encodeWav(blob);
      if (w) wavArr = w instanceof ArrayBuffer ? w : await w.arrayBuffer();
    } catch (e) { console.warn('[VoiceService] WAV 重编码失败:', e); }
    const arrBuf = wavArr || await blob.arrayBuffer();
    const u8all = new Uint8Array(arrBuf);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8all.length; i += CH) s += String.fromCharCode.apply(null, u8all.subarray(i, i + CH));
    const b64 = btoa(s);
    const reqid = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).toUpperCase();
    const res = await fetch('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
      method: 'POST',
      headers: {
        'X-Api-App-Key': String(appId),
        'X-Api-Access-Key': String(accessToken),
        'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
        'X-Api-Request-Id': reqid,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio: { data: b64, format: 'wav' },
        request: { model_name: 'bigmodel' },
      }),
    });
    const data = await res.json().catch(() => ({}));
    const code = data?.header?.code;
    if (code !== undefined && code !== 0 && String(code) !== '20000000') {
      throw new Error(`火山ASR ${code}: ${String(data?.header?.message || '').slice(0, 100)}`);
    }
    if (!res.ok && code === undefined) throw new Error('火山ASR HTTP ' + res.status);
    return String(data?.result?.text || '').trim();
  }

  // ---------- VAD 持续听（recorder 模式：音量检测自动分段） ----------

  /**
   * 开始持续听（VAD 分段模式）：AudioWorklet/ScriptProcessor 采样音量，
   * 说话开始 → 录音；静音约1s → 自动断句 → onFinal(转写文本) → 继续听。
   * 停止由 stopVoiceLoop 调用。
   * @param {object} [handlers] {onPartial, onFinal, onError, onState}
   *   onPartial: 检测到说话中（气泡提示）；onFinal: 一句话转写完成
   *   onState: 'listening' | 'transcribing'（VAD 状态切换）
   * @returns {Promise<boolean>}
   */
  async startVoiceLoop(handlers = {}) {
    if (this._vadActive) return true;
    if (!this._config.asrEnabled) {
      handlers.onError?.('语音识别已在设置中关闭');
      return false;
    }
    const w = this._win();
    const hasMedia = typeof navigator !== 'undefined' && navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (!hasMedia) {
      handlers.onError?.('当前环境不支持录音');
      return false;
    }

    // 重置会话状态
    this._vadHandlers = handlers;
    this._vadActive = true;
    this._vadPaused = false;   // 暂停检测（TTS 播报期间防自听自说）
    this._vadAbort = false;
    this._vadSilentChunks = []; // 触发说话前的预录（保说话开头）
    this._vadSpeechChunks = []; // 说话段 chunks
    this._vadSpeechStarted = false;
    this._vadSilentRun = 0;
    this._vadDropped = 0; // 静音丢弃计数（避免把噪声当话头）

    try {
      this._vadStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this._vadActive = false;
      const name = err && err.name;
      handlers.onError?.(name === 'NotAllowedError'
        ? asrErrorMessage('not-allowed')
        : name === 'NotFoundError' ? asrErrorMessage('audio-capture') : '麦克风启动失败');
      return false;
    }

    // 录音器：持续 timeslice 收 chunk（VAD 由 AnalyserNode 音量驱动）
    const MediaRecorderCtor = w.MediaRecorder;
    const mime = MediaRecorderCtor && typeof MediaRecorderCtor.isTypeSupported === 'function'
      && MediaRecorderCtor.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const rec = new MediaRecorderCtor(this._vadStream, mime ? { mimeType: mime } : undefined);
    this._vadRecorder = rec;
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size || !this._vadActive) return;
      // 打断触发的 recorder 重启：首个 chunk（含 EBML 头）直接并入说话段
      // （用户正在插话，预录无意义，头必须在段首）
      if (this._mergeSilentIntoSpeech) {
        this._vadSpeechChunks.push(e.data);
        if (this._vadSpeechChunks.length >= 1) this._mergeSilentIntoSpeech = false;
        return;
      }
      if (this._vadSpeechStarted) this._vadSpeechChunks.push(e.data);
      else {
        this._vadSilentChunks.push(e.data);
        // 保留最近~1s预录；[0] 永不丢（webm EBML 头在首个 chunk，丢了整段无法解码）
        if (this._vadSilentChunks.length > 10) this._vadSilentChunks.splice(1, 1);
      }
    };
    rec.start(100);

    // 音量分析：AudioContext + AnalyserNode（轮询 RMS，60ms 粒度）
    const AC = w.AudioContext || w.webkitAudioContext;
    this._vadCtx = new AC();
    const src = this._vadCtx.createMediaStreamSource(this._vadStream);
    const analyser = this._vadCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const THRESH = 0.035;   // 说话音量阈值（RMS）
    const SILENT_BREAK = 16; // ~16×60ms≈1s 静音 → 断句
    const LEAD_IN = 2;       // 连续2帧超阈值才算说话开始（防噪点）

    const poll = () => {
      if (!this._vadActive) return;
      if (this._vadPaused) {           // 暂停中：不检测、不消费 chunks
        this._vadTimer = setTimeout(poll, 60);
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);

      // ===== 外放回声防护（全时段） =====
      // 主进程 afplay 播报中（豆包TTS/EdgeTTS），喇叭声音会进麦克风——
      // 任何阈值都挡不住"她自己的声音"。播放期间 VAD 完全跳过判定，播完恢复。
      if (this._ttsPlayingOutloud) {
        this._intRun = 0;
        this._vadSilentRun = 0;
        this._loudRun = 0;
        this._vadSpeechStarted = false; // 播放期不积累语音状态
        this._vadSpeechChunks = [];
        this._vadSilentChunks = [];
        // 跳过本帧所有判定（含正常模式与打断模式）
      } else
      // ===== 打断模式（TTS 播报中） =====
      if (this._interruptArmed) {
        const I_THRESH = THRESH * 2.2;
        if (!this._vadSpeechStarted) {
          if (rms > I_THRESH) {
            this._intRun++;
            if (this._intRun >= 4) {
              this._interruptArmed = false; // 触发即解除，回调方负责停 TTS
              this._interruptCb?.();        // → pet 立即闭嘴
              // 重启 recorder：插话录音段需要全新 webm 头（EBML）才能解码
              // （旧 _vadSilentChunks 含的是旧头+TTS 回声，丢弃）
              this._vadSpeechChunks = [];
              this._vadSilentChunks = [];
              this._vadSilentRun = 0;
              this._restartVadRecorder(); // 注意：内部会重置 _vadSpeechStarted
              // 重启后再标记说话中（顺序关键：否则插话 chunks 会走 silent 分支丢失）
              this._vadSpeechStarted = true;
              // recorder 重启后首个 chunk（含头）直接并入 speech（用户正在说）
              this._mergeSilentIntoSpeech = true;
              this._vadHandlers?.onPartial?.('（你说话了，我闭嘴听…）');
            }
          } else {
            this._intRun = 0;
          }
        } else if (rms < THRESH * 0.6) {
          // TTS 已闭嘴（打断触发即停），用正常断句阈值
          this._vadSilentRun++;
          if (this._vadSilentRun >= SILENT_BREAK) {
            this._vadSilentRun = 0;
            this._vadSpeechStarted = false;
            this._emitVadSegment(); // 插话说完 → 断句送转写（与新回复同流程）
          }
        } else {
          this._vadSilentRun = 0;
        }
        this._vadTimer = setTimeout(poll, 60);
        return;
      }

      // ===== 正常收听模式 =====
      if (!this._vadSpeechStarted) {
        if (rms > THRESH) {
          this._vadDropped++;
          if (this._vadDropped >= LEAD_IN) {
            this._vadSpeechStarted = true;
            this._vadSpeechChunks = this._vadSilentChunks; // 预录并入（含 EBML 头），保住说话开头
            this._vadSilentChunks = [];
            this._vadSilentRun = 0;
            this._vadHandlers?.onPartial?.('（在听你说话…）');
          }
        } else {
          this._vadDropped = 0;
        }
      } else if (rms < THRESH * 0.6) {
        this._vadSilentRun++;
        if (this._vadSilentRun >= SILENT_BREAK) {
          this._vadSilentRun = 0;
          this._vadSpeechStarted = false;
          this._emitVadSegment(); // 静音断句 → 送转写
        }
      } else {
        this._vadSilentRun = 0;
      }
      this._vadTimer = setTimeout(poll, 60);
    };
    poll();
    handlers.onState?.('listening');
    return true;
  }

  /**
   * 武装打断（TTS 播报前调用）：播报期间 VAD 保持监听（高阈值），
   * 检测到用户插嘴 → 立即回调（调用方停 TTS）→ 插话录音照常断句转写。
   * 打电话式全双工的关键。
   * @param {Function} cb 用户插嘴瞬间回调（无参）
   */
  armInterrupt(cb) {
    this._interruptCb = typeof cb === 'function' ? cb : null;
    this._interruptArmed = true;
    this._intRun = 0;
  }

  /** 解除打断模式（播报自然结束/会话终止） */
  disarmInterrupt() {
    this._interruptArmed = false;
    this._interruptCb = null;
    this._intRun = 0;
  }

  getInterruptArmed() { return !!this._interruptArmed; }

  /** 停掉所有 TTS（打断时用）：Edge afplay + 智谱 + 系统 speechSynthesis */
  stopAllTTS() {
    // Edge（主进程 afplay kill）
    try { this._win().ttsAPI?.stop?.(); } catch { /* ignore */ }
    this.stopEdgeSpeak?.();
    this.stopCloudSpeak?.();
    this.stopSpeak?.();
  }

  /** VAD 断句：收集的语音 chunks → WAV → 转写 → onFinal → 继续听 */
  async _emitVadSegment() {
    const chunks = this._vadSpeechChunks;
    this._vadSpeechChunks = [];
    if (!chunks.length) return;
    const h = this._vadHandlers;
    if (!h) return;
    h.onState?.('transcribing');
    const blob = new Blob(chunks, { type: this._vadRecorder?.mimeType || 'audio/webm' });
    // 断句即停 recorder：已收 chunks 足够（说话段+尾静音）。转写完重启 recorder，
    // 保证下一段从 webm 头（EBML）开始，可解码。
    this._restartVadRecorder();
    let text = '';
    try {
      text = await this.transcribe(blob);
    } catch (err) {
      console.error('[VoiceService] VAD 段转写失败:', err);
      h.onError?.('转写失败：' + (err && err.message ? err.message : err));
    }
    if (!this._vadActive) return; // 会话已终止
    h.onState?.('listening');
    if (text) {
      h.onFinal?.(text);
    } else {
      // 空转写（太短/太轻）不该静默吞掉——轻提示让用户知道要重说，
      // 不打断节奏（继续 listening）
      h.onPartial?.('（没听清，再说一次？）');
    }
  }

  /** 重启 VAD recorder（断句后新段需要全新 webm 头才能被解码器识别） */
  _restartVadRecorder() {
    const rec = this._vadRecorder;
    this._vadSpeechStarted = false;
    this._vadSpeechChunks = [];
    this._vadSilentChunks = [];
    this._vadSilentRun = 0;
    this._vadDropped = 0;
    if (!rec || !this._vadActive || !this._vadStream) return;
    try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    const w = this._win();
    const MediaRecorderCtor = w.MediaRecorder;
    const mime = MediaRecorderCtor && typeof MediaRecorderCtor.isTypeSupported === 'function'
      && MediaRecorderCtor.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    try {
      const nr = new MediaRecorderCtor(this._vadStream, mime ? { mimeType: mime } : undefined);
      nr.ondataavailable = rec.ondataavailable; // 复用同一段收集逻辑
      nr.start(100);
      this._vadRecorder = nr;
    } catch (e) {
      console.warn('[VoiceService] VAD recorder 重启失败:', e);
    }
  }

  /** 停止 VAD 持续听（彻底释放麦克风） */
  stopVoiceLoop() {
    this._vadActive = false;
    if (this._vadTimer) { clearTimeout(this._vadTimer); this._vadTimer = null; }
    try { this._vadRecorder?.state !== 'inactive' && this._vadRecorder?.stop(); } catch { /* ignore */ }
    this._vadRecorder = null;
    try { this._vadCtx?.close(); } catch { /* ignore */ }
    this._vadCtx = null;
    try { this._vadStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    this._vadStream = null;
    this._vadHandlers = null;
  }

  getVoiceLoopActive() { return !!this._vadActive; }

  /**
   * 暂停/恢复 VAD 检测（麦克风保持开启）。
   * TTS 播报期间暂停检测 + 丢弃期间音频，防止把小球自己的声音当作用户说话（回声）。
   */
  pauseVAD() {
    this._vadPaused = true;
    this._vadSpeechStarted = false;
    this._vadSpeechChunks = [];
    this._vadSilentRun = 0;
  }

  resumeVAD() {
    this._vadPaused = false;
    this._vadDropped = 0;
  }

  getVADPaused() { return !!this._vadPaused; }

  // ---------- 音频编码：webm/opus blob → 16k mono WAV（智谱 ASR 只收 wav/mp3） ----------

  /**
   * 用 AudioContext 解码 blob 并重采样到 16kHz 单声道，输出 WAV Blob 的 ArrayBuffer
   * @param {Blob} blob
   * @returns {Promise<ArrayBuffer|null>} null=解码失败（调用方按原格式上传兜底）
   */
  async _encodeWav(blob) {
    const w = this._win();
    const AC = w.AudioContext || w.webkitAudioContext;
    if (!AC || typeof w.File === 'undefined') return null;
    const arrayBuf = await blob.arrayBuffer();
    const tmp = new AC({ sampleRate: 16000 }); // Chromium 会自动重采样
    let audioBuf;
    try {
      audioBuf = await tmp.decodeAudioData(arrayBuf.slice(0));
    } finally {
      try { tmp.close(); } catch { /* ignore */ }
    }
    // 混合为单声道
    const chs = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < chs; c++) {
      const data = audioBuf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += data[i] / chs;
    }
    return this._pcmToWav(mono, audioBuf.sampleRate);
  }

  /** Float32 PCM → 16bit WAV ArrayBuffer（RIFF 头 + data） */
  _pcmToWav(samples, sampleRate) {
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);        // fmt chunk size
    view.setUint16(20, 1, true);         // PCM
    view.setUint16(22, 1, true);         // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);        // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  // ---------- 云端 TTS（Edge TTS 优先 → 智谱 GLM-TTS → 系统TTS） ----------

  /**
   * Edge TTS：主进程 python edge-tts 合成 + afplay 播放（微软神经网络音色，免费）
   * 注：不走渲染进程 <audio>（部分 Electron 环境 mp3 解码不可用），主进程直接播
   * @param {string} text
   * @param {object} [opts] {voice='zh-CN-XiaoyiNeural', rate, pitch, onStart, onEnd}
   * @returns {Promise<'full'|'interrupted'|false>} 'full'=播完；'interrupted'=被打断；false=失败
   */
  async speakEdge(text, opts = {}) {
    const w = this._win();
    const ttsAPI = w.ttsAPI;
    if (!ttsAPI || typeof ttsAPI.play !== 'function') return false;
    const input = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!input) return false;

    const cfg = readJSON(this.storage, VOICE_CONFIG_KEY, {});
    // onStart 先行（合成有网络耗时，口型/冻结等 UI 状态别等）
    opts.onStart?.();
    this._ttsPlayingOutloud = true; // 外放中：VAD 跳过判定（防自声打断）
    const res = await ttsAPI.play({
      text: input,
      voice: opts.voice || cfg.edgeVoice || 'zh-CN-XiaoyiNeural',
      rate: typeof opts.rate === 'number' ? opts.rate : 0,
      pitch: typeof opts.pitch === 'number' ? opts.pitch : 0,
    }).catch(() => null);
    this._ttsPlayingOutloud = false;
    if (!res || res.ok !== true || res.played !== true) return false;
    opts.onEnd?.();
    return res.interrupted === true ? 'interrupted' : 'full';
  }

  /** 停止 Edge TTS 播放 */
  stopEdgeSpeak() {
    try { this._edgeAudio?.pause?.(); } catch { /* ignore */ }
    this._edgeAudio = null;
    this._edgeSpeaking = false;
  }

  /**
   * 豆包 TTS（火山语音合成大模型 seed-tts-1.0）。凭证：pet-tts-config > pet-asr-config > 豆包配置。
   * 响应=多个JSON对象连排，"data":"<base64-mp3>" 定界切分拼接 → 主进程 afplay 播放。
   */
  async speakDoubao(text, opts = {}) {
    try {
      const st = this.storage;
      const g = (k) => { try { return JSON.parse(st.getItem(k) || '{}'); } catch { return {}; } };
      const ttsCfg = g('pet-tts-config');
      const asrCfgV = g('pet-asr-config');
      const dbCfg = g('pet-doubao-realtime-config');
      const appId = ttsCfg.appId || asrCfgV.appId || dbCfg.appId;
      const accessToken = ttsCfg.accessToken || asrCfgV.accessToken || dbCfg.accessToken;
      if (!appId || !accessToken) return false;
      const res = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
        method: 'POST',
        headers: {
          'X-Api-App-Key': String(appId),
          'X-Api-Access-Key': String(accessToken),
          'X-Api-Resource-Id': 'seed-tts-1.0',
          'X-Api-Request-Id': (window.crypto && crypto.randomUUID) ? crypto.randomUUID().toUpperCase() : String(Date.now()) + Math.random(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          user: { uid: 'pet' },
          req_params: {
            text: String(text || '').slice(0, 800),
            ssml: '',
            speaker: ttsCfg.speaker || 'zh_female_cancan_mars_bigtts',
            audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 128000 },
          },
        }),
      });
      if (!res.ok) return false;
      const raw = await res.text();
      const marker = '"data":"';
      const chunks = [];
      let pos = 0;
      for (;;) {
        const i = raw.indexOf(marker, pos);
        if (i < 0) break;
        const s0 = i + marker.length;
        const j = raw.indexOf('"', s0);
        if (j < 0) break;
        chunks.push(raw.slice(s0, j));
        pos = j + 1;
      }
      if (!chunks.length) return false;
      const w = this._win();
      if (typeof w.ttsAPI?.playAudioFile !== 'function') return false;
      opts.onStart?.();
      this._ttsPlayingOutloud = true; // 外放中：VAD 跳过判定（防自声打断）
      const r = await w.ttsAPI.playAudioFile({ audioBase64: chunks.join(''), format: 'mp3' }).catch(() => null);
      this._ttsPlayingOutloud = false;
      if (!r || r.ok !== true || r.played !== true) return false;
      opts.onEnd?.();
      return true;
    } catch (e) {
      console.warn('[VoiceService] speakDoubao:', e?.message);
      return false;
    }
  }

  /** 通用音频 URL 播放（可打断） */
  _playAudioUrl(url, opts = {}) {
    return new Promise((resolve) => {
      const w = this._win();
      const audio = new w.Audio(url);
      audio.volume = 0.9;
      this._edgeAudio = audio; // 复用打断机制
      this._edgeSpeaking = true;
      opts.onStart?.();
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; this._edgeSpeaking = false; URL.revokeObjectURL(url); resolve(ok); } };
      audio.onended = () => done(true);
      audio.onerror = () => done(false);
      // 被打断（stopEdgeSpeak pause）→ ended 不触发，轮询检测
      const iv = setInterval(() => {
        if (!this._edgeSpeaking || audio.paused) { clearInterval(iv); if (!settled) done(false); }
      }, 200);
      setTimeout(() => { clearInterval(iv); }, 60000);
      audio.play().catch(() => done(false));
    });
  }

  /**
   * 云端 TTS：POST {baseURL}/audio/speech → wav 二进制 → <audio> 播放
   * @param {string} text（>1024 字自动截断，智谱限制）
   * @param {object} [opts] {voice='tongtong', speed, onStart, onEnd}
   * @returns {Promise<boolean>} 是否完整播完
   */
  async speakCloud(text, opts = {}) {
    // TTS 配置解析：独立（pet-tts-config）> 跟随 LLM（OpenAI 兼容 /audio/speech：智谱/火山/OpenAI等）
    const ttsCfg = readJSON(this.storage, 'pet-tts-config', {});
    const llmCfg0 = readJSON(this.storage, LLM_CONFIG_KEY, {});
    const cfg = (ttsCfg.baseURL && ttsCfg.apiKey) ? ttsCfg : llmCfg0;
    const base = String(cfg.baseURL || '').replace(/\/+$/, '');
    if (!base || !cfg.apiKey) return false; // 未配置 → 调用方降级系统 TTS
    const input = String(text || '').slice(0, 1024);
    const body = {
      model: ttsCfg.model || cfg.ttsModel || 'glm-tts',
      input,
      voice: opts.voice || cfg.ttsVoice || 'tongtong',
      response_format: 'wav',
    };
    if (typeof opts.speed === 'number') body.speed = clamp(opts.speed, 0.5, 2);

    let res;
    try {
      res = await fetch(base + '/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
      });
    } catch {
      return false;
    }
    if (!res.ok) {
      console.warn('[VoiceService] 云端TTS HTTP ' + res.status + '，降级系统TTS');
      return false;
    }
    const audioData = await res.arrayBuffer();
    if (!audioData || audioData.byteLength < 100) return false;

    return new Promise((resolve) => {
      const w = this._win();
      const audio = new w.Audio();
      const url = w.URL.createObjectURL(new Blob([audioData], { type: 'audio/wav' }));
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        try { w.URL.revokeObjectURL(url); } catch { /* ignore */ }
        this._cloudSpeaking = false;
        opts.onEnd?.();
        resolve(ok);
      };
      this._cloudSpeaking = true;
      this._cloudAudio = audio;
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.onplay = () => opts.onStart?.();
      audio.src = url;
      audio.play().then(() => opts.onStart?.()).catch(() => finish(false));
      // 兜底：部分实现不触发 onplay
      setTimeout(() => { if (!done) opts.onStart?.(); }, 300);
    });
  }

  /** 停止云端 TTS 播放 */
  stopCloudSpeak() {
    try { this._cloudAudio?.pause?.(); } catch { /* ignore */ }
    if (this._cloudAudio) this._cloudAudio = null;
    this._cloudSpeaking = false;
  }

  getCloudSpeaking() { return !!this._cloudSpeaking; }
}

export default VoiceService;
export { VoiceService, VOICE_CONFIG_KEY, LLM_CONFIG_KEY, DEFAULT_VOICE_CONFIG };
