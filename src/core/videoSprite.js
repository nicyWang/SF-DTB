// videoSprite.js — 视频版桌宠渲染（PIXI + HTML5 Video + canvas chroma key）
// API 与 sprite.js 兼容，可作为 spriteRenderer 注入 PetController

const PIXI = window.PIXI;

// 角色情绪视频配置
const VIDEO_CHARACTERS = {
  handsome_v2: {
    id: 'handsome_v2',
    name: '凌川',
    videoDir: 'src/assets/characters/handsome_v2/videos',
    // 视频→情绪映射（webm格式兼容性最好，agent-browser可播+Mac Chrome/H.264也能播）
    videoMap: {
      normal: 'normal.webm',
      happy: 'happy.webm',
      excited: 'happy.webm',    // 暂复用 happy
      sad: 'sad.webm',
      sleepy: 'normal.webm',    // 暂复用 normal
      bored: 'normal.webm',
      shy: 'happy.webm',
      talking: 'talking.webm',
    },
  },
};

class VideoSpriteRenderer {
  constructor(opts) {
    this.app = opts.app;
    this.container = opts.container;
    this.bubble = opts.bubble;
    this.onHitCallbacks = [];
    this._destroyed = false;
    this._videos = {}; // emotion → HTMLVideoElement
    this._currentVideo = null;
    this._currentEmotion = 'normal';
    this._sprite = null;
    this._mask = null;
    this._renderTexture = null;
    this._canvas = null;
    this._ctx = null;
    // 视差跟随
    this._mouseFollow = true;
    this._mouseX = 0; this._mouseY = 0;
    this._targetOffX = 0; this._targetOffY = 0;
    this._targetRot = 0;
    this._draggable = false;
    this._dragging = false;
    this._dragStart = null;
    // 视频水印裁剪（右下角约15%）
    this._watermarkCrop = { x: 0, y: 0, w: 1, h: 0.85 };
  }

  async init(characterId = 'handsome_v2') {
    const info = VIDEO_CHARACTERS[characterId];
    if (!info) throw new Error('[VideoSprite] unknown character: ' + characterId);
    this.characterId = characterId;
    this.characterInfo = info;

    // 创建 off-screen canvas（视频帧渲染到这里 → PIXI texture）
    this._canvas = document.createElement('canvas');
    this._canvas.width = 540;  // 540x540（视频自适应高度按比例）
    this._canvas.height = 540;
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    // 初始填黑底，避免PIXI texture的透明像素显示白色
    this._ctx.fillStyle = '#000';
    this._ctx.fillRect(0, 0, 540, 540);

    // 并行预加载视频（按文件名去重——多个情绪共用同一视频文件时只创建一个video元素，避免解码器资源耗尽）
    this._fileVideos = new Map(); // filename → video element
    const uniqueFiles = [...new Set(Object.values(info.videoMap))];
    const loadPromises = uniqueFiles.map((filename) => {
      return new Promise((resolve) => {
        const v = document.createElement('video');
        // 双源：mp4优先（Safari/Mac Chrome全支持H.264），webm兜底
        const base = filename.replace(/\.(webm|mp4)$/, '');
        v.innerHTML = `<source src="${info.videoDir}/${base}.mp4" type="video/mp4"><source src="${info.videoDir}/${base}.webm" type="video/webm">`;
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.preload = 'auto';
        let done = false;
        const finish = () => { if (done) return; done = true; this._fileVideos.set(filename, v); resolve(v); };
        v.oncanplay = () => finish();
        v.onerror = () => { console.warn('[VideoSprite] 视频加载失败:', filename); finish(); };
        setTimeout(() => finish(), 2500); // 兜底超时（加载完成后不自动play，避免多解码器并发耗尽GPU）
        document.body.appendChild(v);
      });
    });
    await Promise.all(loadPromises);
    // emotion → 共享video元素映射
    for (const [emotion, filename] of Object.entries(info.videoMap)) {
      this._videos[emotion] = this._fileVideos.get(filename) || this._fileVideos.get('normal.webm');
    }

    // 创建 PIXI 显示
    this._renderTexture = PIXI.Texture.from(this._canvas);
    this._sprite = new PIXI.Sprite(this._renderTexture);
    this._sprite.anchor.set(0.5, 0.5);
    this._sprite.interactive = true;
    this._sprite.cursor = 'pointer';
    this._sprite.on('pointertap', (e) => this._handleTap(e));
    // 椭圆遮罩（去水印+聚焦人物中心）
    this._mask = new PIXI.Graphics();
    this._updateMask();
    this._sprite.mask = this._mask;
    this._mask.renderable = false; // graphics不渲染到屏幕，仅作alpha模板
    this.app.stage.addChild(this._mask);
    this.app.stage.addChild(this._sprite);
    this._fitToContainer();

    // 启动第一个视频
    this._switchVideo(this._currentEmotion);

    // 启动鼠标跟随
    this._bindMouseFollow();
    // 启动每帧渲染循环（视频→canvas→texture）
    this._startRenderLoop();
    // 启动视差跟随ticker
    this._startFollowTicker();

    return this;
  }

  _updateMask() {
    if (!this._mask || !this._sprite) return;
    this._mask.clear();
    this._mask.beginFill(0xffffff);
    // 关键：mask在sprite.parent的local坐标系，画覆盖sprite当前显示区域的椭圆
    // sprite.x/y在父（stage）坐标系，宽高由_fitToContainer设置
    const sx = this._sprite.x;
    const sy = this._sprite.y;
    const sw = this._sprite.width;
    const sh = this._sprite.height;
    // 椭圆中心对齐sprite中心
    this._mask.x = 0;
    this._mask.y = 0;
    // 椭圆稍大于sprite半宽，把两侧灰色背景裁掉（半径0.49几乎贴边）
    this._mask.drawEllipse(sx, sy, sw / 2 * 1.15, sh / 2 * 1.15);
    this._mask.endFill();
  }

  _fitToContainer() {
    if (!this._sprite || !this._container) return;
    const cw = this.app.renderer.width / (window.devicePixelRatio || 1);
    const ch = this.app.renderer.height / (window.devicePixelRatio || 1);
    const fit = Math.min(cw, ch) * 0.95;
    this._sprite.width = fit;
    this._sprite.height = fit;
    this._sprite.x = cw / 2;
    this._sprite.y = ch / 2;
  }

  _switchVideo(emotion) {
    const v = this._videos[emotion] || this._videos.normal;
    if (!v) return;
    // 暂停其他视频
    for (const vv of this._fileVideos ? this._fileVideos.values() : Object.values(this._videos)) {
      if (vv !== v) { try { vv.pause(); } catch(e){} }
    }
    this._currentVideo = v;
    this._currentEmotion = emotion;
    // seek完成后再play（避免seek+play并发导致media pipeline死锁）
    const startPlay = () => {
      v.play().catch(() => setTimeout(() => v.play().catch(()=>{}), 200));
    };
    if (v.currentTime > 0.05) {
      const onSeeked = () => { v.removeEventListener('seeked', onSeeked); startPlay(); };
      v.addEventListener('seeked', onSeeked);
      try { v.currentTime = 0; } catch(e) { startPlay(); }
      // seek 500ms 兜底
      setTimeout(() => { v.removeEventListener('seeked', onSeeked); if (v.paused) startPlay(); }, 500);
    } else if (v.paused) {
      startPlay();
    }
  }

  _startRenderLoop() {
    // 30fps canvas更新
    this._renderTimer = setInterval(() => {
      if (this._destroyed) return;
      const v = this._currentVideo;
      if (!v || v.readyState < 2) return; // HAVE_CURRENT_DATA
      const ctx = this._ctx;
      const cw = this._canvas.width, ch = this._canvas.height;
      const vw = v.videoWidth, vh = v.videoHeight;
      if (vw === 0 || vh === 0) return;
      // 视频按"cover"模式填满canvas（裁掉水印在右下的部分）
      const crop = this._watermarkCrop;
      // 计算视频源裁剪区
      const srcW = vw * crop.w;
      const srcH = vh * crop.h;
      const srcX = vw * crop.x;
      const srcY = vh * crop.y;
      // 目标画满
      ctx.drawImage(v, srcX, srcY, srcW, srcH, 0, 0, cw, ch);
      // 关键：通知PIXI canvas内容已变化，更新GPU纹理（否则画面冻结在第一帧）
      if (this._renderTexture) this._renderTexture.update();
    }, 33);
  }

  _bindMouseFollow() {
    window.addEventListener('mousemove', (e) => {
      this._mouseX = e.clientX;
      this._mouseY = e.clientY;
    });
  }

  _startFollowTicker() {
    this._followTimer = setInterval(() => {
      if (this._destroyed || !this._sprite || this._dragging || !this._mouseFollow) return;
      const cw = window.innerWidth, ch = window.innerHeight;
      const nx = (this._mouseX - cw / 2) / (cw / 2); // -1~1
      const ny = (this._mouseY - ch / 2) / (ch / 2);
      this._targetOffX = nx * 12;   // 视差偏移
      this._targetOffY = ny * 8;
      this._targetRot = nx * 0.04;  // 微倾
      this._sprite.x += (this._targetOffX - (this._sprite.x - (window.innerWidth / 2))) * 0.1;
      this._sprite.y += (this._targetOffY - (this._sprite.y - (window.innerHeight / 2))) * 0.1;
    }, 16);
  }

  _handleTap() {
    this.bubble?.showHint('有人摸我头～');
    for (const cb of this.onHitCallbacks) cb(['body']);
  }

  // ========== 对外 API（与 sprite.js 兼容） ==========
  setEmotion(emotion) {
    if (this._destroyed) return false;
    this._switchVideo(emotion);
    return true;
  }
  playMotion(group, index) {
    // 视频版本：触发拍打脉冲
    if (group === 'TapBody' || group === 'tap' || group === 'pat') {
      this._tapPulseUntil = Date.now() + 600;
      // 缩放脉冲
      const s = this._sprite.scale.x;
      this._sprite.scale.set(s * 1.05, s * 1.05);
      setTimeout(() => { if (!this._destroyed) this._sprite.scale.set(s, s); }, 200);
      this.bubble?.showHint('嘿嘿，被摸头啦～');
      return true;
    }
    return true;
  }
  setDraggable(b) { this._draggable = b; }
  setMouseFollow(b) { this._mouseFollow = b; }
  setScale(s) { if (this._sprite) { this._sprite.scale.set(s, s); } }
  flipX() { /* 视频暂不镜像 */ }
  setFlipX(b) { /* 视频暂不镜像 */ }
  lookAt() { /* 由 _followTicker 处理 */ }
  lipSpeak(duration) {
    // 切到 talking 视频
    this._switchVideo('talking');
    if (duration) {
      setTimeout(() => {
        if (!this._destroyed) this._switchVideo(this._currentEmotion);
      }, duration);
    }
  }
  onHit(cb) { this.onHitCallbacks.push(cb); }
  getModelInfo() {
    return {
      character: this.characterId,
      type: 'video',
      videoFiles: Object.keys(this._videos).length,
      videoMap: this.characterInfo?.videoMap,
    };
  }
  destroy() {
    this._destroyed = true;
    clearInterval(this._renderTimer);
    clearInterval(this._followTimer);
    for (const v of Object.values(this._videos)) {
      try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch(e){}
    }
    this._videos = {};
    try { this._sprite?.destroy(); } catch(e){}
    try { this._mask?.destroy(); } catch(e){}
    try { this._renderTexture?.destroy(); } catch(e){}
  }
}

// 暴露（兼容 window 全局 + ES module export）
window.VideoSpriteRenderer = VideoSpriteRenderer;
window.VIDEO_CHARACTERS = VIDEO_CHARACTERS;
export { VideoSpriteRenderer, VIDEO_CHARACTERS };
