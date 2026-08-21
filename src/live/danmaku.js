/**
 * DanmakuService — 弹幕服务（插件化架构）
 *
 * 职责：
 *  - 根据配置加载对应弹幕源（mock / douyin / ...），以插件形式解耦
 *  - 对外统一 emit 事件：'message' | 'gift' | 'enter' | 'follow' | 'status'
 *  - 统一错误处理：source 连接失败时 emit status 带 error，不向主程序抛异常
 *  - douyin 源连接失败时自动降级 fallback 到 mock 源，并 emit 通知
 *
 * 事件载荷（与 CONTRACT.md 对齐）：
 *  'message' {user, text}
 *  'gift'    {user, gift, count}
 *  'enter'   {user}
 *  'follow'  {user}
 *  'status'  {connected, source, error?, fallback?, fallbackFrom?}
 *
 * 若页面存在 window.PetEvents（preload 注入的全局事件总线），
 * 会自动转发为 danmaku:message / danmaku:gift / danmaku:enter / danmaku:follow。
 */

// ---------------------------------------------------------------------------
// 简易 EventEmitter（浏览器环境，无依赖）
// ---------------------------------------------------------------------------

export class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /** 注册监听器，返回 this 便于链式调用 */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  /** 注册一次性监听器 */
  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    wrapper._origin = fn;
    return this.on(event, wrapper);
  }

  /** 移除监听器；不传 fn 则移除该事件全部监听 */
  off(event, fn) {
    const set = this._listeners.get(event);
    if (!set) return this;
    if (!fn) {
      this._listeners.delete(event);
      return this;
    }
    for (const item of set) {
      if (item === fn || item._origin === fn) set.delete(item);
    }
    if (set.size === 0) this._listeners.delete(event);
    return this;
  }

  /** 触发事件；单个监听器抛错不影响其他监听器和主程序 */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        // 异步打印，避免 throw 中断分发
        setTimeout(() => {
          console.error(`[DanmakuService] listener error on "${event}":`, err);
        }, 0);
      }
    }
    return true;
  }

  /** 清空所有监听器 */
  removeAllListeners() {
    this._listeners.clear();
    return this;
  }
}

// ---------------------------------------------------------------------------
// 弹幕源注册表（插件化：新增源只需在此登记一个 loader）
// ---------------------------------------------------------------------------

const SOURCE_LOADERS = {
  mock: () => import('./sources/mock.js'),
  douyin: () => import('./sources/douyin.js'),
};

/** 需要转发给 source 的内部事件 */
const SOURCE_EVENTS = ['message', 'gift', 'enter', 'follow', 'status'];

// ---------------------------------------------------------------------------
// DanmakuService
// ---------------------------------------------------------------------------

export class DanmakuService extends EventEmitter {
  constructor(opts = {}) {
    super();
    /** 当前活跃的 source 实例 */
    this.source = null;
    /** 当前配置（含降级后的实际配置） */
    this.config = null;
    /** 实际连接的源类型（fallback 后可能不等于 config.type） */
    this.connectedType = null;

    /**
     * 主进程桥接函数（douyin 源需要）。
     * 签名: async bridge(action, payload) => any
     * 由外部（如集成层）通过 setBridge 注入，典型实现经 preload contextBridge
     * 转发到 Electron 主进程。详见 sources/douyin-protocol.md。
     */
    this._bridge = null;

    /** 是否向 window.PetEvents 转发事件 */
    this._relay = opts.relayToPetEvents !== false;
  }

  /**
   * 注入主进程桥接函数（douyin 源必需，mock 源忽略）。
   * @param {Function|null} fn async (action, payload) => any
   */
  setBridge(fn) {
    this._bridge = typeof fn === 'function' ? fn : null;
    if (this.source && typeof this.source.setBridge === 'function') {
      this.source.setBridge(this._bridge);
    }
  }

  /**
   * 连接弹幕源。
   * @param {object} sourceConfig
   *   {type:'mock', interval?, script?, loop?}            模拟源
   *   {type:'douyin', roomUrl, fallbackToMock?}           抖音源（需 bridge）
   * @returns {Promise<boolean>} 是否处于已连接状态（含降级成功）
   */
  async connect(sourceConfig) {
    const config = { ...sourceConfig };
    const type = config.type;

    // 已有连接则先断开
    await this.disconnect();

    if (!type || !SOURCE_LOADERS[type]) {
      const error = `unknown source type: ${type}`;
      this._emitStatus(false, type, error);
      return false;
    }

    try {
      await this._connectWith(type, config);
      return true;
    } catch (err) {
      const error = err && err.message ? err.message : String(err);
      this._emitStatus(false, type, error);

      // 抖音源失败 → 自动降级到 mock（可用 fallbackToMock:false 关闭）
      if (type === 'douyin' && config.fallbackToMock !== false) {
        try {
          await this._connectWith('mock', {
            type: 'mock',
            interval: config.interval,
            note: `fallback from douyin: ${error}`,
          });
          // 降级成功：补发通知（连接状态由 mock 源的 status 事件先行报告）
          this._emitStatus(true, 'mock', undefined, {
            fallback: true,
            fallbackFrom: 'douyin',
            error,
          });
          return true;
        } catch (fallbackErr) {
          this._emitStatus(false, 'mock', `fallback failed: ${fallbackErr.message}`);
          return false;
        }
      }
      return false;
    }
  }

  /**
   * 断开当前连接并清理 source 内部定时器/资源。
   */
  async disconnect() {
    if (!this.source) return;
    const src = this.source;
    this.source = null;
    this.connectedType = null;
    this.config = null;
    try {
      await src.stop();
    } catch (err) {
      console.error('[DanmakuService] error while stopping source:', err);
    }
    this._emitStatus(false, this.connectedType ?? src.type ?? 'unknown');
  }

  /** 当前是否已连接 */
  get connected() {
    return !!this.source && !!this.connectedType;
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  async _connectWith(type, config) {
    const mod = await SOURCE_LOADERS[type]();
    const SourceClass = mod.default;
    if (!SourceClass) throw new Error(`source module "${type}" has no default export`);

    const source = new SourceClass();
    // 转发 source 事件到 service，并同步到全局事件总线（若存在）
    for (const evt of SOURCE_EVENTS) {
      source.on(evt, (payload) => {
        // source 自行停止（如 mock 剧本播完、douyin 收到下播通知）时，
        // 同步复位连接状态，保证 connected/getter 与实际一致
        if (evt === 'status' && payload && payload.connected === false) {
          this.connectedType = null;
        }
        this.emit(evt, payload);
        this._relayToBus(`danmaku:${evt}`, payload);
      });
    }

    // douyin 等源需要 bridge
    if (typeof source.setBridge === 'function') {
      source.setBridge(this._bridge);
    }

    // start 可能 throw（如 douyin 缺 bridge）——交由上层统一处理
    await source.start(config);

    this.source = source;
    this.connectedType = type;
    this.config = config;
  }

  _emitStatus(connected, source, error, extra = {}) {
    const payload = { connected, source, ...extra };
    if (error) payload.error = error;
    this.emit('status', payload);
    this._relayToBus('danmaku:status', payload);
  }

  /** 转发到全局事件总线（若存在） */
  _relayToBus(name, payload) {
    if (!this._relay) return;
    const bus = typeof window !== 'undefined' && window.PetEvents;
    if (bus && typeof bus.emit === 'function') {
      bus.emit(name, payload);
    }
  }
}

export default DanmakuService;
