// ============================================================
// perception.js — 屏幕感知服务（截屏 → LLM视觉 → 场景识别）
// 运行环境：Electron 渲染进程（浏览器环境，ES module）
// 契约见 CONTRACT.md：class PerceptionService { start / stop / getStatus }
//
// 依赖注入（均可省略，缺省从 window/localStorage 解析，便于node测试）：
//   opts.llm        必填，LLMService实例（vision接口）
//   opts.memory     可选，MemoryService实例（场景长期记忆）
//   opts.events     可选，事件总线（缺省 window.PetEvents）
//   opts.screenAPI  可选，截屏API（缺省 window.screenAPI）
//   opts.storage    可选，localStorage兼容对象
//   opts.now        可选，时钟函数（测试注入）
// ============================================================

const CONFIG_KEY = 'pet-perception-config'; // 与 settings.html 约定一致

const DEFAULTS = {
  interval: 30000,      // 截屏分析间隔
  recordThrottle: 10 * 60 * 1000, // 同场景记忆记录节流（10分钟）
};

const VALID_SCENES = ['work', 'fun', 'slack', 'rest', 'unknown'];

const SCENE_LABELS = {
  work: '工作', fun: '娱乐', slack: '摸鱼', rest: '休息',
  unknown: '未知', late_night: '深夜',
};

const SCENE_PROMPT = `你是桌面宠物的屏幕感知模块。分析这张屏幕截图，判断主人当前的使用场景。
场景定义：work=专注工作/学习/写代码；fun=娱乐（游戏/视频/音乐）；slack=摸鱼闲逛（社交媒体/购物）；rest=挂机/锁屏/桌面空闲；unknown=无法判断。
detail 要具体：主人在用什么软件/看什么内容/屏幕上最显眼的信息（如"在VSCode里写JavaScript代码"），不超过40字。
只返回一个JSON对象，不要输出任何其他文字、解释或markdown围栏：
{"scene":"work|fun|slack|rest|unknown","confidence":0到1之间的小数,"detail":"具体描述主人屏幕上的内容"}`;

// mock模式轮转序列（确定性，便于测试）
const MOCK_ORDER = ['work', 'fun', 'slack', 'rest'];
const MOCK_DETAILS = {
  work: '正在专注写代码',
  fun: '在看视频放松',
  slack: '在刷社交媒体摸鱼',
  rest: '屏幕处于挂机状态',
};

class PerceptionService {
  /**
   * @param {Object} opts
   * @param {import('./llm.js').default} opts.llm 必填
   * @param {import('./memory.js').default} [opts.memory]
   * @param {number} [opts.interval=30000] 截屏间隔ms
   * @param {boolean} [opts.enabled=false] 初始配置开关（不自动start，由入口控制）
   * @param {string[]} [opts.blacklist] App黑名单（当前版本不生效，见TODO）
   */
  constructor(opts = {}) {
    if (!opts.llm) {
      throw new TypeError('PerceptionService: 必须注入 llm (LLMService实例)');
    }
    this.llm = opts.llm;
    this.memory = opts.memory || null;
    this.opts = {
      interval: opts.interval ?? DEFAULTS.interval,
      recordThrottle: opts.recordThrottle ?? DEFAULTS.recordThrottle,
      blacklist: Array.isArray(opts.blacklist) ? [...opts.blacklist] : [],
    };
    // TODO(blacklist): 渲染进程拿不到前台App信息（需主进程 native API / AppleScript），
    // 当前版本 blacklist 仅存储配置、不参与判定，后续版本接入后在此过滤。

    this.events = opts.events ?? (typeof window !== 'undefined' ? window.PetEvents : null) ?? null;
    this.screenAPI = opts.screenAPI ?? (typeof window !== 'undefined' ? window.screenAPI : null) ?? null;
    this.storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null) ?? null;
    this._now = opts.now || (() => Date.now());

    // 运行状态
    this._enabled = !!opts.enabled; // 配置开关（start/stop控制）
    this._paused = false;           // 隐私暂停（托盘开关）
    this._timer = null;
    this._lastScene = null;
    this._lastCheckAt = null;
    this._lastRecordAt = {};        // scene -> 上次记忆记录时间戳
    this._mockIndex = 0;

    // 全局事件接入（T10托盘 / 设置面板联动）
    if (this.events) {
      this.events.on('perception:paused', (p) => this._onPaused(p));
      this.events.on('settings:updated', (p) => this._onSettingsUpdated(p));
    }
  }

  // ---------- 对外接口 ----------

  /** 启动感知循环（立即执行首次检测，此后按interval循环） */
  start() {
    this._enabled = true;
    this._paused = false;
    this._schedule(0);
  }

  /** 停止感知循环 */
  stop() {
    this._enabled = false;
    this._clearTimer();
  }

  /** 隐私暂停：立即停止循环并清掉pending定时器 */
  pause() {
    this._paused = true;
    this._clearTimer();
  }

  /** 从隐私暂停恢复（未启用时不动作） */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    if (this._enabled && !this._timer) this._schedule(this.opts.interval);
  }

  getStatus() {
    return {
      enabled: this._enabled,
      running: this._enabled && !this._paused,
      lastScene: this._lastScene,
      lastCheckAt: this._lastCheckAt,
      paused: this._paused,
    };
  }

  // ---------- 内部：循环调度 ----------

  _schedule(delay) {
    if (!this._enabled || this._paused) return;
    this._clearTimer();
    this._timer = setTimeout(() => { this._tick(); }, delay ?? this.opts.interval);
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    this._timer = null;
    if (!this._enabled || this._paused) return;
    this._lastCheckAt = this._now();
    let result = null;
    try {
      const hour = new Date(this._now()).getHours();
      if (hour >= 0 && hour < 5) {
        // 深夜检测：优先于LLM场景（省调用），pet.js据此哄睡
        result = { scene: 'late_night', confidence: 1, detail: '深夜了主人还在用电脑' };
      } else if (this._isMockMode()) {
        result = this._nextMockScene();
      } else {
        const b64 = await this._capture();
        if (b64) {
          const reply = await this.llm.vision(b64, SCENE_PROMPT);
          result = this._parseSceneReply(reply);
        }
      }
      if (result && this._enabled && !this._paused) {
        this._reportScene(result);
      }
    } catch (err) {
      console.error('[Perception] tick error:', err);
    } finally {
      this._schedule(this.opts.interval);
    }
  }

  _isMockMode() {
    return this.llm?.config?.model === 'mock';
  }

  async _capture() {
    if (!this.screenAPI || typeof this.screenAPI.getScreenshot !== 'function') {
      console.warn('[Perception] screenAPI不可用，跳过本轮感知');
      return null;
    }
    try {
      return await this.screenAPI.getScreenshot();
    } catch (err) {
      console.warn('[Perception] 截屏失败，跳过本轮:', err?.message || err);
      return null;
    }
  }

  // mock模式：不调真实vision，按固定顺序轮转场景
  _nextMockScene() {
    const scene = MOCK_ORDER[this._mockIndex % MOCK_ORDER.length];
    this._mockIndex++;
    return { scene, confidence: 0.85, detail: MOCK_DETAILS[scene] };
  }

  // LLM返回容错解析：剥离markdown围栏/前后杂文字，取首个JSON块；失败降级unknown
  _parseSceneReply(text) {
    const raw = typeof text === 'string' ? text : '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        const scene = VALID_SCENES.includes(obj.scene) ? obj.scene : 'unknown';
        const confidence = typeof obj.confidence === 'number'
          ? Math.min(1, Math.max(0, obj.confidence)) : 0.5;
        const detail = typeof obj.detail === 'string' && obj.detail.trim()
          ? obj.detail.trim() : '（无描述）';
        return { scene, confidence, detail };
      } catch { /* 落入下方unknown兜底 */ }
    }
    return { scene: 'unknown', confidence: 0.2, detail: '场景解析失败：' + raw.slice(0, 50) };
  }

  // 场景上报：变化时emit；记忆低频记录（同场景10分钟节流，与变化解耦）
  _reportScene({ scene, confidence, detail }) {
    if (this.memory) {
      const last = this._lastRecordAt[scene] || 0;
      if (this._now() - last >= this.opts.recordThrottle) {
        this._lastRecordAt[scene] = this._now();
        const label = SCENE_LABELS[scene] || scene;
        this.memory
          .add('long', `主人当时在${label}：${detail}`, { source: 'perception', scene })
          .catch((e) => console.warn('[Perception] 记忆写入失败:', e?.message || e));
      }
    }
    if (scene !== this._lastScene) {
      this._lastScene = scene;
      if (this.events) this.events.emit('scene:change', { scene, confidence, detail });
    }
  }

  // ---------- 内部：全局事件联动 ----------

  _onPaused({ paused } = {}) {
    if (paused) this.pause();
    else this.resume();
  }

  _onSettingsUpdated({ scope } = {}) {
    if (!Array.isArray(scope) || !scope.includes('perception')) return;
    if (!this.storage) return;
    let cfg = null;
    try {
      cfg = JSON.parse(this.storage.getItem(CONFIG_KEY) || 'null');
    } catch (err) {
      console.warn('[Perception] 配置解析失败:', err?.message || err);
      return;
    }
    if (!cfg || typeof cfg !== 'object') return;
    // interval变更下次tick生效（不重启当前pending定时器）
    if (typeof cfg.interval === 'number' && cfg.interval >= 1000) {
      this.opts.interval = cfg.interval;
    }
    const want = !!cfg.enabled;
    if (want && !this._enabled) this.start();
    else if (!want && this._enabled) this.stop();
  }
}

export default PerceptionService;
export { PerceptionService, CONFIG_KEY, SCENE_PROMPT, VALID_SCENES };
