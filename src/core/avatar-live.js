// ============================================================
// avatar-live.js — 火山实时互动数字人（渲染进程）
// 视频：ByteRTC WebRTC 拉流（@volcengine/rtc）→ canvas/video 渲染
// 音频驱动：豆包 TTS 输出（PCM 24k）→ 重采样 16k → 主进程 → 火山生成口型视频
// 配置：'pet-avatar-config' {accountId, accessKey, secretKey, roleImageUrl, rtcAppId, rtcToken}
// ============================================================

const AV_CONFIG_KEY = 'pet-avatar-config';

class AvatarLive {
  constructor(opts = {}) {
    this.storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this.avatarAPI = opts.avatarAPI ?? (typeof window !== 'undefined' ? window.avatarAPI : null);
    this._active = false;
    this._rtcEngine = null;
    this._videoEl = null;
    this._startTimer = null;
    this._startTimerResult = null;
    this._waitTimer = null;
    this._unbind = [];
    this._handlers = {};
  }

  static loadConfig(storage) {
    try {
      return JSON.parse((storage || localStorage).getItem(AV_CONFIG_KEY) || 'null') || {};
    } catch { return {}; }
  }

  isConfigured() {
    const c = AvatarLive.loadConfig(this.storage);
    return !!(c.accountId && c.accessKey && c.secretKey && c.roleImageUrl && c.rtcAppId && c.rtcToken);
  }

  get active() { return this._active; }

  /** 启动数字人（开播 + RTC 拉流） */
  async start(handlers = {}) {
    if (this._active) return true;
    this._unbindAll();
    this._handlers = handlers;
    const cfg = AvatarLive.loadConfig(this.storage);

    // 1) 主进程开播（WS 鉴权 + 初始化，返回 RTC 参数经 avatar-event 下发）
    const onEvent = (_e, msg) => this._onEvent(msg);
    this.avatarAPI.onEvent(onEvent);
    this._unbind.push(() => this.avatarAPI.offEvent(onEvent));
    this._startTimer = setTimeout(() => {
      const result = this._startTimerResult;
      this._startTimerResult = null;
      result?.({ ok: false, error: '开播超时(18s)' });
    }, 18000);
    const r = await Promise.race([
      this.avatarAPI.start(cfg).catch(e => ({ ok: false, error: String(e) })),
      new Promise(res => this._startTimerResult = res),
    ]);
    clearTimeout(this._startTimer);
    this._startTimer = null;
    if (!r || r.ok !== true) {
      handlers.onError?.(r?.error || '数字人开播失败');
      this._unbindAll();
      return false;
    }
    // 等待 live-started 事件（含 RTC 参数）再拉流
    await new Promise((res) => {
      this._waitLive = res;
      this._waitTimer = setTimeout(() => { this._waitLive = null; res(); }, 8000);
    });
    clearTimeout(this._waitTimer);
    this._waitTimer = null;
    return this._active;
  }

  async stop() {
    this._active = false;
    if (this._startTimer) clearTimeout(this._startTimer);
    this._startTimer = null;
    this._startTimerResult?.();
    this._startTimerResult = null;
    this._waitLive?.();
    this._waitLive = null;
    if (this._waitTimer) clearTimeout(this._waitTimer);
    this._waitTimer = null;
    this._teardownRtc();
    this._unbindAll();
    try { await this.avatarAPI.stop(); } catch { /* ignore */ }
    this._handlers.onState?.('idle');
  }

  _onEvent(msg) {
    if (!msg || !msg.type) return;
    const h = this._handlers;
    switch (msg.type) {
      case 'live-started':
        this._setupRtc(msg.rtc).then(ok => {
          this._active = ok;
          this._waitLive?.();
          this._waitLive = null;
          if (ok) h.onState?.('live');
          else h.onError?.('RTC 拉流失败');
        });
        break;
      case 'event': {
        const ev = msg.data?.event || msg.data?.type;
        if (ev === 'voice_start') h.onState?.('speaking');
        if (ev === 'voice_end') h.onState?.('idle');
        break;
      }
      case 'error':
        h.onError?.('数字人: ' + JSON.stringify(msg.data || {}).slice(0, 100));
        break;
      case 'closed':
        this._active = false;
        h.onError?.('数字人连接关闭');
        break;
    }
  }

  /** ByteRTC 拉流：加入房间订阅数字人视频 */
  async _setupRtc(rtc) {
    try {
      const VERTC = await import('@volcengine/rtc');
      const Engine = VERTC.VERTCEngine || VERTC.default?.VERTCEngine;
      if (!Engine) throw new Error('RTC SDK 未加载');
      this._teardownRtc();
      this._rtcEngine = Engine.createEngine(rtc.appId);
      // 用户进房（临时 token）
      const roomCfg = { roomId: rtc.roomId, token: rtc.token, userId: rtc.localUid };
      await this._rtcEngine.joinRoom(roomCfg, {
        profile: 'profile_480P_15',
        isAutoPublish: false,
        isAutoSubscribeAudio: false,
        isAutoSubscribeVideo: true,
      });
      // 订阅数字人流
      const stream = this._rtcEngine.createUserStream(rtc.innerUid, VERTC.StreamIndex.STREAM_INDEX_MAIN);
      // 渲染到容器
      const el = this._ensureVideoEl();
      this._rtcEngine.playVideo(stream, el.id);
      // 音频（数字人旁路的声音用本地播——我们用豆包 TTS 本地播，不订阅 RTC 音频防双声）
      this._rtcRemote = { roomId: rtc.roomId, innerUid: rtc.innerUid };
      return true;
    } catch (e) {
      console.error('[AvatarLive] RTC setup fail:', e?.message);
      return false;
    }
  }

  _ensureVideoEl() {
    let el = document.getElementById('avatar-video-wrap');
    if (!el) {
      el = document.createElement('div');
      el.id = 'avatar-video-wrap';
      // 桌宠同款：右下角悬浮圆角窗
      el.style.cssText = 'position:fixed;right:24px;bottom:24px;width:280px;height:400px;border-radius:16px;overflow:hidden;z-index:9998;background:#000;box-shadow:0 8px 32px rgba(0,0,0,.35);display:none;';
      const inner = document.createElement('div');
      inner.id = 'avatar-video-canvas';
      inner.style.cssText = 'width:100%;height:100%;';
      el.appendChild(inner);
      document.body.appendChild(el);
    }
    el.style.display = 'block';
    return inner || el;
  }

  _teardownRtc() {
    try { this._rtcEngine?.leaveRoom(); } catch { /* ignore */ }
    try { this._rtcEngine?.destroy(); } catch { /* ignore */ }
    this._rtcEngine = null;
    const el = document.getElementById('avatar-video-wrap');
    if (el) el.style.display = 'none';
  }

  _unbindAll() {
    for (const u of this._unbind) { try { u(); } catch { /* ignore */ } }
    this._unbind = [];
  }

  // ---------- 音频驱动（豆包 TTS → 数字人口型） ----------
  /** 接收豆包 24k PCM 音频块 → 降采样 16k → 推火山驱动口型 */
  feedAudio(pcm24kInt16) {
    if (!this._active) return;
    try {
      // 24k → 16k 简单重采样（每 3 取 2）
      const n24 = pcm24kInt16.length;
      const n16 = Math.floor(n24 * 2 / 3);
      const out = new Int16Array(n16);
      for (let i = 0; i < n16; i++) {
        out[i] = pcm24kInt16[Math.floor(i * 3 / 2)];
      }
      this.avatarAPI.sendAudio(out.buffer);
    } catch { /* ignore */ }
  }

  /** 一段音频结束（通知火山收尾口型） */
  feedAudioEnd() {
    if (!this._active) return;
    try { this.avatarAPI.sendAudioEnd(); } catch { /* ignore */ }
  }
}

export default AvatarLive;
export { AvatarLive, AV_CONFIG_KEY };
