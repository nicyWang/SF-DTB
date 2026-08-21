/**
 * live2d.js — Live2D 渲染模块 [frontend]
 * 基于 pixi.js@6.x + pixi-live2d-display@0.4.x（Cubism 4）
 *
 * 依赖加载方式（宿主页面需先按顺序加载以下脚本，本模块从全局取用）：
 *   1. node_modules/pixi.js/dist/browser/pixi.min.js        → window.PIXI
 *   2. src/assets/libs/live2dcubismcore.min.js               → window.Live2DCubismCore
 *   3. node_modules/pixi-live2d-display/dist/cubism4.min.js → window.PIXI.live2d
 *
 * 用法：
 *   const renderer = new Live2DRenderer();
 *   await renderer.init(container, './assets/models/hiyori/Hiyori.model3.json');
 *   renderer.playMotion('TapBody', 0);
 *   renderer.onHit((hitArea) => { ... });
 */

// 空闲时随机播放 idle 动作的间隔（毫秒）
const IDLE_MOTION_INTERVAL = 8000;

export class Live2DRenderer {
  constructor() {
    this.app = null;          // PIXI.Application
    this.model = null;        // Live2DModel 实例
    this.container = null;    // 挂载的 DOM 容器
    this.modelPath = null;

    this._hitCallbacks = [];       // 点击命中回调列表
    this._draggable = false;       // 是否允许拖拽
    this._dragging = false;        // 当前是否正在拖拽
    this._dragStart = null;        // 拖拽起点 {x, y, modelX, modelY}
    this._idleTimer = null;        // 空闲动作定时器
    this._idleExemptUntil = 0;     // 该时间戳之前不触发 idle（主动作豁免期）
    this._baseScale = 1;           // fit 计算出的基准缩放
    this._userScale = 1;           // 用户额外缩放系数
    this._flipped = false;         // 水平翻转状态
    this._destroyed = false;
    this._dragBound = false;
  }

  /**
   * 初始化：创建 PIXI Application、加载模型、适配容器尺寸
   * @param {HTMLElement|string} container DOM 容器或选择器
   * @param {string} modelPath model3.json 路径
   */
  async init(container, modelPath) {
    const PIXI = window.PIXI;
    if (!PIXI) throw new Error('[Live2DRenderer] window.PIXI 不存在，请先加载 pixi.min.js');
    if (!PIXI.live2d) throw new Error('[Live2DRenderer] window.PIXI.live2d 不存在，请先加载 cubism4.min.js');
    if (!window.Live2DCubismCore) throw new Error('[Live2DRenderer] window.Live2DCubismCore 不存在，请先加载 live2dcubismcore.min.js');

    this.container = typeof container === 'string'
      ? document.querySelector(container)
      : container;
    if (!this.container) throw new Error('[Live2DRenderer] 容器不存在: ' + container);
    this.modelPath = modelPath;

    // 透明背景，自动跟随容器尺寸
    // forceCanvas: 透明窗口下 WebGL 合成不可靠（GPU framebuffer 不输出），
    // 强制 2D CanvasRenderer 保证像素真正绘制
    this.app = new PIXI.Application({
      transparent: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      resizeTo: this.container,
      antialias: true,
      forceCanvas: true,
    });
    this.app.view.style.position = 'absolute';
    this.app.view.style.inset = '0';
    this.container.appendChild(this.app.view);

    // 核心初始化段：模型加载 → 舞台挂载 → 交互绑定。
    // 任一步抛错时清理已挂载的 app/视图，再抛出友好错误，避免残留半初始化状态。
    try {
      // 加载模型（autoInteract:false → 交互由本模块统一接管）
      const { Live2DModel } = PIXI.live2d;
      this.model = await Live2DModel.from(modelPath, { autoInteract: false });
      this.app.stage.addChild(this.model);

      // 缩放并居中适配容器
      this._fitToContainer();

      // 命中区域点击（模型级 tap）
      // PIXI v6 交互开关为 interactive；v7 起改为 eventMode='static'
      // （升级 pixi.js@7+ 时需同步替换本行为 eventMode 赋值）
      this.model.interactive = true;
      this.model.cursor = 'pointer';
      this.model.on('pointertap', (e) => this._handleTap(e));

      // 空闲动作循环
      this._startIdleLoop();

      // 容器尺寸变化时重新适配
      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObserver = new ResizeObserver(() => {
          if (!this._dragging) this._fitToContainer();
        });
        this._resizeObserver.observe(this.container);
      }
    } catch (err) {
      // 清理半初始化资源（app.view 已挂载到容器、定时器/observer 可能已创建）
      this._destroyed = true;
      if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
      if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
      try { if (this.model) this.model.destroy(); } catch (e) { /* 忽略二次异常 */ }
      try { if (this.app) this.app.destroy(true); } catch (e) { /* 忽略二次异常 */ }
      this.model = null;
      this.app = null;
      if (this.container) this.container.innerHTML = '';
      throw new Error(
        `[Live2DRenderer] 模型初始化失败（${modelPath}）: ${err && err.message ? err.message : err}`,
      );
    }

    return this;
  }

  /** 计算 baseScale 使模型适配容器，并保持居中 */
  _fitToContainer() {
    if (!this.model || !this.container) return;
    const w = this.container.clientWidth || 400;
    const h = this.container.clientHeight || 500;
    const im = this.model.internalModel;
    const mw = (im && im.originalWidth) || 200;
    const mh = (im && im.originalHeight) || 300;
    this._baseScale = Math.min(w / mw, h / mh);
    this._applyTransform();
    // 以中心锚点放置到容器中心
    this.model.anchor.set(0.5, 0.5);
    this.model.position.set(w / 2, h / 2);
  }

  /** 应用 缩放/翻转 组合变换 */
  _applyTransform() {
    if (!this.model) return;
    const s = this._baseScale * this._userScale;
    this.model.scale.set(this._flipped ? -s : s, s);
  }

  // ---------- 对外 API ----------

  /**
   * 播放指定动作组中的动作
   * @param {string} group 动作组名，如 'Idle' / 'TapBody'
   * @param {number} [index] 组内索引，缺省则随机
   * @returns {boolean} 同步返回是否成功（实际播放由内部异步完成）
   */
  playMotion(group, index) {
    if (!this.model) return false;
    const result = this.model.motion(group, index);
    // model.motion() 返回 Promise<boolean>；同步返回 Promise 解析后的真值评估
    if (result && typeof result.then === 'function') {
      result.then(ok => {
        if (ok) this._idleExemptUntil = Date.now() + 12000;
      }).catch(() => {});
      return true;
    }
    if (result) this._idleExemptUntil = Date.now() + 12000;
    return !!result;
  }

  /**
   * 播放表情。Hiyori 无表情文件，做容错：模型无表情时静默返回 false
   * @param {string} name 表情名
   */
  playExpression(name) {
    if (!this.model || typeof this.model.expression !== 'function') return false;
    try {
      this.model.expression(name);
      return true;
    } catch (e) {
      // Hiyori 无 exp3.json，表情不可用属预期情况
      console.warn('[Live2DRenderer] 表情不可用:', name, e.message);
      return false;
    }
  }

  /**
   * 注册点击命中回调（可多次注册）
   * @param {function} callback (hitAreaName, event) => void
   */
  onHit(callback) {
    if (typeof callback === 'function') this._hitCallbacks.push(callback);
  }

  _handleTap(e) {
    if (this._dragging) return; // 拖拽过程中的松开不算点击
    // 通过 hitTest 获取命中的区域名列表（Hiyori: ['Body']）
    let hitNames = [];
    try { hitNames = this.model.hitTest(e.global.x, e.global.y) || []; } catch (err) { /* 忽略 */ }
    this._idleExemptUntil = Date.now() + 4000; // 点击后短暂豁免 idle
    for (const cb of this._hitCallbacks) {
      try { cb(hitNames, e); } catch (err) { console.error('[Live2DRenderer] onHit 回调异常', err); }
    }
  }

  /** 开关拖拽支持 */
  setDraggable(enabled) {
    this._draggable = !!enabled;
    if (this._draggable) this._bindDragEvents();
    else this._unbindDragEvents();
  }

  _bindDragEvents() {
    if (this._dragBound || !this.model || !this.app) return;
    this._dragBound = true;
    // 抓取检测：模型上的 pointerdown（PIXI 事件，含命中判断）
    this._onGrabDown = (e) => {
      if (!this._draggable) return;
      const p = this.model.toLocal(e.global);
      const w = this.model.width, h = this.model.height;
      if (Math.abs(p.x) > w / 2 || Math.abs(p.y) > h / 2) return;
      this._dragging = true;
      this._dragStart = { x: e.client.x, y: e.client.y, modelX: this.model.x, modelY: this.model.y };
      this.app.view.style.cursor = 'grabbing';
    };
    // 移动/释放：DOM 级事件（screenX/Y 可驱动窗口移动，且鼠标移出画布仍有效）
    this._onDomMove = (ev) => {
      if (!this._dragging || !this._dragStart) return;
      if (window.windowAPI && typeof window.windowAPI.moveWindow === 'function') {
        // Electron：移动窗口本身（主进程按相邻 screenX/Y 增量移动）
        window.windowAPI.moveWindow(ev.screenX, ev.screenY);
      } else {
        // 浏览器测试（无 windowAPI）：本地移动模型
        const dx = ev.clientX - this._dragStart.x;
        const dy = ev.clientY - this._dragStart.y;
        this.model.x = this._dragStart.modelX + dx;
        this.model.y = this._dragStart.modelY + dy;
      }
    };
    this._onDomUp = () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._dragStart = null;
      this.app.view.style.cursor = 'default';
      if (window.windowAPI && typeof window.windowAPI.moveWindowEnd === 'function') {
        window.windowAPI.moveWindowEnd();
      }
    };
    this.model.on('pointerdown', this._onGrabDown);
    window.addEventListener('mousemove', this._onDomMove);
    window.addEventListener('mouseup', this._onDomUp);
  }

  _unbindDragEvents() {
    if (!this._dragBound) return;
    this._dragBound = false;
    if (this.model) this.model.off('pointerdown', this._onGrabDown);
    window.removeEventListener('mousemove', this._onDomMove);
    window.removeEventListener('mouseup', this._onDomUp);
  }

  /** 当前是否处于可拖拽状态 */
  isDraggable() {
    return !!this._draggable;
  }

  /**
   * DOM 坐标命中检测（供上层手势协调：长按/双击等）
   * @returns {string[]} 命中的区域名数组（如 ['Body']），空数组=未命中模型
   */
  hitTest(clientX, clientY) {
    if (!this.model || !this.app) return [];
    const rect = this.app.view.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    try { return this.model.hitTest(x, y) || []; } catch (e) { return []; }
  }

  /** 设置额外缩放系数（1 为基准，范围 0.1~4） */
  setScale(s) {
    this._userScale = Math.max(0.1, Math.min(4, Number(s) || 1));
    this._applyTransform();
  }

  /** 水平翻转切换，返回当前翻转状态 */
  flipX() {
    this._flipped = !this._flipped;
    this._applyTransform();
    return this._flipped;
  }

  /** 直接设置翻转状态 */
  setFlipX(flipped) {
    if (this._flipped === !!flipped) return;
    this.flipX();
  }

  /** 视线跟随（模型支持时）。x/y 为屏幕坐标 */
  lookAt(x, y) {
    if (!this.model || typeof this.model.focus !== 'function') return;
    this.model.focus(x, y);
  }

  /** 获取模型信息（调试用）：动作组、表情、命中区域、尺寸 */
  getModelInfo() {
    if (!this.model) return null;
    const im = this.model.internalModel;
    const motionManager = im && im.motionManager;
    const defs = (motionManager && motionManager.definitions) || {};
    const groups = Object.keys(defs);
    const expressions = (im && im.motionManager && im.motionManager.expressionManager
      && im.motionManager.expressionManager.expressions) || [];
    // hitAreas 为对象（键=区域名），做数组/对象双兼容
    const hitAreasRaw = (im && im.hitAreas) || {};
    const hitAreas = Array.isArray(hitAreasRaw)
      ? hitAreasRaw.map(h => h.name || h.id)
      : Object.keys(hitAreasRaw);
    return {
      path: this.modelPath,
      motionGroups: groups,
      motionCounts: Object.fromEntries(groups.map(g => [g, (defs[g] || []).length])),
      expressions: expressions.map(e => e.name || e.file),
      hitAreas,
      size: { width: im && im.originalWidth, height: im && im.originalHeight },
    };
  }

  /** 说话口型驱动（对接 speak:request 事件用），duration 毫秒 */
  lipSpeak(duration = 2000) {
    const coreModel = this.model && this.model.internalModel && this.model.internalModel.coreModel;
    if (!coreModel || typeof coreModel.setParameterValueById !== 'function') return;
    const start = performance.now();
    const tick = () => {
      const t = performance.now() - start;
      if (t > duration || this._destroyed) return;
      // 简单正弦口型开合
      const open = (Math.sin(t / 90) + 1) / 2 * 0.8;
      try {
        coreModel.setParameterValueById('ParamMouthOpenY', open);
      } catch (e) { /* 参数不存在则忽略 */ }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- 内部：空闲动作循环 ----------

  _startIdleLoop() {
    this._idleTimer = setInterval(() => {
      if (this._destroyed || this._dragging) return;
      if (Date.now() < this._idleExemptUntil) return; // 主动作豁免期内不播 idle
      if (this.model && this.model.motion) this.model.motion('Idle');
    }, IDLE_MOTION_INTERVAL);
  }

  /** 销毁：清理定时器、事件、PIXI 资源 */
  destroy() {
    this._destroyed = true;
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    this._unbindDragEvents();
    try { if (this.model) this.model.destroy(); } catch (e) { /* 已销毁则忽略 */ }
    try { if (this.app) this.app.destroy(true); } catch (e) { /* 已销毁则忽略 */ }
    // 置空全部引用：定时器id/observer/闭包回调均可能持有 model/app/container，
    // 释放后便于 GC 回收（否则实例虽死、闭包链仍阻止回收）
    this.model = null;
    this.app = null;
    this.container = null;
    this._dragStart = null;
    this._onGrabDown = null;
    this._onDomMove = null;
    this._onDomUp = null;
    this._hitCallbacks.length = 0;
  }
}

export default Live2DRenderer;
