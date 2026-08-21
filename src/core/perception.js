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

// ---------- 场景理解引擎（Scene Engine）参数 ----------
const WINDOW_SIZE = 6;              // 滑动窗口：最近 N 次观察
const STABLE_MIN = 4;               // 窗口内 ≥4 次相同变化模式 → 稳定
const IDLE_MS = 2 * 60 * 1000;      // 连续无变化超 2 分钟 → idle
// 免打扰场景标签（外部经 setSceneHint 注入，命中即 DND）
const DND_SCENES = ['meeting', 'video', 'presentation', 'dnd', 'late_night'];

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
    this._lastSnapshot = null; // 最近一次感知快照（场景+描述，对话注入用）
    this._lastCheckAt = null;
    this._lastRecordAt = {};        // scene -> 上次记忆记录时间戳
    this._mockIndex = 0;

    // 场景理解引擎状态
    this._observations = [];        // 滑动窗口：[{hash, ts, changed}]
    this._lastHash = null;          // 上一次观察的截屏指纹
    this._sceneHint = null;         // 外部注入的场景标签（LLM/截屏分析调用）

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

  // ---------- 场景理解引擎（纯逻辑，不依赖Electron运行时） ----------

  /**
   * 喂入一次截屏指纹观察。内部维护最近 WINDOW_SIZE(=6) 次观察的滑动窗口。
   * @param {string} screenHash 截屏指纹（如 perceptual hash 字符串）
   * @param {number} [ts] 观察时间戳ms（缺省用内部时钟）
   */
  observe(screenHash, ts) {
    const t = typeof ts === 'number' ? ts : this._now();
    const changed = this._lastHash !== null && screenHash !== this._lastHash;
    this._observations.push({ hash: screenHash, ts: t, changed });
    if (this._observations.length > WINDOW_SIZE) {
      this._observations.splice(0, this._observations.length - WINDOW_SIZE);
    }
    this._lastHash = screenHash;
    this._lastObserveAt = t;
  }

  /**
   * 当前稳定场景。
   * 判定规则（按优先级）：
   *   1) idle：窗口内观察全部 hash 相同，且首末跨度超 2 分钟
   *   2) 稳定：窗口内 ≥4 次相同变化模式（changed 全 true 或全 false）
   *   3) 其他：'active'
   * @returns {'idle'|'stable'|'active'} 场景名
   */
  getStableScene() {
    const obs = this._observations;
    if (obs.length === 0) return 'active';

    // idle：连续几乎无变化（hash全相等）且持续超 IDLE_MS
    const allSame = obs.every((o) => o.hash === obs[0].hash);
    if (allSame && obs[obs.length - 1].ts - obs[0].ts > IDLE_MS) return 'idle';

    // 稳定：≥4 次相同变化模式
    const trueCnt = obs.filter((o) => o.changed).length;
    if (trueCnt >= STABLE_MIN || obs.length - trueCnt >= STABLE_MIN) return 'stable';

    return 'active';
  }

  /**
   * 免打扰（Do Not Disturb）判定。
   * @param {string} [externalScene] 可选外部场景标签（如 'meeting'/'video'）
   * @returns {boolean} true 表示当前应免打扰
   */
  isDnd(externalScene) {
    const label = externalScene !== undefined ? externalScene : this._sceneHint;
    if (label && DND_SCENES.includes(label)) return true;
    // 引擎自身的稳定 idle（挂机）不打扰；深夜同样免打扰
    return this.getStableScene() === 'idle';
  }

  /**
   * 注入场景标签（由 LLM 场景识别或截屏分析调用）。
   * @param {string|null} label 如 'meeting'/'video'/'work'；传 null 清除
   */
  setSceneHint(label) {
    this._sceneHint = label ?? null;
  }

  /** 读取当前场景标签（未注入返回 null） */
  getSceneHint() {
    return this._sceneHint;
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
    // 行动回路运行中：跳过本轮感知（避免并发 vision 调用互相干扰/劫持）
    if (this._ownerPetRef?._screenLooping) {
      this._timer = setTimeout(() => { this._tick(); }, this.opts.interval);
      return;
    }
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
          // 场景引擎：喂入截屏指纹（取base64前64字符作为轻量指纹）
          this.observe(b64.slice(0, 64), this._now());
          const reply = await this.llm.vision(b64, SCENE_PROMPT);
          result = this._parseSceneReply(reply);
          if (result && VALID_SCENES.includes(result.scene)) {
            this.setSceneHint(result.scene); // LLM 场景结果同步为 hint
          }
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
    // 最近快照（供对话注入：主人问"能看到我屏幕吗"时 LLM 有真实现场信息）
    this._lastSnapshot = { scene, confidence, detail, at: this._now() };
    if (scene !== this._lastScene) {
      this._lastScene = scene;
      if (this.events) this.events.emit('scene:change', { scene, confidence, detail });
    }
  }

  /** 最近一次屏幕感知快照（5 分钟内有效；过期视为不确定） */
  getLatestSnapshot() {
    const snap = this._lastSnapshot;
    if (!snap) return null;
    const freshMs = this._now() - snap.at < 5 * 60 * 1000;
    return freshMs ? snap : { ...snap, stale: true };
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
export { PerceptionService, CONFIG_KEY, SCENE_PROMPT, VALID_SCENES, WINDOW_SIZE, STABLE_MIN, IDLE_MS, DND_SCENES };
