// ============================================================
// doubao-realtime.js — 豆包端到端实时语音（渲染进程控制器）
// 架构：主进程 doubao.js 管 WS 鉴权+二进制协议；本模块管
//   麦克风采集(PCM16k) → IPC 'doubao-audio-in' → 豆包
//   豆包音频 → IPC 'doubao-audio' → Web Audio 流式播放(24k)
//   服务端VAD(450事件) → 打断播报（barge-in，打电话体验）
// 配置：'pet-doubao-realtime-config' {appId, accessToken, botName, systemRole, voice}
// ============================================================

const DB_CONFIG_KEY = 'pet-doubao-realtime-config';

class DoubaoRealtime {
  constructor(opts = {}) {
    this.storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.audioAPI = opts.audioAPI ?? (typeof window !== 'undefined' ? window.doubaoAPI : null);
    this._active = false;
    this._handlers = {};
    this._micStream = null;
    this._audioCtx = null;   // 采集 ctx (16k)
    this._processor = null;
    this._playCtx = null;    // 播放 ctx (24k)
    this._playTime = 0;      // 播放调度时钟
    this._unbind = [];
  }

  static loadConfig(storage) {
    try {
      return JSON.parse((storage || localStorage).getItem(DB_CONFIG_KEY) || 'null') || {};
    } catch { return {}; }
  }

  isConfigured() {
    const cfg = DoubaoRealtime.loadConfig(this.storage);
    return !!(cfg.appId && cfg.accessToken);
  }

  get active() { return this._active; }

  /** 工具分流：丢弃当前轮豆包音频（_maybeVoiceToolRoute 用） */
  suppressAudio() { this._suppressAudio = true; }
  resumeAudio() { this._suppressAudio = false; }

  /** 豆包代播文本（工具结果门面统一）：ChatTTSText→豆包TTS→音频正常回传播放 */
  say(text) {
    try {
      this._suppressAudio = false; // 代播的音频要能回传
      this._micMuted = true;       // 播报期间静音麦（防回声环）
      this._scheduleMicUnmute();   // 按默认时长恢复
      this.audioAPI.say?.(text);
    } catch (e) {
      console.warn('[DoubaoRealtime] say 失败:', e?.message);
    }
  }

  /** 启动实时对话（低延迟流式；失败返回 false → 调用方回退现有链路） */
  async start(handlers = {}) {
    if (this._active) return true;
    // 严格防并发：start 进行中（含上轮 stop 收尾）时，等待后检查状态——
    // 并发 start 会导致 _startMic 双跑（旧 processor 泄漏且持续 sendAudio）→
    // 上行音频双份 → 豆包识别成每个词说两遍 → 回复逐词重复！
    if (this._starting) {
      await this._starting;
      if (this._active) return true; // 别的调用已把会话拉起
    }
    if (this._stopping) {
      await this._stopping;
    }
    const run = this._startInner(handlers);
    this._starting = run;
    try {
      return await run;
    } finally {
      if (this._starting === run) this._starting = null;
    }
  }

  async _startInner(handlers = {}) {
    // 打断开关（设置页 pet-doubao-realtime-config.bargein，默认开）
    try {
      const cfg = DoubaoRealtime.loadConfig(this.storage);
      this._bargein = cfg.bargein !== false;
    } catch { this._bargein = true; }
    // 双保险：清掉任何残留监听与采集器（异常路径泄漏时）
    this._unbindAll();
    this._stopMic();
    if (!this.isConfigured()) {
      handlers.onError?.('未配置豆包实时语音');
      return false;
    }
    this._handlers = handlers;
    const cfg = DoubaoRealtime.loadConfig(this.storage);

    // 1) 主进程建连+开会话（15s 兜底超时：主进程异常挂起时绝不卡死界面）
    const r = await Promise.race([
      this.audioAPI.start(cfg).catch(e => ({ ok: false, error: String(e) })),
      new Promise((resolve) => setTimeout(() =>
        resolve({ ok: false, error: '连接超时(15s)' }), 15000)),
    ]);
    if (!r || r.ok !== true) {
      handlers.onError?.(r?.error || '豆包连接失败');
      return false;
    }

    // 2) 事件订阅（主进程 → 渲染进程）
    const onEvent = (_e, msg) => this._onEvent(msg);
    const onAudio = (_e, buf) => this._onAudio(buf);
    this.audioAPI.onEvent(onEvent);
    this.audioAPI.onAudio(onAudio);
    this._unbind.push(() => this.audioAPI.offEvent(onEvent));
    this._unbind.push(() => this.audioAPI.offAudio(onAudio));

    // 3) 麦克风采集推流（PCM 16k mono s16le；10s 兜底——权限弹窗挂起不至于冻住界面）
    try {
      await Promise.race([
        this._startMic(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('麦克风启动超时(10s)')), 10000)),
      ]);
    } catch (e) {
      handlers.onError?.('麦克风失败: ' + (e.message || e));
      await this.stop();
      return false;
    }

    this._active = true;
    handlers.onState?.('listening');
    return true;
  }

  async stop() {
    if (this._stopping) return this._stopping; // 防并发 stop
    this._stopping = (async () => {
      this._active = false;
      this._micMuted = false;
      if (this._unmuteTimer) { clearTimeout(this._unmuteTimer); this._unmuteTimer = null; }
      this._stopMic();
      this._flushPlayback();
      // ⚠️ 先解绑监听器（最关键——防下一轮 start 叠加监听导致音频双播）
      this._unbindAll();
      try { this._playCtx?.close(); } catch { /* ignore */ }
      this._playCtx = null;
      this._activeSources = null;
      try { await this.audioAPI.stop(); } catch { /* ignore */ }
      this._handlers.onState?.('idle');
      this._stopping = null;
    })();
    return this._stopping;
  }

  /** 解绑全部 IPC 监听器（幂等） */
  _unbindAll() {
    for (const u of this._unbind) { try { u(); } catch { /* ignore */ } }
    this._unbind = [];
  }

  // ---------- 事件处理 ----------

  _onEvent(msg) {
    if (!msg || !msg.type) return;
    const h = this._handlers;
    switch (msg.type) {
      case 'user-speech-start': // 服务端VAD：用户开口 → 立即停播报（barge-in 打断）
        // ⚠️ 防回声环自锁：麦克风静音期间（她播报中）我们上行的是纯零——
        // 服务端此时不可能听到"用户"，此事件必为误判/残留，忽略之。
        // 否则停播→恢复麦克风→尾音上行→又触发→自我对话循环。
        if (this._micMuted) {
          console.warn('[DoubaoRealtime] 忽略播报期间的 user-speech-start（防回声环）');
          break;
        }
        this._flushPlayback();  // 丢弃未播的排队音频 + 停当前
        h.onInterrupt?.();
        h.onState?.('listening');
        break;
      case 'user-text': { // 转写（含中间结果）
        const r = (msg.data?.results || [])[0] || {};
        if (r.text) h.onUserText?.(r.text, !!r.is_interim);
        break;
      }
      case 'user-speech-end':
        h.onState?.('thinking');
        break;
      case 'tts-start':
        this._micMuted = true;  // 她要开口：静音麦克风（防回声环——她的声音被
                                // 麦克风收回会让服务端误判用户插嘴→打断重说→结巴）
        h.onState?.('speaking');
        break;
      case 'reply-text': // 模型回复文本（delta）
        if (msg.data?.delta || msg.data?.text) h.onReplyText?.(msg.data.delta || msg.data.text);
        break;
      case 'tts-end':
        // ⚠️ 服务端"音频发完"≠本地"播完"——网络比播放快，本地队列可能还有 1-2s
        // 未播音频。播完才算真空闲：按队列剩余时长延迟恢复麦克风。
        this._scheduleMicUnmute();
        h.onState?.('listening');
        break;
      case 'error':
        h.onError?.('豆包: ' + (msg.data?.message || msg.data?.status_code || '未知错误'));
        break;
      case 'session-failed':
      case 'conn-error':
      case 'conn-closed':
        this._active = false;
        h.onError?.('连接断开');
        break;
      default: break;
    }
  }

  /** 她播报期间静音麦克风（发零值 PCM 保持音频流，服务端不会断流）。
   *  播完（队列排空）后延迟恢复，避免尾音误触发服务端 VAD */
  _scheduleMicUnmute() {
    if (this._unmuteTimer) clearTimeout(this._unmuteTimer);
    let remainMs = 150; // 兜底
    try {
      if (this._playCtx && this._playTime > this._playCtx.currentTime) {
        remainMs = (this._playTime - this._playCtx.currentTime) * 1000;
      }
    } catch { /* ignore */ }
    this._unmuteTimer = setTimeout(() => {
      this._micMuted = false;
      this._unmuteTimer = null;
    }, remainMs + 400); // 多等 400ms：尾音消散 + 服务端 VAD 状态归零
    // （恢复太急，扬声器尾音会被服务端当成用户开口 → 又触发一轮回复）
  }

  /** 立即恢复麦克风（打断场景：用户真的插嘴了） */
  _unmuteNow() {
    if (this._unmuteTimer) { clearTimeout(this._unmuteTimer); this._unmuteTimer = null; }
    this._micMuted = false;
  }

  /** 服务端音频块（PCM s16le 24k mono）→ Web Audio 流式播放 */
  _onAudio(buf) {
    if (this._suppressAudio) return; // 工具分流期间丢弃（防豆包回复与工具结果双声）
    try {
      const w = window;
      // 持久 AudioContext（会话期间复用）：每次 flush 都 close/new 会产生
      // "旧ctx异步关闭尾巴 + 新ctx开播" 的双声重叠！
      if (!this._playCtx) {
        this._playCtx = new (w.AudioContext || w.webkitAudioContext)({ sampleRate: 24000 });
        this._playTime = 0;
        this._activeSources = new Set();
      }
      // IPC Buffer 视图安全切片 + 偶数对齐
      const u8 = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
      const aligned = new Uint8Array(u8.byteLength - (u8.byteLength % 2));
      aligned.set(u8.subarray(0, aligned.byteLength));
      const i16 = new Int16Array(aligned.buffer);
      const f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      const audioBuf = this._playCtx.createBuffer(1, f32.length, 24000);
      audioBuf.copyToChannel(f32, 0);
      const src = this._playCtx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(this._playCtx.destination);
      const now = this._playCtx.currentTime;
      if (this._playTime < now) this._playTime = now + 0.02;
      src.start(this._playTime);
      this._playTime += audioBuf.duration;
      // 追踪活跃 source（播完自动出队；打断时同步 stop——立即静音，无尾巴）
      this._activeSources.add(src);
      src.onended = () => this._activeSources?.delete(src);
    } catch (e) {
      console.warn('[DoubaoRealtime] 播放失败:', e?.message);
    }
  }

  /** 立即停止播放（打断）：同步 stop 所有活跃 source——即刻静音、零尾巴、无重叠 */
  _flushPlayback() {
    if (this._activeSources) {
      for (const s of this._activeSources) {
        try { s.stop(); s.disconnect(); } catch { /* ignore */ }
      }
      this._activeSources.clear();
    }
    this._playTime = 0;
    // ctx 保留复用（不 close！）
  }

  // ---------- 麦克风 ----------

  async _startMic() {
    const w = window;
    // 防采集器泄漏：已有旧采集链（并发/异常路径残留）先彻底停掉——
    // 两条采集链同时 sendAudio = 上行音频双份 = 豆包逐词重复
    if (this._processor || this._audioCtx || this._micStream) {
      this._stopMic();
    }
    this._micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this._audioCtx = new (w.AudioContext || w.webkitAudioContext)({ sampleRate: 16000 });
    const source = this._audioCtx.createMediaStreamSource(this._micStream);
    this._processor = this._audioCtx.createScriptProcessor(2048, 1, 1);
    this._processor.onaudioprocess = (e) => {
      if (!this._active) return;
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      if (this._micMuted) {
        // 她播报中：上行纯静音（防回声环）。打断开关（bargein，设置页可配）开启时，
        // 恢复本地音量打断检测：连续4帧强人声(rms>0.2)→真插嘴→停播恢复收音。
        // 外放回声一般达不到 0.2 且不连续；耳机环境零误触发。
        if (this._bargein) {
          let sum = 0;
          for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
          const rms = Math.sqrt(sum / f32.length);
          this._loudRun = rms > 0.2 ? (this._loudRun || 0) + 1 : 0;
          if (this._loudRun >= 4) {
            this._loudRun = 0;
            console.log('[DoubaoRealtime] 插嘴确认(rms=' + rms.toFixed(2) + ') → 停播');
            this._unmuteNow();
            this._flushPlayback();
            this._handlers.onInterrupt?.();
            this._handlers.onState?.('listening');
          }
        }
        i16.fill(0);
      } else {
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]));
          i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
      }
      this.audioAPI.sendAudio(i16.buffer);
    };
    source.connect(this._processor);
    this._processor.connect(this._audioCtx.destination);
  }

  _stopMic() {
    try { this._processor?.disconnect(); } catch { /* ignore */ }
    this._processor = null;
    try { this._audioCtx?.close(); } catch { /* ignore */ }
    this._audioCtx = null;
    try { this._micStream?.getTracks?.().forEach(t => t.stop()); } catch { /* ignore */ }
    this._micStream = null;
  }
}

export default DoubaoRealtime;
export { DoubaoRealtime, DB_CONFIG_KEY };
