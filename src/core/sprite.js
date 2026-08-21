/**
 * sprite.js — 写实立绘渲染模块（替代 live2d.js）[frontend]
 * 基于 pixi.js@6.x + PIXI.Sprite 系统
 *
 * 资源：
 *  - 内置角色（handsome/beauty）：6 种情绪立绘（normal/happy/excited/sad/sleepy/bored），
 *    图片带浅灰渐变背景，运行时通过 chroma key 抠图成透明 PNG 用于透明窗显示。
 *  - 用户自建角色（角色工坊）：仅 normal.png 单图，图片经主进程 IPC 读为 base64；
 *    其余情绪用程序化滤镜近似（docs/character-generation-skill.md 第五节：
 *    ColorMatrixFilter brightness/saturation + scale/位移/摇摆变换）。
 *
 * 依赖加载方式（宿主页面需先加载 pixi.min.js → window.PIXI）：
 *   <script src="../node_modules/pixi.js/dist/browser/pixi.min.js"></script>
 *
 * 用法（与原 live2d.js 接口完全兼容，pet.js 无需改动）：
 *   const renderer = new SpriteRenderer({ characters }); // characters: CharacterManager 实例（可选）
 *   await renderer.init(container);
 *   await renderer.setCharacter('handsome'); // 内置；或 CharacterManager 注册的用户角色 id
 *   renderer.playMotion('TapBody', 0);
 *   renderer.onHit((areas, e) => { ... });
 *
 * 设计要点：
 *  - chroma key 抠图：采样四角取背景色参考，每像素判定"灰色（色差小） + 距背景近"
 *    落入即透明；边缘 0~0.3 范围内做软过渡 alpha，避免硬边。
 *  - 情绪切换：监听 PetEvents 'emotion:change' 自动 cross-fade（0.3s）切换 sprite 纹理；
 *    单图角色改用程序化滤镜（不换纹理）。
 *  - playMotion('TapBody', n) → 触发"轻拍"缩放脉冲（模拟命中反馈）。
 *  - playMotion('Idle', n) → 空操作，idle 动画由呼吸/眨眼循环承担。
 *  - 拖拽：pointerdown 命中 sprite → DOM mousemove/mouseup → windowAPI.moveWindow
 *    （与原 live2d.js 拖拽实现完全对齐）
 */

import { EMOTION_FILTERS } from './charprompt.js';

// ---------- 内置角色资源定义（用户角色经 CharacterManager 动态解析） ----------
const CHARACTERS = {
  handsome: {
    id: 'handsome',
    name: '凌川',
    role: '小狼狗',
    dir: 'assets/characters/handsome',
  },
  beauty: {
    id: 'beauty',
    name: '苏晚',
    role: '小甜心',
    dir: 'assets/characters/beauty',
  },
};

const EMOTION_FRAMES = ['normal', 'happy', 'excited', 'sad', 'sleepy', 'bored'];

// ---------- 内部可调参数（测试或调优时可通过构造函数 opts 覆盖） ----------
const DEFAULTS = {
  // chroma key：每像素与背景色参考的距离（max 通道差 + 欧氏距离）小于该阈值视为背景
  bgThreshold: 90,  // 提高阈值适应人物阴影
  // 软过渡区间：距背景参考 0~softEdge 范围内 alpha 从 0 渐变到 255
  softEdge: 25,
  // 色差（max - min）小于该值视为灰色像素（非彩色部分，包括头发暗部、白衬衫等）
  // 呼吸动画周期（毫秒）和缩放幅度
  breathPeriodMs: 4000,
  breathAmplitude: 0.02, // ±2%
  // 眨眼：每 3-6 秒一次，闭眼时长
  blinkMinMs: 3000,
  blinkMaxMs: 6000,
  blinkDurationMs: 150,
  // 切换情绪 cross-fade 时长
  fadeMs: 300,
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * SpriteRenderer — 写实立绘渲染器
 * 兼容 Live2DRenderer 的对外接口（init/playMotion/playExpression/onHit/setDraggable/
 *   setScale/flipX/setFlipX/isDraggable/hitTest/lookAt/getModelInfo/lipSpeak/destroy），
 * 让 pet.js 可直接复用，无需感知底层从 Live2D 切换到了 Sprite。
 */
class SpriteRenderer {
  constructor(opts = {}) {
    this.config = { ...DEFAULTS, ...opts };
    this.characters = opts.characters || null; // CharacterManager 实例（用户角色动态解析）
    this.app = null;          // PIXI.Application
    this.container = null;    // 挂载的 DOM 容器
    this.characterId = null;  // 当前角色 id（内置 id 或用户角色 uc_*）
    this.characterInfo = null;

    this._sprite = null;      // 当前情绪的 PIXI.Sprite
    this._fadeSprite = null;  // cross-fade 期间临时 sprite（旧情绪淡出）
    this._textures = {};      // {emotion: PIXI.Texture}
    this._rawCanvases = {};   // {emotion: HTMLCanvasElement} 抠图前原图（调试用）
    this._currentEmotion = 'normal';
    this._destroyed = false;
    this._singleImage = false;       // 单图角色（用户角色）：无分情绪帧，程序化滤镜近似
    this._emotionOffsetApplied = 0;  // 情绪附加位移已应用量（px，增量方式兼容拖拽改位）

    // 状态：呼吸/眨眼/口型
    this._breathPhase = 0;        // 0~1
    this._nextBlinkAt = Date.now() + this._randBlinkDelay();
    this._blinkEnd = 0;           // 眨眼结束时间戳（0=未在眨眼）
    this._speaking = false;
    this._speakEnd = 0;
    this._baseScale = 1;          // fit 计算的基准
    this._userScale = 1;          // 用户缩放
    this._flipped = false;
    this._tapPulseUntil = 0;      // 点击脉冲结束时间

    // 命中/拖拽
    this._hitCallbacks = [];
    this._draggable = false;
    this._dragging = false;
    this._dragStart = null;       // {clientX, clientY, spriteX, spriteY}
    this._dragBound = false;
    this._resizeObserver = null;

    // 鼠标跟随（"数字人看着你"）：最新鼠标位置 + lerp 平滑的视差偏移
    this._mouseFollow = opts.mouseFollow !== false; // 默认开
    this._mouse = null;           // {x, y} 最近一次 mousemove 的窗口内坐标
    this._mouseAt = 0;            // 最近 mousemove 时间戳（超时回中）
    this._followX = 0;            // 当前视差偏移（px，lerp 平滑值）
    this._followY = 0;
    this._followRot = 0;          // 朝鼠标微倾（rad）
    this._baseX = 0;              // 无视差时的基准位置（fit/拖拽维护）
    this._baseY = 0;
    // 豆宝宝式漫游系统：全屏底部站立+自主走动+弹跳+拖拽掉落
    this._roam = {
      enabled: true, state: 'stand', targetX: 0, speed: 130,
      standUntil: Date.now() + 4000, bouncePhase: 0, bounce: 0, rot: 0, vy: 0,
    };
    this._roamPlaced = false;
    this._groundY = 0;
    this._hovering = false;
    this._followIdleMs = typeof opts.followIdleMs === 'number' ? opts.followIdleMs : 1500;

    // PetEvents 监听
    this._evBound = {
      emotion: ({ emotion } = {}) => {
        if (typeof emotion === 'string') this.setEmotion(emotion);
      },
    };
    // window 级 mousemove（rAF 节流由 ticker 消费实现：仅记录，逐帧计算）
    this._onGlobalMouseMove = (e) => {
      this._mouse = { x: e.clientX, y: e.clientY };
      this._mouseAt = Date.now();
    };
  }

  // ============================================================
  // 初始化
  // ============================================================

  /**
   * 初始化：创建 PIXI Application、绑定事件、订阅 PetEvents
   * @param {HTMLElement|string} container DOM 容器或选择器
   * @returns {Promise<this>}
   */
  async init(container) {
    const PIXI = window.PIXI;
    if (!PIXI) throw new Error('[SpriteRenderer] window.PIXI 不存在，请先加载 pixi.min.js');

    this.container = typeof container === 'string'
      ? document.querySelector(container)
      : container;
    if (!this.container) throw new Error('[SpriteRenderer] 容器不存在: ' + container);

    this.app = new PIXI.Application({
      transparent: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      resizeTo: this.container,
      antialias: true,
      forceCanvas: true, // 透明窗口下WebGL合成不可靠，强制2D canvas渲染
    });
    this.app.view.style.position = 'absolute';
    this.app.view.style.inset = '0';
    this.container.appendChild(this.app.view);

    try {
      // 主循环驱动呼吸/眨眼/口型
      this.app.ticker.add(() => this._tick());
      // 容器尺寸变化时重新适配
      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(() => {
          if (!this._dragging) this._fitToContainer();
        });
        this._resizeObserver.observe(this.container);
      }
      // 订阅全局情绪事件
      const ev = window.PetEvents;
      if (ev && typeof ev.on === 'function') {
        ev.on('emotion:change', this._evBound.emotion);
      }
      // 鼠标跟随：window 级 mousemove（计算在 ticker 内做，天然 rAF 节流）
      window.addEventListener('mousemove', this._onGlobalMouseMove);
    } catch (err) {
      this._destroyed = true;
      try { if (this.app) this.app.destroy(true); } catch (e) { /* ignore */ }
      this.app = null;
      if (this.container) this.container.innerHTML = '';
      throw new Error('[SpriteRenderer] 初始化失败: ' + (err && err.message ? err.message : err));
    }
    return this;
  }

  /**
   * 切换角色：加载指定角色的所有情绪资源（首次或切换时调用）
   * 内置角色（handsome/beauty）→ assets/characters/{id}/ 6 情绪帧；
   * 用户角色（CharacterManager 注册，uc_* 前缀）→ 经 IPC 读 normal.png 单图，
   * 其余情绪走程序化滤镜（EMOTION_FILTERS）。
   * @param {string} id 内置角色 id 或用户角色 id
   * @returns {Promise<this>}
   */
  async setCharacter(id) {
    if (this._destroyed) throw new Error('[SpriteRenderer] 已销毁');
    const PIXI = window.PIXI;

    // 1) 解析角色信息：内置 → 帧模式；用户 → manager.resolve 单图模式
    let info;
    if (CHARACTERS[id]) {
      info = { ...CHARACTERS[id], mode: 'frames' };
    } else if (this.characters) {
      info = await this.characters.resolve(id);
    }
    if (!info) throw new Error('[SpriteRenderer] 未知角色: ' + id);

    this._singleImage = info.mode === 'single';
    this._currentEmotion = 'normal';
    this._emotionOffsetApplied = 0;

    // 2) 加载新纹理到临时容器（加载完成后再销毁旧纹理并替换，避免渲染中引用已销毁纹理）
    const newTextures = {};
    const newRaw = {};
    if (this._singleImage) {
      // 用户角色：单图（normal），data URL 加载 → chroma key → 纹理
      const dataUrl = 'data:image/png;base64,' + info.imageBase64;
      const rawCanvas = await this._loadImageToCanvas(dataUrl);
      newRaw.normal = rawCanvas;
      newTextures.normal = PIXI.Texture.from(this._chromaKeyCanvas(rawCanvas));
    } else {
      const baseDir = info.dir;
      for (const emo of EMOTION_FRAMES) {
        const url = `${baseDir}/${emo}.png`;
        // 用 fetch+blob 走 file:// 协议；Electron file:// 下 PIXI.BaseTexture.fromURL 也能直接用
        const rawCanvas = await this._loadImageToCanvas(url);
        newRaw[emo] = rawCanvas;
        newTextures[emo] = PIXI.Texture.from(this._chromaKeyCanvas(rawCanvas));
      }
    }

    // 3) 加载成功：销毁旧角色纹理，替换为新纹理
    for (const t of Object.values(this._textures)) {
      try { t.destroy(true); } catch (e) { /* ignore */ }
    }
    this._textures = newTextures;
    this._rawCanvases = newRaw;
    this.characterId = id;
    this.characterInfo = info;

    // 4) 首次：创建主 sprite + 椭圆遮罩；切换：更新纹理/遮罩/滤镜并重新适配
    if (!this._sprite) {
      this._sprite = new PIXI.Sprite(this._textures[this._currentEmotion] || this._textures.normal);
      this._sprite.anchor.set(0.5, 0.5);
      this._sprite.interactive = true;
      this._sprite.cursor = 'pointer';
      this._sprite.on('pointertap', (e) => this._handleTap(e));
      // 椭圆遮罩：把人物外围背景都遮掉（写实图渐变+阴影色度法不完美，用mask兜底）
      const mask = new PIXI.Graphics();
      this._mask = mask;
      this._updateMask();
      this._sprite.mask = mask;
      this.app.stage.addChild(mask);
      this.app.stage.addChild(this._sprite);
    } else {
      this._sprite.texture = this._textures[this._currentEmotion] || this._textures.normal;
      this._updateMask();
    }
    this._applyEmotionProgram(this._currentEmotion);
    // 切角色时重置 sway rotation 残留（excited 的 ±0.035rad）
    if (this._sprite) this._sprite.rotation = 0;
    this._fitToContainer();
    return this;
  }

  /** 按当前纹理尺寸重建椭圆遮罩（切换角色后纹理尺寸变化时调用） */
  _updateMask() {
    if (!this._mask || !this._sprite) return;
    const m = this._sprite.texture.baseTexture;
    const mw = m.width, mh = m.height;
    this._mask.clear();
    this._mask.beginFill(0xffffff);
    // 椭圆：中心居中，覆盖 trim 后的实际人物范围
    this._mask.drawEllipse(mw / 2, mh / 2, mw * 0.45, mh * 0.46);
    this._mask.endFill();
  }

  /**
   * 单图角色：应用情绪的程序化近似（ColorMatrixFilter + 变换参数由 _tick 合成）
   * normal 清除滤镜；多帧角色此方法无操作。
   */
  _applyEmotionProgram(emotion) {
    if (!this._sprite) return;
    // 多帧角色：确保滤镜清空（防止 single→frames 切换后滤镜残留）
    if (!this._singleImage) {
      this._sprite.filters = null;
      return;
    }
    const PIXI = window.PIXI;
    const fx = EMOTION_FILTERS[emotion] || {};
    if (!fx.brightness && !fx.saturation) {
      this._sprite.filters = null;
      return;
    }
    try {
      const filter = new PIXI.ColorMatrixFilter();
      filter.reset();
      if (fx.brightness) filter.brightness(fx.brightness, false);
      if (fx.saturation) filter.saturate(fx.saturation, !!fx.brightness);
      this._sprite.filters = [filter];
    } catch (err) {
      console.warn('[SpriteRenderer] 情绪滤镜应用失败（忽略）：', err);
      this._sprite.filters = null;
    }
  }

  // ============================================================
  // 对外 API（与 Live2DRenderer 同名同语义）
  // ============================================================

  /**
   * 播放动作：保持原 Live2D 接口签名。
   * 'TapBody' 触发一次"轻拍"缩放脉冲（与摸头/点击的视觉反馈对齐）。
   * 'Idle' 视为无操作（呼吸/眨眼循环已在主循环中）。
   * @param {string} group
   * @param {number} [index]
   * @returns {boolean}
   */
  playMotion(group, index) {
    if (this._destroyed) return false;
    if (group === 'TapBody' || group === 'tap' || group === 'pat') {
      // 触发一次轻拍脉冲
      this._tapPulseUntil = Date.now() + 600;
      return true;
    }
    // 'Idle' 或其他命名 → 视作已接收（兼容原契约）
    return true;
  }

  /**
   * 表情：写实立绘不切换表情参数；setEmotion 才是真正换纹理。
   * 此方法保留供兼容。
   * @param {string} _name
   * @returns {boolean}
   */
  playExpression(_name) {
    return false;
  }

  /**
   * 设置情绪：多帧角色切换 sprite 纹理（cross-fade 过渡）；
   * 单图角色（用户角色）不换纹理，改用程序化滤镜+变换近似。
   * 通常由 PetEvents 'emotion:change' 事件自动驱动。
   * @param {string} emotion
   */
  setEmotion(emotion) {
    if (this._destroyed) return false;
    if (this._singleImage) {
      if (!EMOTION_FRAMES.includes(emotion)) return false;
      if (emotion === this._currentEmotion && this._sprite) return true;
      this._currentEmotion = emotion;
      this._applyEmotionProgram(emotion);
      return true;
    }
    if (!this._textures[emotion]) return false;
    if (emotion === this._currentEmotion && this._sprite) return true;
    this._currentEmotion = emotion;
    if (!this._sprite) return true;

    const PIXI = window.PIXI;
    const oldSprite = this._sprite;
    const newSprite = new PIXI.Sprite(this._textures[emotion]);
    newSprite.anchor.set(0.5, 0.5);
    newSprite.alpha = 0;
    // 复制变换（保持居中/缩放/翻转）
    newSprite.position.copyFrom(oldSprite.position);
    newSprite.scale.copyFrom(oldSprite.scale);
    if (oldSprite.scale.x < 0) newSprite.scale.x = -newSprite.scale.x;
    this.app.stage.addChild(newSprite);
    // 椭圆遮罩应用到新 sprite（按新纹理尺寸重建）
    newSprite.mask = this._mask;
    this._updateMask();
    this._sprite = newSprite;
    this._fadeSprite = oldSprite;
    // 重绑交互到新 sprite
    newSprite.interactive = true;
    newSprite.cursor = 'pointer';
    newSprite.on('pointertap', (e) => this._handleTap(e));
    // 拖拽监听重绑：先解绑（移除 window 监听 + 置 _dragBound=false）再绑到新 sprite
    // 否则 pointerdown 留在将被销毁的 oldSprite 上，情绪切换后拖拽失效
    this._unbindDragEvents();
    this._bindDragEvents();
    this._bindHoverForward(); // 全屏穿透窗口的hover检测

    const start = performance.now();
    const dur = this.config.fadeMs;
    const tickFade = () => {
      if (this._destroyed) return;
      const t = (performance.now() - start) / dur;
      if (t >= 1) {
        newSprite.alpha = 1;
        if (this._fadeSprite) {
          try { this.app.stage.removeChild(this._fadeSprite); } catch (e) { /* ignore */ }
          this._fadeSprite.destroy();
          this._fadeSprite = null;
        }
        return;
      }
      newSprite.alpha = t;
      if (this._fadeSprite) this._fadeSprite.alpha = 1 - t;
      requestAnimationFrame(tickFade);
    };
    requestAnimationFrame(tickFade);
    return true;
  }

  /**
   * 说话口型：周期内 sprite 缩放 + 饱和度脉冲（程序化模拟，无真口型图）
   * @param {number} duration 毫秒
   */
  lipSpeak(duration = 2000) {
    if (this._destroyed || !this._sprite) return;
    this._speaking = true;
    this._speakEnd = Date.now() + Math.max(200, duration);
  }

  /**
   * 注册点击命中回调
   * @param {function} callback (hitAreaNames, event) => void
   */
  onHit(callback) {
    if (typeof callback === 'function') this._hitCallbacks.push(callback);
  }

  /**
   * DOM 坐标命中检测
   * @returns {string[]} 命中的区域名（写实立绘不分区，统一返回 ['body']）
   */
  hitTest(clientX, clientY) {
    if (!this._sprite || !this.app) return [];
    const rect = this.app.view.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    // 简化：以 sprite 的不透明像素（alpha>0）作为命中范围
    if (this._containsOpaquePixel(x, y)) return ['body'];
    return [];
  }

  /** 开关拖拽支持 */
  setDraggable(enabled) {
    this._draggable = !!enabled;
    if (this._draggable) this._bindDragEvents();
    else this._unbindDragEvents();
  }
  isDraggable() { return !!this._draggable; }

  /** 设置额外缩放系数（1 为基准） */
  setScale(s) {
    this._userScale = Math.max(0.1, Math.min(4, Number(s) || 1));
    this._applyTransform();
  }
  /** 水平翻转切换 */
  flipX() {
    this._flipped = !this._flipped;
    this._applyTransform();
    return this._flipped;
  }
  setFlipX(flipped) {
    if (this._flipped === !!flipped) return;
    this.flipX();
  }

  /** 视线跟随：写实立绘用整体水平/垂直微倾斜模拟（±5°） */
  lookAt(x, y) {
    if (!this._sprite) return;
    const rect = this.app.view.getBoundingClientRect();
    const cx = rect.width / 2;
    const dx = (x - cx) / Math.max(1, rect.width);
    this._sprite.rotation = Math.max(-0.08, Math.min(0.08, dx * 0.1));
  }

  /**
   * 鼠标跟随开关（"数字人看着你"的视差跟随）
   * 关闭后偏移量会平滑回零；拖拽中自动暂停跟随。
   * @param {boolean} enabled
   */
  setMouseFollow(enabled) {
    this._mouseFollow = !!enabled;
    return this._mouseFollow;
  }
  isMouseFollowEnabled() { return !!this._mouseFollow; }

  /** 获取模型信息（调试用） */
  getModelInfo() {
    return {
      character: this.characterId,
      name: this.characterInfo && this.characterInfo.name,
      motionGroups: ['pose'],
      expressions: EMOTION_FRAMES.slice(),
      hitAreas: ['body'],
      size: this._sprite
        ? { width: this._sprite.texture.width, height: this._sprite.texture.height }
        : null,
    };
  }

  /** 销毁：清理 ticker、事件、PIXI 资源 */
  destroy() {
    this._destroyed = true;
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this._unbindDragEvents();
    window.removeEventListener('mousemove', this._onGlobalMouseMove);
    const ev = window.PetEvents;
    if (ev && typeof ev.off === 'function') {
      try { ev.off('emotion:change', this._evBound.emotion); } catch (e) { /* ignore */ }
    }
    // 销毁 sprite / fade sprite / mask
    try { if (this._fadeSprite) { this.app.stage.removeChild(this._fadeSprite); this._fadeSprite.destroy(); } } catch (e) { /* ignore */ }
    try { if (this._sprite) { this.app.stage.removeChild(this._sprite); this._sprite.destroy(); } } catch (e) { /* ignore */ }
    try { if (this._mask) { this.app.stage.removeChild(this._mask); this._mask.destroy(); } } catch (e) { /* ignore */ }
    this._fadeSprite = null;
    this._sprite = null;
    this._mask = null;
    // 销毁纹理
    for (const t of Object.values(this._textures)) {
      try { t.destroy(true); } catch (e) { /* ignore */ }
    }
    this._textures = {};
    this._rawCanvases = {};
    try { if (this.app) this.app.destroy(true); } catch (e) { /* ignore */ }
    this.app = null;
    this.container = null;
    this._hitCallbacks.length = 0;
  }

  // ============================================================
  // 内部：适配容器
  // ============================================================

  _fitToContainer() {
    if (!this._sprite || !this.container) return;
    const w = this.container.clientWidth || 400;
    const h = this.container.clientHeight || 500;
    const tw = this._sprite.texture.width || 1024;
    const th = this._sprite.texture.height || 1536;
    // 漫游模式：固定宠物高度（屏幕高32%上限420px），底部站立
    const targetH = Math.min(h * 0.26, 340); // 更精致小巧
    this._baseScale = targetH / th;
    this._applyTransform();
    const spriteH = th * this._baseScale * this._userScale;
    this._groundY = h - spriteH / 2 - 24; // 地面线（底部留24px）
    if (!this._roamPlaced) {
      this._roamPlaced = true;
      this._baseX = w * 0.72; // 初始站右下
      this._baseY = this._groundY;
    } else {
      this._baseY = Math.min(this._baseY, this._groundY); // 不低于地面
      if (this._roam.state !== 'fall') this._baseY = this._groundY;
    }
    this._sprite.position.set(this._baseX, this._baseY);
  }

  // ============================================================
  // 漫游状态机：stand(待机)→walk(走动)→stand；拖拽松手在空中→fall(重力掉落)
  // ============================================================

  _roamTick(deltaMS) {
    if (!this._roam || !this._roam.enabled || !this._sprite || this._dragging) { return; }
    const now = Date.now();
    const w = (this.container && this.container.clientWidth) || window.innerWidth || 1200;
    const sw = Math.abs(this._sprite.width) || 200;
    const minX = sw / 2 + 16, maxX = w - sw / 2 - 16;
    const r = this._roam;
    if (r.state === 'stand') {
      if (now >= r.standUntil) {
        r.targetX = minX + Math.random() * Math.max(50, (maxX - minX));
        if (Math.abs(r.targetX - this._baseX) < 100) {
          r.targetX = this._baseX + (Math.random() < 0.5 ? -1 : 1) * (150 + Math.random() * 250);
        }
        r.targetX = Math.max(minX, Math.min(maxX, r.targetX));
        r.state = 'walk';
        r.bouncePhase = 0;
        this._flipped = r.targetX < this._baseX; // 朝向行进方向
      }
    } else if (r.state === 'walk') {
      const dir = r.targetX > this._baseX ? 1 : -1;
      const step = (r.speed * deltaMS) / 1000;
      if (Math.abs(r.targetX - this._baseX) <= step) {
        this._baseX = r.targetX;
        r.state = 'stand';
        r.standUntil = now + 4000 + Math.random() * 9000;
        r.bounce = 0; r.rot = 0;
        this._flipped = false; // 回正
      } else {
        this._baseX += dir * step;
        r.bouncePhase += deltaMS / 95;
        r.bounce = Math.abs(Math.sin(r.bouncePhase)) * 11; // 走路弹跳
        r.rot = Math.sin(r.bouncePhase) * 0.045;           // 身体摇摆
      }
    } else if (r.state === 'fall') {
      r.vy += 2200 * deltaMS / 1000; // 重力
      this._baseY += r.vy * deltaMS / 1000;
      if (this._baseY >= this._groundY) {
        this._baseY = this._groundY;
        r.state = 'stand';
        r.standUntil = now + 2500 + Math.random() * 5000;
        r.vy = 0; r.bounce = 0; r.rot = 0;
      }
    }
  }

  // hover 检测：全屏穿透窗口下，鼠标在宠物包围盒内→取消穿透（可交互），离开→恢复穿透
  _bindHoverForward() {
    if (this._hoverBound) return;
    this._hoverBound = true;
    window.addEventListener('mousemove', (ev) => {
      if (!this._sprite) return;
      const sp = this._sprite;
      const halfW = Math.abs(sp.width) / 2;
      const halfH = Math.abs(sp.height) / 2;
      const inside = ev.clientX >= sp.x - halfW && ev.clientX <= sp.x + halfW
        && ev.clientY >= sp.y - halfH && ev.clientY <= sp.y + halfH;
      if (inside !== this._hovering) {
        this._hovering = inside;
        try {
          if (window.windowAPI && window.windowAPI.setIgnoreCursor) {
            window.windowAPI.setIgnoreCursor(!inside);
          }
        } catch (e) { /* 浏览器测试模式无windowAPI */ }
      }
    }, { passive: true });
  }

  _applyTransform() {
    if (!this._sprite) return;
    const s = this._baseScale * this._userScale;
    this._sprite.scale.set(this._flipped ? -s : s, s);
  }

  // ============================================================
  // 内部：主循环（呼吸/眨眼/口型/拖拽脉冲）
  // ============================================================

  _tick() {
    if (this._destroyed || !this._sprite) return;
    const now = Date.now();
    // 单图角色的情绪程序化变换参数（skill 第五节）
    const fx = this._singleImage ? (EMOTION_FILTERS[this._currentEmotion] || {}) : {};

    // 1) 呼吸：scale 0.98↔1.02，正弦缓动（sleepy 呼吸加深 breathMul）
    this._breathPhase += this.app.ticker.deltaMS / this.config.breathPeriodMs;
    if (this._breathPhase > 1) this._breathPhase -= 1;
    const breathAmp = this.config.breathAmplitude * (fx.breathMul || 1);
    const breathScale = 1 + Math.sin(this._breathPhase * Math.PI * 2) * breathAmp;

    // 2) 眨眼：定时 + 闭眼期间 scaleY 短脉冲
    let blinkScaleY = 1;
    if (now >= this._nextBlinkAt) {
      this._blinkEnd = now + this.config.blinkDurationMs;
      this._nextBlinkAt = now + this._randBlinkDelay();
    }
    if (this._blinkEnd > 0) {
      const remaining = this._blinkEnd - now;
      if (remaining <= 0) {
        this._blinkEnd = 0;
      } else {
        // 三段：闭(0.15 前) → 开(0.15 中) → 再闭
        const t = 1 - remaining / this.config.blinkDurationMs; // 0→1
        if (t < 0.5) blinkScaleY = 1 - t * 2 * 0.92;       // 1 → 0.08
        else blinkScaleY = 1 - (1 - t) * 2 * 0.92;          // 0.08 → 1
      }
    }

    // 3) 说话：scaleY 周期性脉冲
    let speakScaleY = 1;
    if (this._speaking && now < this._speakEnd) {
      const t = (now / 100) % 1;
      speakScaleY = 1 + Math.sin(t * Math.PI * 2) * 0.04;
    } else if (this._speaking) {
      this._speaking = false;
    }

    // 4) 轻拍脉冲：1.0 → 1.08 → 1.0（600ms）
    let tapScale = 1;
    if (now < this._tapPulseUntil) {
      const remain = (this._tapPulseUntil - now) / 600; // 0→1
      tapScale = 1 + Math.sin(remain * Math.PI) * 0.08;
    } else if (this._tapPulseUntil && now >= this._tapPulseUntil) {
      this._tapPulseUntil = 0;
    }

    // 合成最终缩放（基础 × 呼吸 × 眨眼 × 说话 × 轻拍 × 情绪缩放）
    const emoScale = fx.scale || 1;
    const baseS = this._baseScale * this._userScale;
    const sX = baseS * breathScale * tapScale * emoScale;
    const sY = baseS * breathScale * blinkScaleY * speakScaleY * tapScale * emoScale;
    this._sprite.scale.set(this._flipped ? -sX : sX, sY);

    // 单图角色情绪附加变换：sad 轻微下垂位移（量记入 _emotionOffsetApplied，随位置合成应用）
    if (this._singleImage) {
      const targetOffY = fx.offsetYRatio ? fx.offsetYRatio * (this._sprite.texture.height || 0) : 0;
      this._emotionOffsetApplied = targetOffY;
    }

    // 5) 漫游状态机（走动/掉落/弹跳）
    this._roamTick(this.app.ticker.deltaMS);

    // 5.5) 爱心粒子更新
    this._updateHearts(this.app.ticker.deltaMS);

    // 6) 鼠标跟随（视差 + 微倾，lerp 0.1 平滑）；拖拽/走动中暂停
    this._updateMouseFollow(now);
    this._sprite.x = this._baseX + this._followX;
    this._sprite.y = this._baseY + this._followY - (this._roam.bounce || 0) + (this._singleImage ? this._emotionOffsetApplied : 0);
    let rot = this._followRot + (this._roam.rot || 0);
    if (this._singleImage && fx.sway) rot += Math.sin(now / 240) * 0.035;
    this._sprite.rotation = rot;

    // 说话时给 sprite 加一个轻微的"色调脉动"（饱和度感）通过 tint 实现（轻微偏移白色）
    if (this._speaking && now < this._speakEnd) {
      const t = (now / 120) % 1;
      const v = 0.04 * Math.sin(t * Math.PI * 2);
      const tint = (1 + v) * 255;
      this._sprite.tint = (tint << 16) | (tint << 8) | tint;
    } else {
      this._sprite.tint = 0xffffff;
    }
  }

  _randBlinkDelay() {
    const { blinkMinMs, blinkMaxMs } = this.config;
    return blinkMinMs + Math.random() * (blinkMaxMs - blinkMinMs);
  }

  /**
   * 鼠标跟随：鼠标相对窗口中心的偏移 → 人物视差偏移 + 朝鼠标微倾
   *   偏移 (x*0.03, y*0.02)，旋转 ≈ 归一化 x * 0.01
   *   lerp 0.1/帧 平滑；拖拽中暂停；长时间无鼠标移动回中；开关关闭后回零
   */
  _updateMouseFollow(now) {
    const LERP = 0.1;
    let targetX = 0;
    let targetY = 0;
    let targetRot = 0;
    const active = this._mouseFollow && !this._dragging
      && this._mouse && (now - this._mouseAt) < this._followIdleMs;
    if (active) {
      const w = window.innerWidth || (this.container && this.container.clientWidth) || 400;
      const h = window.innerHeight || (this.container && this.container.clientHeight) || 500;
      const cx = w / 2;
      const cy = h / 2;
      const dx = this._mouse.x - cx;
      const dy = this._mouse.y - cy;
      const nx = Math.max(-1, Math.min(1, dx / Math.max(1, cx))); // 归一化 -1~1
      targetX = dx * 0.03;       // 视差水平偏移
      targetY = dy * 0.02;       // 视差垂直偏移
      targetRot = nx * 0.01 * 4; // 朝鼠标微倾（≈±0.04rad）
    }
    this._followX += (targetX - this._followX) * LERP;
    this._followY += (targetY - this._followY) * LERP;
    this._followRot += (targetRot - this._followRot) * LERP;
  }

  // ============================================================
  // 内部：命中/拖拽
  // ============================================================

  _handleTap(e) {
    if (this._dragging) return;
    const areas = ['body']; // 写实立绘不分区
    for (const cb of this._hitCallbacks) {
      try { cb(areas, e); } catch (err) { console.error('[SpriteRenderer] onHit 回调异常', err); }
    }
    // 触发一次轻拍脉冲
    this._tapPulseUntil = Date.now() + 600;
    // 表情联动：点按→happy 2.2s 后回 normal
    if (this._currentEmotion === 'normal' || this._currentEmotion === 'happy') {
      try { this.setEmotion('happy'); } catch (err) { /* 无happy纹理则忽略 */ }
      clearTimeout(this._tapEmoTimer);
      this._tapEmoTimer = setTimeout(() => {
        try { if (this._currentEmotion === 'happy') this.setEmotion('normal'); } catch (err) { /* ignore */ }
      }, 2200);
    }
    // 爱心粒子
    this._spawnHearts(4);
  }

  // ============================================================
  // 爱心粒子：点按互动时从头顶冒出，上浮+左右摇+淡出
  // ============================================================

  _spawnHearts(count) {
    if (!this._sprite) return;
    if (!this._hearts) {
      this._hearts = [];
      // 心形纹理：canvas 2D 绘制（CanvasRenderer 下最稳）
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ff5e8e';
      ctx.beginPath();
      ctx.arc(10, 11, 7, 0, Math.PI * 2);
      ctx.arc(22, 11, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(3.5, 14);
      ctx.lineTo(16, 29);
      ctx.lineTo(28.5, 14);
      ctx.closePath();
      ctx.fill();
      this._heartTex = PIXI.Texture.from(c);
    }
    const baseX = this._sprite.x;
    const baseY = this._sprite.y - Math.abs(this._sprite.height) / 2 + 20;
    for (let i = 0; i < (count || 4); i++) {
      const sp = new PIXI.Sprite(this._heartTex);
      sp.anchor.set(0.5);
      sp.scale.set(0.55 + Math.random() * 0.45);
      sp.x = baseX + (Math.random() - 0.5) * 70;
      sp.y = baseY + Math.random() * 18;
      sp.alpha = 0.95;
      if (this._sprite.parent) this._sprite.parent.addChild(sp);
      this._hearts.push({
        sp, born: Date.now(),
        life: 1400 + Math.random() * 600,
        vy: -(38 + Math.random() * 30),       // 上浮速度 px/s
        swayAmp: 14 + Math.random() * 12,     // 左右摆幅
        swayFreq: 2 + Math.random() * 2,
        x0: sp.x,
      });
    }
  }

  _updateHearts(deltaMS) {
    if (!this._hearts || !this._hearts.length) return;
    const now = Date.now();
    for (let i = this._hearts.length - 1; i >= 0; i--) {
      const h = this._hearts[i];
      const t = (now - h.born) / h.life;
      if (t >= 1) {
        if (h.sp.parent) h.sp.parent.removeChild(h.sp);
        h.sp.destroy();
        this._hearts.splice(i, 1);
        continue;
      }
      const dt = deltaMS / 1000;
      h.sp.y += h.vy * dt;
      h.sp.x = h.x0 + Math.sin((now / 1000) * h.swayFreq * Math.PI * 2 + i) * h.swayAmp;
      h.sp.alpha = 0.95 * (1 - t);
      h.sp.rotation = Math.sin((now / 1000) * h.swayFreq + i) * 0.25;
    }
  }

  _bindDragEvents() {
    if (this._dragBound || !this._sprite) return;
    this._dragBound = true;
    const sprite = this._sprite;
    this._onGrabDown = (e) => {
      if (!this._draggable) return;
      this._dragging = true;
      // 拖拽表情：兴奋/开心
      try { if (this._currentEmotion === 'normal') this.setEmotion('excited'); } catch (err) { /* ignore */ }
      this._dragStart = {
        clientX: e.client ? e.client.x : e.data?.originalEvent?.clientX,
        clientY: e.client ? e.client.y : e.data?.originalEvent?.clientY,
        spriteX: this._baseX, // 记录基准位（不含视差偏移），拖拽后由 _tick 统一叠加
        spriteY: this._baseY,
      };
      this.app.view.style.cursor = 'grabbing';
    };
    this._onDomMove = (ev) => {
      if (!this._dragging || !this._dragStart) return;
      // 全屏漫游模式：直接拖动宠物位置（窗口不动）
      const dx = ev.clientX - this._dragStart.clientX;
      const dy = ev.clientY - this._dragStart.clientY;
      this._baseX = this._dragStart.spriteX + dx;
      this._baseY = this._dragStart.spriteY + dy;
    };
    this._onDomUp = () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._dragStart = null;
      this.app.view.style.cursor = 'default';
      // 松手：在空中→重力掉落；在地面→贴地站立
      if (this._roam && this._baseY < this._groundY - 6) {
        this._roam.state = 'fall';
        this._roam.vy = 0;
      } else if (this._roam) {
        this._baseY = this._groundY;
        this._roam.state = 'stand';
        this._roam.standUntil = Date.now() + 3000 + Math.random() * 6000;
      }
      // 松手回 normal（拖拽时是 excited）
      clearTimeout(this._dragEmoTimer);
      this._dragEmoTimer = setTimeout(() => {
        try { this.setEmotion('normal'); } catch (err) { /* ignore */ }
      }, 1200);
    };
    sprite.on('pointerdown', this._onGrabDown);
    window.addEventListener('mousemove', this._onDomMove);
    window.addEventListener('mouseup', this._onDomUp);
  }

  _unbindDragEvents() {
    if (!this._dragBound) return;
    this._dragBound = false;
    if (this._sprite) {
      try { this._sprite.off('pointerdown', this._onGrabDown); } catch (e) { /* ignore */ }
    }
    window.removeEventListener('mousemove', this._onDomMove);
    window.removeEventListener('mouseup', this._onDomUp);
  }

  // ============================================================
  // 内部：chroma key 抠图
  // ============================================================

  /**
   * 加载图片到 canvas（不透明原图）
   * @param {string} url
   * @returns {Promise<HTMLCanvasElement>}
   */
  async _loadImageToCanvas(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // 注意：file:// 协议下设置 crossOrigin='anonymous' 会导致 CORS 失败、图片加载卡住
      // 我们的资源都是 file://（Electron 加载本地文件），无需 CORS，仅 http(s) 跨域时才需要
      if (/^https?:\/\//.test(url) && !url.startsWith(location.origin)) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve(canvas);
      };
      img.onerror = (err) => reject(new Error('[SpriteRenderer] 图片加载失败: ' + url));
      img.src = url;
    });
  }

  /**
   * 采样四角取背景色参考（取 4 个 5x5 patch 的均值，更稳）
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @returns {{r:number, g:number, b:number}}
   */
  _sampleBackground(ctx, w, h) {
    const patch = 5;
    const corners = [
      [0, 0], [w - patch, 0], [0, h - patch], [w - patch, h - patch],
    ];
    let r = 0, g = 0, b = 0, n = 0;
    for (const [x, y] of corners) {
      const data = ctx.getImageData(x, y, patch, patch).data;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2];
        n += 1;
      }
    }
    return { r: r / n, g: g / n, b: b / n };
  }

  /**
   * chroma key：把灰色背景扣成透明，边缘软过渡
   * @param {HTMLCanvasElement} src
   * @returns {HTMLCanvasElement} 新的已抠图 canvas（带 alpha）
   */
  _chromaKeyCanvas(src) {
    const w = src.width;
    const h = src.height;
    const sCtx = src.getContext('2d', { willReadFrequently: true });
    const imgData = sCtx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const N = w * h;

    // floodfill 去背景：从四边种子点BFS，连通的"背景相似色"区域置透明
    // 优点：渐变背景（浅→深灰）整片去掉；人物内部浅色（白衬衫）因不连通而保留
    const visited = new Uint8Array(N);
    const queue = new Int32Array(N);
    let qHead = 0, qTail = 0;
    const TOL = 46; // 与种子色的容差（RGB欧氏距离平方阈值内视为背景）
    const seedColor = (idx) => {
      const r = data[idx * 4], g = data[idx * 4 + 1], b = data[idx * 4 + 2];
      return [r, g, b];
    };
    const trySeed = (x, y) => {
      const i = y * w + x;
      if (!visited[i]) { visited[i] = 1; queue[qTail++] = i; }
    };
    // 四边全部作为种子（背景从四周包围人物）
    for (let x = 0; x < w; x++) { trySeed(x, 0); trySeed(x, h - 1); }
    for (let y = 0; y < h; y++) { trySeed(0, y); trySeed(w - 1, y); }
    // 种子平均色作为背景基准
    let sr = 0, sg = 0, sb = 0, sc = 0;
    for (let i = 0; i < qTail; i++) {
      const idx = queue[i];
      sr += data[idx * 4]; sg += data[idx * 4 + 1]; sb += data[idx * 4 + 2]; sc++;
    }
    if (sc > 0) { sr /= sc; sg /= sc; sb /= sc; }
    const bgR = sr, bgG = sg, bgB = sb;
    while (qHead < qTail) {
      const i = queue[qHead++];
      const pi = i * 4;
      const r = data[pi], g = data[pi + 1], b = data[pi + 2];
      const dr = r - bgR, dg = g - bgG, db = b - bgB;
      const dist2 = dr * dr + dg * dg + db * db;
      if (dist2 > TOL * TOL * 3) continue; // 与背景色差异大：不是背景，停止扩散
      data[pi + 3] = 0; // 置透明
      const x = i % w, y = (i / w) | 0;
      // 四邻域扩散
      if (x > 0 && !visited[i - 1]) { visited[i - 1] = 1; queue[qTail++] = i - 1; }
      if (x < w - 1 && !visited[i + 1]) { visited[i + 1] = 1; queue[qTail++] = i + 1; }
      if (y > 0 && !visited[i - w]) { visited[i - w] = 1; queue[qTail++] = i - w; }
      if (y < h - 1 && !visited[i + w]) { visited[i + w] = 1; queue[qTail++] = i + w; }
    }

    // Post-trim
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) {
      const empty = document.createElement('canvas');
      empty.width = 1; empty.height = 1;
      return empty;
    }
    const tw = maxX - minX + 1, th = maxY - minY + 1;
    const newImgData = new ImageData(tw, th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const srcIdx = ((y + minY) * w + (x + minX)) * 4;
        const dstIdx = (y * tw + x) * 4;
        newImgData.data[dstIdx] = data[srcIdx];
        newImgData.data[dstIdx + 1] = data[srcIdx + 1];
        newImgData.data[dstIdx + 2] = data[srcIdx + 2];
        newImgData.data[dstIdx + 3] = data[srcIdx + 3];
      }
    }
    const out = document.createElement('canvas');
    out.width = tw; out.height = th;
    out.getContext('2d').putImageData(newImgData, 0, 0);
    return out;
  }

  /**
   * 简易命中检测：采样 sprite 像素的 alpha（不依赖精确 hitTest，原生 PIXI 不支持）
   * 对 1024x1536 图片每次检测逐像素代价过大；实际场景拖拽/双击多发生在容器内，
   * 简单判定：sprite 的不透明区域作为命中范围（透明像素也算外）。
   */
  _containsOpaquePixel(globalX, globalY) {
    if (!this._sprite) return false;
    // 用 sprite 自身的 bounds（考虑 anchor/位置/缩放）做粗筛
    const w = this._sprite.width;
    const h = this._sprite.height;
    const lx = this._sprite.x - w / 2;
    const ly = this._sprite.y - h / 2;
    if (globalX < lx || globalX > lx + w || globalY < ly || globalY > ly + h) return false;
    // 中心区命中（按经验：chroma key 后人物大致在中央 60% 区域）
    const margin = 0.2;
    return globalX > lx + w * margin
        && globalX < lx + w * (1 - margin)
        && globalY > ly + h * margin
        && globalY < ly + h * (1 - margin);
  }
}

export default SpriteRenderer;
export { SpriteRenderer, CHARACTERS, EMOTION_FRAMES };
