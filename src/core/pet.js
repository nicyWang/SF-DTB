// ============================================================
// pet.js — 宠物控制器：状态机 + 主动行为引擎
// 消费：llm.js / memory.js / personality.js / live2d.js（被 sprite.js 替代）/ bubble.js（依赖注入）
// 契约见 CONTRACT.md：//   setEmotion / playMotion / speak / getState / chat / startLiveMode / stopLiveMode / setCharacter }
// ============================================================

import PersonalityEngine from './personality.js';
import MemoryService from './memory.js';
import * as PetTasks from './pet/tasks.js';
import * as PetConv from './pet/conversation.js';
import { isUserCharacterId } from './charprompt.js';

// 支持的角色 ID 列表（内置）+ 用户自建角色（CharacterManager 生成的 uc_* 前缀 id）
const CHARACTER_IDS = ['handsome', 'beauty'];
const DEFAULT_CHARACTER_ID = 'handsome';
const isValidCharacterId = (id) => CHARACTER_IDS.includes(id) || isUserCharacterId(id);

// ---------- 可调参数（构造 opts 可覆盖，便于测试加速） ----------
const DEFAULTS = {
  tickMs: 5000,                            // 行为循环周期
  boredMs: 30 * 60 * 1000,                 // 30分钟无互动 → bored
  sleepyMs: 60 * 60 * 1000,                // 60分钟无互动 → sleepy
  emotionDecayMs: 30000,                   // 非normal情绪30s回落
  sceneCommentGapMs: 10 * 60 * 1000,       // 场景评论全局最小间隔
  sceneCommentProb: 0.3,                   // 场景变化时评论概率
};

const EMOTIONS = ['normal', 'happy', 'bored', 'sad', 'excited', 'sleepy'];

// 情绪别名：其他模块（如 live/mode.js）可能发出 pet 不直接支持的情绪，映射到最近似值
const EMOTION_ALIASES = {
  shy: 'happy',      // 害羞 → 开心（Hiyori 无害羞动作）
};

// 具名动作 → Hiyori 动作组映射（live/mode.js 发出 wave/nod/dance/sing 等）
// Hiyori 仅 Idle×9 / TapBody×1，全部具名动作统一映射为 TapBody
const NAMED_MOTIONS = {
  wave: { group: 'TapBody', index: 0 },
  nod: { group: 'TapBody', index: 0 },
  dance: { group: 'TapBody', index: 0 },
  sing: { group: 'TapBody', index: 0 },
};

// 情绪 → Live2D 动作映射（Hiyori 只有 Idle×9 / TapBody×1）
const EMOTION_MOTIONS = {
  normal:  { group: 'Idle' },
  happy:   { group: 'TapBody', index: 0 },
  excited: { group: 'TapBody', index: 0 },
  bored:   { group: 'Idle' },
  sad:     { group: 'Idle' },
  sleepy:  { group: 'Idle' },
};

// 主人语气粗判（关键词）
const PRAISE_RE = /乖|厉害|棒|可爱|好看|牛|优秀|喜欢你|爱了|满分|赞|真行|不错/;
const SCOLD_RE = /笨|傻|蠢|闭嘴|滚|烦人|讨厌|没用|废物|吵死|走开/;

// ---------- 本地台词池（mock模式 / LLM失败兜底） ----------
const POOLS = {
  pat: ['嘿嘿～', '再摸一下嘛', '舒服～', '主人的手好温暖', '蹭蹭', '开心！', '毛发被摸乱了啦'],
  busy: ['等我说完这句嘛～', '别急别急，一个一个来'],
  bored: [
    '好无聊啊……主人陪我玩一会儿嘛',
    '（趴在桌面上）主人已经很久没理我了哦',
    '无聊无聊无聊～要不要跟我说说话？',
    '（戳了戳屏幕）在吗在吗？',
  ],
  sleepy: [
    '主人不去休息吗……我先眯一会儿……',
    '（眼皮打架）好久没人理我了，睡会儿……',
    '呼……啊……主人需要我的时候再叫我……',
  ],
  late_night: [
    '主人，都这么晚了还不睡吗？心疼……',
    '深夜了哦，身体要紧，早点休息嘛',
    '这么晚还在忙呀……我陪你，但你也要照顾自己',
  ],
  scene_work: [
    '主人在认真工作呢，加油加油！',
    '看到你这么专注，我也不敢吵你～默默陪着你',
  ],
  scene_fun: [
    '哇，主人在放松玩呢！玩得开心～',
    '看起来很好玩的样子！带我一起呀',
  ],
  scene_slack: [
    '（小声）主人这是在摸鱼吧……我可什么都看见了哦',
    '嘘——我不说出去，摸鱼也要适度呀',
  ],
  scene_rest: [
    '主人在休息呀，我帮你看着屏幕～',
    '好好休息，回来我叫你……啊不，我会等你的！',
  ],
  scene_unknown: ['主人在干嘛呀？我猜猜……猜不到'],
  live_on: ['直播开始啦！大家好呀～', '开播开播！我今天状态特别好！'],
  live_off: ['下播啦～今天和大家玩得开心！', '直播结束，瘫一会儿……'],
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Agent工具说明书（与主进程 main/tools.js 的 TOOL_SPECS 一致的副本）
const TOOL_SPECS = [
  { type: 'function', function: { name: 'read-file', description: '读取文本文件内容', parameters: { type: 'object', properties: { file: { type: 'string', description: '文件绝对路径' } }, required: ['file'] } } },
  { type: 'function', function: { name: 'write-file', description: '写文件（新建/覆盖）', parameters: { type: 'object', properties: { file: { type: 'string', description: '目标路径' }, content: { type: 'string', description: '写入内容' } }, required: ['file', 'content'] } } },
  { type: 'function', function: { name: 'move-file', description: '移动/重命名文件或目录（可用来整理桌面）', parameters: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } }, required: ['src', 'dst'] } } },
  { type: 'function', function: { name: 'open-url', description: '用默认浏览器打开网址', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'run-applescript', description: '执行AppleScript自动化macOS（控制窗口/通知/应用消息等）', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'shell', description: '执行白名单shell命令（ls/cat/mkdir/cp/mv/open/say等）', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'screenshot', description: '截取全屏保存到/tmp（需要屏幕录制权限）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'system-info', description: '获取系统信息（用户/内存/时间）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'tool-health', description: '检查Agent工具层是否可用', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'open-app', description: '打开macOS应用（安全版：应用名仅限字母数字空格，如 Safari / WeChat / Netease Music）', parameters: { type: 'object', properties: { appName: { type: 'string', description: '应用名' } }, required: ['appName'] } } },
  { type: 'function', function: { name: 'list-dir', description: '列出目录内容（安全版：仅限 ~/Desktop ~/Documents ~/Downloads ~/WorkBuddy，最多50项）', parameters: { type: 'object', properties: { dirPath: { type: 'string', description: '如 ~/Desktop' } }, required: ['dirPath'] } } },
  { type: 'function', function: { name: 'set-reminder', description: '设置定时提醒：N分钟后提醒主人某事（到点会弹出通知）', parameters: { type: 'object', properties: { minutes: { type: 'number', description: '分钟数(1-720)' }, text: { type: 'string', description: '提醒内容' } }, required: ['minutes', 'text'] } } },
  { type: 'function', function: { name: 'cancel-reminder', description: '取消一个未触发的提醒', parameters: { type: 'object', properties: { id: { type: 'string', description: 'set-reminder返回的id' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'type-text', description: '在当前焦点或指定坐标输入文本', parameters: { type: 'object', properties: { text: { type: 'string', description: '要输入的文本' }, x: { type: 'number', description: '目标输入框屏幕X坐标' }, y: { type: 'number', description: '目标输入框屏幕Y坐标' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'click-at', description: '点击屏幕坐标（默认静默，不移动光标）', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, silent: { type: 'boolean', description: 'true=静默按压；false=移动光标真实点击' } }, required: ['x', 'y'] } } },

  { type: 'function', function: { name: 'clipboard-read', description: '读取剪贴板文本内容（如"我刚复制的内容"）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'clipboard-write', description: '把文本写入剪贴板（复制）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要复制的文本' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'web-read', description: '抓取网页并提取正文（去广告）。配合web-search：先搜后读，"帮我查XX并总结"用 web-search+web-read 组合', parameters: { type: 'object', properties: { url: { type: 'string', description: '网页链接' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'doc-convert', description: '文档格式转换：pdf/docx/xlsx/csv/txt/html/pptx 互转（如"PDF转Word"）', parameters: { type: 'object', properties: { src: { type: 'string', description: '文件路径' }, to: { type: 'string', description: '目标格式：pdf/docx/xlsx/csv/txt/html/pptx' } }, required: ['src', 'to'] } } },
  { type: 'function', function: { name: 'image-process', description: '图片处理：缩放/压缩/转格式（macOS原生，如"这图改小点""转成jpg"）', parameters: { type: 'object', properties: { src: { type: 'string', description: '图片路径' }, op: { type: 'string', description: 'resize/compress' }, width: { type: 'number', description: '目标宽度像素，默认800' }, quality: { type: 'number', description: '质量1-100' }, to: { type: 'string', description: '转格式：jpeg/png/webp等' } }, required: ['src'] } } },
  { type: 'function', function: { name: 'tidy-desktop', description: '整理桌面：自动按类型分类（图片/文档/安装包/视频/音频移入对应文件夹）。dryRun=true 先预览不移动', parameters: { type: 'object', properties: { dryRun: { type: 'boolean', description: 'true=只预览不实际移动' } }, required: [] } } },
  { type: 'function', function: { name: 'close-app', description: '关闭应用（先温和退出，关不掉自动强制）', parameters: { type: 'object', properties: { name: { type: 'string', description: '应用名：微信/酷狗/网易云/备忘录/浏览器/Chrome/计算器/日历等' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'web-search', description: '浏览器搜索：自动打开浏览器查资料（默认百度，可选bing/google）', parameters: { type: 'object', properties: { query: { type: 'string' }, engine: { type: 'string', description: 'baidu/bing/google' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'wechat-send', description: '通过微信给指定联系人发消息（自动开微信→搜索→输入→发送）。需微信已在Mac登录。调用前必须先向用户复述联系人与内容获得确认', parameters: { type: 'object', properties: { contact: { type: 'string', description: '联系人备注名/昵称' }, message: { type: 'string', description: '消息内容' } }, required: ['contact', 'message'] } } },
  { type: 'function', function: { name: 'mouse-move', description: '移动鼠标到屏幕坐标(不点击)', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'mouse-dblclick', description: '双击屏幕坐标', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'mouse-rightclick', description: '右键点击屏幕坐标', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'mouse-drag', description: '拖拽：从一点按住拖到另一点', parameters: { type: 'object', properties: { fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, duration: { type: 'number' } }, required: ['fromX', 'fromY', 'toX', 'toY'] } } },
  { type: 'function', function: { name: 'mouse-scroll', description: '滚动（deltaY负=上,正=下,像素）', parameters: { type: 'object', properties: { deltaY: { type: 'number' }, deltaX: { type: 'number' } }, required: ['deltaY'] } } },
  { type: 'function', function: { name: 'key-press', description: '按键(key:enter/esc/tab/space/方向键/F1-12/单字符; modifiers:["cmd","shift","ctrl","alt"])', parameters: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } }, required: ['key'] } } },
  { type: 'function', function: { name: 'hotkey-text', description: '快捷键："cmd+c" "cmd+shift+3" "enter" "esc"', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'ui-click', description: '【精准模式·优先用】按名字直接点击UI元素（零坐标猜测，光标不动，毫秒级）。name=元素名（"重新加载""发送""登录"），app=可选目标应用', parameters: { type: 'object', properties: { name: { type: 'string' }, app: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'ui-set', description: '【精准模式】按名字找到输入框直接设值', parameters: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' }, app: { type: 'string' } }, required: ['name', 'value'] } } },
  { type: 'function', function: { name: 'ui-list', description: '列出当前应用可交互元素名（精准模式的眼睛）', parameters: { type: 'object', properties: { filter: { type: 'string' }, app: { type: 'string' } }, required: [] } } },
];

class PetController {
  /**
   * @param {object} deps 依赖注入：{llm, memory, personality, live2d, bubble}
   *   deps.voice: VoiceService 实例（可选；注入后启用语音对话 voiceChat 流程）
   * @param {object} [opts] 行为参数覆盖（测试时可加速阈值）
   *   opts.characterId: string 当前角色 ID（默认 'handsome'，与 deps.personality/memory 必须一致）
   */
  constructor(deps, opts = {}) {
    const missing = ['llm', 'memory', 'personality', 'live2d', 'bubble'].filter((k) => !deps?.[k]);
    if (missing.length) throw new Error(`[PetController] 缺少依赖: ${missing.join(', ')}`);
    this.llm = deps.llm;
    this.memory = deps.memory;
    this.personality = deps.personality;
    this.live2d = deps.live2d;
    this.bubble = deps.bubble;
    this.voice = deps.voice || null; // 语音服务（可选依赖）
    this.knowledge = deps.knowledge || null; // 个人知识库（可选；对话提取+检索注入）
    this.doubao = deps.doubao || null; // 豆包端到端实时语音（可选；配置后优先于 VAD 链路）
    this.perception = deps.perception || null; // 感知服务（可选；场景理解引擎+DND门控主动搭话）

    this.opts = { ...DEFAULTS, ...opts };
    this.characterId = isValidCharacterId(opts.characterId) ? opts.characterId : DEFAULT_CHARACTER_ID;
    this.state = {
      emotion: 'normal',
      lastInteraction: Date.now(),
      liveMode: false,
    };
    this._chatting = false;
    this._voiceActive = false;   // 语音会话进行中（voiceChat 开启）
    this._speakingVoice = false; // TTS 播报中（防重入 + 防自听自说）
    this._tickTimer = null;
    this._emotionTimer = null;
    this._boredAnnounced = false;      // 本轮无聊已播报
    this._sleepyAnnounced = false;     // 本轮困倦已播报
    this._lateNightApplied = false;    // 今晚深夜事件已触发
    this._lastSceneCommented = null;   // 已评论过的场景（同场景只评论一次）
    this._lastSceneCommentAt = 0;
    this._events = window.PetEvents || null; // preload注入；纯浏览器调试时可能不存在
  }

  // ---------- 生命周期 ----------

  async init() {
    // 全局事件订阅（可选链容错；保存引用便于 destroy 精确解绑）
    this._onSceneChangeBound = (payload) => this._onSceneChange(payload || {});
    this._onSpeakRequestBound = (payload) => this.speak(payload?.text, payload?.duration);
    // live/mode.js 等模块经总线发出的情绪/动作请求 → 由本控制器落地
    // 注意防回环：setEmotion 也会 emit emotion:change，监听器仅在情绪不同时才转发
    this._onEmotionChangeBound = ({ emotion } = {}) => {
      if (typeof emotion === 'string' && emotion !== this.state.emotion) {
        this.setEmotion(emotion);
      }
    };
    this._onMotionPlayBound = ({ name } = {}) => {
      const m = NAMED_MOTIONS[name];
      if (m) this.playMotion(m.group, m.index);
    };
    // live/mode.js 开播/下播 → 同步 liveMode 状态位
    this._onLiveEventBound = ({ kind } = {}) => {
      if (kind === 'live-start') { this.state.liveMode = true; this.touch(); }
      else if (kind === 'live-stop') { this.state.liveMode = false; }
    };
    const ev = this._events;
    ev?.on?.('scene:change', this._onSceneChangeBound);
    ev?.on?.('speak:request', this._onSpeakRequestBound);
    ev?.on?.('emotion:change', this._onEmotionChangeBound);
    ev?.on?.('motion:play', this._onMotionPlayBound);
    ev?.on?.('live:event', this._onLiveEventBound);
    // 行为循环
    this._tickTimer = setInterval(() => this._tick(), this.opts.tickMs);
    return this;
  }

  // ══ 拆分模块代理（2026-08-22 架构收敛第4步）：实现移至 pet/tasks.js 与 pet/conversation.js ══
  _verifyTask(task, before) { return PetTasks.verifyTask(this, task, before); }
  _isScreenAction(t) { return PetTasks.isScreenAction(this, t); }
  _canCaptureScreen() { return PetTasks.canCaptureScreen(this); }
  async _screenActionLoop(task) { return await PetTasks.screenActionLoop(this, task); }
  async _screenActionLoopInner(task) { return await PetTasks.screenActionLoopInner(this, task); }
  _isScreenRequest(t) { return PetTasks.isScreenRequest(this, t); }
  async _analyzeScreenFor(q) { return await PetTasks.analyzeScreenFor(this, q); }
  async _buildMessages(t) { return await PetConv.buildMessages(this, t); }
  async _llmNeedTool(t) { return await PetConv.llmNeedTool(this, t); }
  async _processVoiceText(t) { return await PetConv.processVoiceText(this, t); }
  async _speakReply(r) { return await PetConv.speakReply(this, r); }
  async _onVoiceError(m) { return await PetConv.onVoiceError(this, m); }
  _execVoiceUnified(t) { return PetConv.execVoiceUnified(this, t); }

  destroy() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._emotionTimer) clearTimeout(this._emotionTimer);
    this.stopVoiceChat();
    const ev = this._events;
    if (ev?.off) {
      ev.off('scene:change', this._onSceneChangeBound);
      ev.off('speak:request', this._onSpeakRequestBound);
      ev.off('emotion:change', this._onEmotionChangeBound);
      ev.off('motion:play', this._onMotionPlayBound);
      ev.off('live:event', this._onLiveEventBound);
    }
  }

  // ---------- 契约接口 ----------

  /**
   * 设置情绪并映射到 Live2D 动作；非 normal 情绪在 decayMs 后自动回落
   * @param {string} emotion normal/happy/bored/sad/excited/sleepy
   * @param {number} [decayMs] 情绪持续时间，默认 30s
   */
  setEmotion(emotion, decayMs) {
    const target = EMOTION_ALIASES[emotion] || emotion;
    if (!EMOTIONS.includes(target)) {
      console.warn('[PetController] 未知情绪:', emotion);
      return false;
    }
    this.state.emotion = target;
    if (target !== 'normal' && decayMs) this.live2d._replyEmotion = true;
    else if (target === 'normal') this.live2d._replyEmotion = false;
    this._events?.emit?.('emotion:change', { emotion: target });

    this.live2d.setEmotion(target);

    if (this._emotionTimer) clearTimeout(this._emotionTimer);
    if (target !== 'normal') {
      this._emotionTimer = setTimeout(
        () => this.setEmotion('normal'),
        typeof decayMs === 'number' ? decayMs : this.opts.emotionDecayMs,
      );
    }
    return true;
  }

  /** 播放指定动作 */
  playMotion(group, index) {
    return this.live2d.playMotion(group, index);
  }

  /**
   * 说话：气泡 + 口型驱动
   * @param {string} text
   * @param {number} [duration] 气泡停留毫秒；缺省按字数计算
   */
  speak(text, duration) {
    if (!text) return;
    this.bubble.showText(text, duration);
    const d = typeof duration === 'number'
      ? duration
      : Math.max(2000, String(text).length * 150);
    this.live2d.lipSpeak?.(d);
  }

  /** 当前完整状态 */
  getState() {
    return {
      emotion: this.state.emotion,
      characterId: this.characterId,
      lastInteraction: this.state.lastInteraction,
      idleMinutes: Math.round(((Date.now() - this.state.lastInteraction) / 60000) * 10) / 10,
      liveMode: this.state.liveMode,
      chatting: this._chatting,
      voiceActive: this._voiceActive,
      speaking: this._speakingVoice,
      personality: this.personality?.getTraits?.() || null,
    };
  }

  /**
   * 切换角色：重建 personality/memory 实例，调用 sprite 切换立绘
   * LLM/perception/弹幕等全局配置共享，不动；只重建角色档案。
   * @param {string} id 'handsome' | 'beauty'
   * @returns {Promise<boolean>}
   */
  async setCharacter(id) {
    if (!isValidCharacterId(id)) {
      console.warn('[PetController] 未知角色:', id);
      return false;
    }
    if (id === this.characterId) return true;
    const previous = this.characterId;
    this.characterId = id;
    // 切换时清空临时情绪 + 重置 idle 计时，避免遗留行为误判
    this.state.lastInteraction = Date.now();
    this._boredAnnounced = false;
    this._sleepyAnnounced = false;
    if (this._emotionTimer) { clearTimeout(this._emotionTimer); this._emotionTimer = null; }
    try {
      // 1. 切换 sprite 立绘（保留旧情绪显示直至新角色资源就绪）
      if (typeof this.live2d.setCharacter === 'function') {
        await this.live2d.setCharacter(id);
      }
      // 2. 重建 personality（独立性格种子）
      this.personality = new PersonalityEngine(id);
      // 3. 重建 memory（独立存储）
      this.memory = new MemoryService({ llm: this.llm, characterId: id });
      // 4. 通知总线（设置面板/托盘菜单等订阅）
      this._events?.emit?.('character:switched', { characterId: id, previous });
      return true;
    } catch (err) {
      console.error('[PetController] 角色切换失败:', err);
      // 回滚
      this.characterId = previous;
      return false;
    }
  }

  /**
   * 主人对话主流程：记忆 → 组装上下文 → 流式回复 → 回写记忆/画像/性格
   * @param {string} userText
   * @returns {Promise<string>} 完整回复
   */
  /**
   * 依据对话内容推断情绪并应用（回复表情联动）。
   * 词典匹配（零延迟零成本）：用户话优先（关心主人情绪→共情表情），否则按回复语义。
   * 匹配不到→不改表情（保持当前/自然回落）。
   */
  _applyReplyEmotion(userText, reply) {
    const txt = String(reply || '') + '||' + String(userText || '');
    const rules = [
      [/哈哈|嘻嘻|嘿嘿|好开心|太棒|厉害|真好|喜欢|逗我|笑死|有趣|可爱|么么|爱你|想我了吗/, 'happy'],
      [/哇|天呐|太(强|好|厉害)|激动|兴奋|冲鸭|来了来了|马上|搞定|完成/, 'excited'],
      [/难过|伤心|委屈|抱歉|对不起|可惜|遗憾|心疼|辛苦|累了|疲|压力|不开心|烦|难受/, 'sad'],
      [/困|睡|晚安|早安|呵欠|打哈欠|揉眼睛|夜里|深夜/, 'sleepy'],
      [/无聊|没意思|好闲|发呆|摸鱼|随便|都行|不知道该/, 'bored'],
    ];
    // ★ 回复文本优先（汪总需求：表情跟随"她说了什么"的情绪，不是用户说了什么）
    const rText = String(reply || '');
    for (const [re, emo] of rules) {
      if (re.test(rText)) { this.setEmotion(emo, 8000); return; }
    }
    // 回复无情绪信号 → 用户强情绪兜底（共情）
    const u = String(userText || '');
    const userRules = [
      [/哈哈|嘻嘻|太好了|真棒|厉害|开心|好耶/, 'excited'],
      [/难过|伤心|累|烦|压力|不开心|委屈|想哭|难受/, 'sad'],
      [/晚安|睡了|困/, 'sleepy'],
    ];
    for (const [re, emo] of userRules) {
      if (re.test(u)) { this.setEmotion(emo, 8000); return; }
    }
    if (/[!?！？]{1,3}$/.test(String(reply || '').trim())) { this.setEmotion('excited', 6000); return; }
    if (/^(好的|明白|收到|当然|可以|没问题|我来|帮你)/.test(String(reply || '').trim())) {
      this.setEmotion('happy', 6000);
    }
  }

  async chat(userText) {
    const text = String(userText || '').trim();
    if (!text) return '';
    if (this._chatting) {
      // 排队不丢弃：最多缓存3条，当前回复完自动接续处理
      this._chatQueue = this._chatQueue || [];
      if (this._chatQueue.length < 3) {
        this._chatQueue.push(text);
        if (this._chatQueue.length === 1) this.speak(pick(POOLS.busy)); // 首条排队才提示，避免刷屏
      }
      return '';
    }
    this._chatting = true;
    this.touch();
    // 回复期间冻结小球移动（气泡跟着球跑会看不清）
    this._setFrozen(false);
    try {
      // 1. 情绪粗判（关键词）→ 性格事件
      if (PRAISE_RE.test(text)) {
        this.setEmotion('happy', 15000);
        this.personality.applyEvent('owner_praise');
      } else if (SCOLD_RE.test(text)) {
        this.setEmotion('sad', 15000);
        this.personality.applyEvent('owner_scold');
      }

      // 2. 写入短期记忆
      await this.memory.add('short', `主人说：${text}`);

      // 3. 组装 messages（人设system + 知识库检索 + 记忆块 + 最近对话）
      let messages = await this._buildMessages(text);
        // CUA 行动回路：操作类指令（点/关/拖/填屏幕目标）→ 自动截屏-定位-执行-验证循环
        if (this._isScreenAction?.(text) && this._canCaptureScreen() && !this._screenLooping) {
          this._screenLooping = true;
          try {
            const result = await this._screenActionLoop(text);
            this.bubble.showText(result, Math.max(4000, result.length * 120));
            return result; // 操作类不走普通 chat 回复，直接返回回路结果
          } finally { this._screenLooping = false; }
        }
        // 屏幕指挥：涉及屏幕内容的请求 → 实时截屏分析注入（vision 坐标级定位）
        if (this._isScreenRequest?.(text)) {
          const sc = await this._analyzeScreenFor(text);
          if (sc) { messages = [...messages, { role: 'system', content: sc }]; this.bubble.showHint?.('👀 看到了', 1200); }
        }

      // 4. 回复（Agent模式：可调用工具；普通模式：纯流式）
      const lipTimer = setInterval(() => this.live2d.lipSpeak?.(1400), 1200);
      let reply;
      try {
        const hasTools = !!(window.windowAPI && window.windowAPI.invokeTool
          && typeof this.llm.chatWithTools === 'function');
        if (hasTools) {
          // 工具铁律：防止历史"已打开"类回复让模型以为无需调用（记忆污染免疫）
          const toolRule = { role: 'system', content: '【工具使用铁律】你不能直接改变电脑状态，必须调用工具真实执行；历史里说过"已打开/已完成"不代表现在完成了，主人再次要求就重新调用。不调工具就说"已完成"是撒谎。【工具选择规则】打开/启动应用→立即用 open-app（appName填应用名如"备忘录"对应Notes、"微信"对应WeChat，不要去找文件！应用不在文件夹里）；整理桌面→tidy-desktop（一步到位，别去逐个move-file）；设置提醒/闹钟→set-reminder；发消息→wechat-send；关闭应用→close-app；搜索资料→web-search；看目录→list-dir；点界面元素→ui-click；输入文字→type-text/ui-set；组合键→hotkey-text。选错工具=任务失败。' };
          reply = await this.llm.chatWithTools([...messages, toolRule], TOOL_SPECS,
            // 工具执行器：IPC到主进程
            async (name, args) => {
              const r = await window.windowAPI.invokeTool(name, args);
              if (!r || r.ok !== true) throw new Error((r && r.error) || '工具执行失败');
              return r.result;
            },
            // 工具调用提示（气泡显示"正在打开xx"）
            (name, args) => {
              const labels = {
                list_dir: '看看目录', read_file: '读文件', write_file: '写文件',
                move_file: '整理文件', open_app: `打开 ${args?.name || '应用'}`,
                open_url: '打开链接', run_applescript: '执行自动化',
                shell: '执行命令', screenshot: '截屏', system_info: '看系统信息',
                'open-app': `打开 ${args?.appName || '应用'}`, 'list-dir': '看看目录',
                'set-reminder': '定提醒', 'cancel-reminder': '取消提醒',
                'wechat-send': `给 ${args?.contact || '联系人'} 发微信`,
                'tidy-desktop': '整理桌面', 'close-app': `关闭 ${args?.name || '应用'}`, 'web-search': `搜索 ${String(args?.query || '').slice(0, 10)}`,
                'mouse-move': '移鼠标', 'mouse-dblclick': '双击', 'mouse-rightclick': '右键',
                'ui-click': `点 ${args?.name || '元素'}`, 'ui-set': '填内容', 'ui-list': '看界面元素',
                'mouse-drag': '拖拽', 'mouse-scroll': '滚动', 'key-press': '按键', 'hotkey-text': `按 ${args?.text || '快捷键'}`,
              };
              this.bubble.showHint(`🔧 ${labels[name] || name}中…`);
            });
          this.bubble.showText(reply, Math.max(4000, reply.length * 120));
          this._applyReplyEmotion(text, reply);
        } else {
          reply = await this.llm.chatStream(messages, (chunk) => {
            this.bubble.streamAppend(chunk);
          });
          this.bubble.streamEnd();
          this._applyReplyEmotion(text, reply);
        }
      } finally {
        clearInterval(lipTimer);
      }

      // 5. 回写：记忆 + 主人画像 + 性格事件 + 知识库提取
      await this.memory.add('short', `我回复：${reply}`);
      await this.personality.updateOwnerProfile({ text, timestamp: Date.now() });
      await this.personality.applyEvent('owner_chat');
      if (this.knowledge) {
        // 异步不阻塞回复（提取+向量化的耗时不该让主人等）
        this.knowledge.onDialogue(text, reply).catch((e) =>
          console.warn('[PetController] 知识提取失败:', e?.message));
      }

      // 6. 表情联动：按对话内容推断情绪（词典匹配，覆盖主人情绪→共情+回复语义）
      try { this._applyReplyEmotion(text, reply); } catch { /* ignore */ }
      return reply;
    } finally {
      this._chatting = false;
      // TTS 播报未进行时才解冻（语音会话里播报还要继续静着）
      if (!this._speakingVoice) this._setFrozen(false);
      // 队列接续：回复完自动处理排队的下一条
      if (this._chatQueue && this._chatQueue.length) {
        const next = this._chatQueue.shift();
        setTimeout(() => { try { this.chat(next); } catch (e) { /* ignore */ } }, 400);
      }
    }
  }

  /** 冻结/解冻小球移动（说话静止；兼容无 setFrozen 的渲染器） */
  _setFrozen(v) {
    try { this.live2d.setFrozen?.(v); } catch (e) { /* ignore */ }
  }

  // ---------- 语音对话（voiceChat：ASR 听 → 复用 chat → TTS 播报） ----------

  /** 语音状态广播（index.html 麦克风按钮据此切换形态） */
  _emitVoiceState(phase) {
    this._events?.emit?.('voice:state', { phase });
    if (phase === 'thinking' || phase === 'speaking') {
      this.live2d?.setVoicePhase?.(phase);
    } else if (phase === 'idle') {
      // 语音结束：回落到当前情绪状态（而非卡在 talking 表情）
      this.live2d?.setEmotion?.(this.state.emotion || 'normal');
    }
  }

  /**
   * 语音对话入口：
   *   recognition 模式：实时识别循环（原有）
   *   recorder 模式：VAD 持续听（说话自动分段→智谱转写→chat→TTS）
   * 再点一次 → 结束语音会话
   */
  async voiceChat() {
    if (!this.voice) {
      this.bubble.showHint?.('当前环境不支持语音，双击我用文字聊天吧～');
      return;
    }
    // 僵尸态自愈：_voiceActive 残留 true 但实际没有任何会话在跑（工具分流异常路径
    // 可能残留）→ 清标志继续开新会话，而不是把用户的"打开"误判成"挂断"
    const zombieVoice = this._voiceActive
      && !(this.doubao?.active)
      && !(this.voice?.getVoiceLoopActive?.())
      && !(this.voice?.getListening?.())
      && !this._speakingVoice && !this._chatting;
    if (zombieVoice) {
      console.warn('[PetController] 检测到语音僵尸态，自动复位');
      this._voiceActive = false;
    }
    if (this._voiceActive) {
      this.stopVoiceChat();
      return;
    }
    if (this._speakingVoice || this._chatting) {
      this.speak(pick(POOLS.busy));
      return;
    }
    this._voiceActive = true;
    this.touch();

    // ---- 引擎选择：voice-engine 配置（doubao=豆包端到端极速 | self=自建管线全能）----
    // 默认 self（GLM 原生工具调用、单一大脑、可调试）；极速纯聊天可切 doubao
    let engine = 'self';
    // 2026-08-22 统一语音架构：豆包WS（服务端VAD+识别+TTS代播）为主路；
    // 引擎默认 doubao（已配置时），self=自建VAD链路作兜底（WS失败自动落）。
    try { engine = localStorage.getItem('pet-voice-engine') || 'doubao'; } catch { /* ignore */ }
    const useDoubao = engine !== 'self' && this.doubao?.isConfigured?.();

    // ---- 豆包端到端实时语音（几百ms延迟，服务端VAD打断）----
    if (useDoubao) {
      this._emitVoiceState('listening');
      this.bubble.showHint?.('实时语音连接中…');
      let interrupted = false; // 运行中断开（非启动失败）
      let failMsg = null;
      const ok = await this.doubao.start({
        // ── 统一语音架构（2026-08-22 收敛）：豆包WS只当耳朵+嗓子，大脑唯一=本地chat ──
        // 服务端VAD断句→识别→最终文本→全部走 this.chat（工具/记忆/性格/知识库全套生效）
        // →回复由 doubao.say() 豆包音色代播。不再有 [DO:] 标签协议和两段式意图判断。
        onUserText: (text, interim) => {
          if (interim) {
            this.bubble.showHint?.(`你说：${text}`);
            return;
          }
          // 最终文本：一句话一路径——本地大脑
          if (text && this._voiceActive && !this._toolRouting) {
            this._execVoiceUnified(text.trim());
          }
        },
        onReplyText: () => {
          // 豆包bot自己的回复文本：忽略（大脑已统一本地；音频也被 suppress）
        },
        onState: (s) => this._emitVoiceState(s),
        onInterrupt: () => {
          this.bubble.showHint?.('（好，你说～）', 1500);
        },
        onError: (msg) => {
          console.warn('[PetController] 豆包实时语音错误:', msg);
          interrupted = true;
          failMsg = msg;
        },
      }).catch((e) => { failMsg = String(e); return false; });
      if (ok) {
        if (this.avatar?.isConfigured?.() && !this.avatar.active) {
          this.avatar.start({ onState: () => {}, onError: (m) => console.warn('[PetController] 数字人:', m) }).catch(() => {});
          this.bubble.showHint?.('数字人连接中…', 2000);
        }
        return;
      }
      // 启动失败（key错/网络断/超时）→ 降级普通链路。
      // ⚠️ 必须等豆包彻底死透再起 VAD：若豆包连接其实已建（半死状态），
      // VAD 采集与豆包僵尸转发并行 → 同一句话两路回复同时播 = 语音叠加！
      this._voiceActive = false;
      try { await this.doubao.stop(); } catch { /* ignore */ }
      if (interrupted) {
        this.bubble.showHint?.('实时语音连不上，先用普通模式～', 2500);
      }
      // 落到下面 VAD 链路（同一调用内继续，不递归重试避免死循环）
    }

    // ---- 优先级2：VAD 录音转写链路 ----
    const mode = this.voice.getASRMode?.();
    if (mode === 'none' || !this.voice.isASRAvailable()) {
      this._voiceActive = false;
      this.bubble.showHint?.('麦克风不可用（未检测到录音能力），双击我用文字聊天吧～', 4500);
      return;
    }
    if (mode === 'recorder' && typeof this.voice.startVoiceLoop === 'function') {
      // VAD 持续听模式：说话自动分段，静音断句送转写
      this._emitVoiceState('listening');
      this.bubble.showHint?.('在听…（说完停顿1秒我就懂了，再点麦克风结束）');
      const ok = await this.voice.startVoiceLoop({
        onPartial: () => { /* VAD 无中间文本，不刷屏 */ },
        onFinal: (text) => this._processVoiceText(text),
        onError: (msg) => this._onVoiceError(msg),
        onState: (s) => this._emitVoiceState(s === 'transcribing' ? 'thinking' : 'listening'),
      });
      if (!ok) {
        this._voiceActive = false;
        this._emitVoiceState('idle');
      }
      return;
    }
    this._startVoiceListen();
  }

  /** VAD 持续听模式的会话终止（VAD 循环 + 云端TTS 一起停） */
  _stopVoiceLoop() {
    this.voice?.stopVoiceLoop?.();
    this.voice?.stopCloudSpeak?.();
  }

  /** 开始一轮听（实时识别模式） */
  _startVoiceListen() {
    this._emitVoiceState('listening');
    this.bubble.showHint?.('在听…（再点麦克风结束）');
    const ok = this.voice.startListen({
      onPartial: (text) => this.bubble.showHint?.(`你说：${text}`),
      onFinal: (text) => this._processVoiceText(text),
      onError: (msg) => this._onVoiceError(msg),
    });
    if (!ok) {
      this._voiceActive = false;
      this._emitVoiceState('idle');
    }
  }

  /**
   * 按住说话·开始（降级模式：无 SpeechRecognition 时用录音+云端转写）
   * 按下麦克风按钮时调用；结合 voiceHoldEnd 完成一次问答（单次会话）。
   */
  async voiceHoldStart() {
    if (!this.voice) {
      this.bubble.showHint?.('当前环境不支持语音，双击我用文字聊天吧～');
      return;
    }
    if (this._voiceActive) return;
    if (this._speakingVoice || this._chatting) {
      this.speak(pick(POOLS.busy));
      return;
    }
    this._voiceActive = true;
    this.touch();
    this._emitVoiceState('listening');
    this.bubble.showHint?.('在听…（松开结束）');
    const ok = await this.voice.startRecording({
      onError: (msg) => this._onVoiceError(msg),
    });
    if (!ok) {
      this._voiceActive = false;
      this._emitVoiceState('idle');
    }
  }

  /** 按住说话·结束：停录 → 云端转写 → 复用 chat → TTS 播报 */
  async voiceHoldEnd() {
    if (!this._voiceActive) return;
    this._emitVoiceState('thinking');
    let blob = null;
    try { blob = await this.voice.stopRecording(); } catch { blob = null; }
    if (!blob) {
      this.bubble.showHint?.('没听清…再按住试一次？', 3500);
      this._voiceActive = false;
      this._emitVoiceState('idle');
      return;
    }
    let text = '';
    try {
      text = await this.voice.transcribe(blob);
    } catch (err) {
      this._onVoiceError(err && err.message);
      return;
    }
    if (!text) {
      this.bubble.showHint?.('没听清…再按住试一次？', 3500);
      this._voiceActive = false;
      this._emitVoiceState('idle');
      return;
    }
    this.bubble.showHint?.(`你说：${text}`);
    let reply = '';
    try {
      reply = await this.chat(text);
    } catch (err) {
      console.error('[PetController] 语音 chat 失败:', err);
    }
    if (reply) await this._speakReply(reply);
    this._voiceActive = false; // 单次会话结束（按住说话不循环）
    this._emitVoiceState('idle');
  }

  /** 拿到完整用户语句 → chat → TTS 播报（可被打断）→ 继续听（打电话式循环） */


  /**
   * 行动回路（CUA 式 act-and-verify）：任务 → 截屏 → 定位 → 执行 → 验证 → 重试
   * 触发：指令是"操作类"（点/关/拖/输入 到屏幕目标），区别于"看屏类"（只描述）。
   * 最多 maxSteps 轮，每轮重新截屏（屏幕会变化），失败换坐标重试。
   * 返回：成功与否的自然语言汇报（供豆包代播）。
   */





  /** 豆包 DO 标签执行器：豆包已判断意图，这里只管干活 */

  /** 屏幕相关请求判定（触发实时截屏分析） */



  /** LLM 意图判断：是否需要调用工具（理解口语化表达，10s超时默认false） */




  /** 语音出错：SR 致命错误自动降级 VAD；其他错误友好提示 + 结束会话 */

  /** 结束语音会话（停止听 + 停止播报 + 解除打断 + 停豆包实时） */
  stopVoiceChat() {
    this._voiceActive = false;
    if (this.doubao?.active) {
      this.bubble.streamEnd?.();
      // stop 返回统一 promise（内部防并发）；此处不 await 但 start 会等它——
      // 快速"挂断→再开"时监听器绝不叠加（词重复两遍的根因）
      try { this.doubao.stop(); } catch { /* ignore */ }
    }
    if (this.voice) {
      this.voice.abortListen?.();
      this.voice.stopSpeak?.();
      this.voice.stopEdgeSpeak?.();
      this.voice.disarmInterrupt?.();
      this.voice.stopAllTTS?.();
      this._stopVoiceLoop?.();
    }
    this._speakingVoice = false;
    this._setFrozen(false);
    this._emitVoiceState('idle');
  }

  /** 直播模式（弹幕事件由 T8 接入，这里只管理状态位与提示） */
  startLiveMode() {
    this.state.liveMode = true;
    this.setEmotion('excited', 10000);
    this._proactive('live_on', '直播刚刚开始');
    return this.getState();
  }

  stopLiveMode() {
    this.state.liveMode = false;
    this.speak(pick(POOLS.live_off));
    return this.getState();
  }

  // ---------- 交互入口（上层UI调用） ----------

  /** 任何主人交互都会调用：重置无聊/困倦计时 */
  touch() {
    this.state.lastInteraction = Date.now();
    this._boredAnnounced = false;
    this._sleepyAnnounced = false;
  }

  /** 摸头（onHit 触发） */
  pat() {
    this.touch();
    this.setEmotion('happy', 8000);
    this.personality.applyEvent('owner_praise', 0.5);
    this.speak(pick(POOLS.pat));
  }

  // ---------- 内部：消息组装 ----------


  // ---------- 内部：主动说话 ----------

  /**
   * 主动说一句话：真实LLM生成（带人设+动因），mock/失败走本地台词池
   * @param {string} kind 台词池key（bored/sleepy/scene_work/late_night/live_on...）
   * @param {string} [hint] 情境描述（给LLM；含屏幕感知 detail 时为"有动因"交流）
   */
  async _proactive(kind, hint) {
    let line = null;
    const isMock = !this.llm || this.llm.getConfig?.().model === 'mock';
    if (!isMock) {
      try {
        line = await this.llm.chat([
          { role: 'system', content: this.personality.getSystemPrompt() + '\n你在主动开口（不是回答问题），一句话要短（25字内）、自然口语、有明确动因（因为看到了什么/想到了什么才说），禁止无来由的寒暄。' },
          {
            role: 'user',
            content: `${hint ? `动因：${hint}。` : ''}请以宠物的身份主动对主人说一句话（状态：${kind}），一句话即可，自然口语，不要加引号。`,
          },
        ]);
        if (typeof line !== 'string' || line.startsWith('（')) line = null; // 错误串→兜底
        if (line) line = line.slice(0, 60); // 防超长
      } catch (e) {
        line = null;
      }
    }
    if (!line) line = pick(POOLS[kind] || POOLS.bored);
    this.speak(line);
    return line;
  }

  // ---------- 内部：行为循环 ----------

  _tick() {
    const now = Date.now();
    const idle = now - this.state.lastInteraction;
    const hour = new Date().getHours();

    // 深夜关怀（每晚一次；白天重置）
    if ((hour >= 23 || hour < 5) && !this._lateNightApplied) {
      this._lateNightApplied = true;
      this.personality.applyEvent('late_night');
      if (Math.random() < 0.5) this._proactive('late_night', '现在是深夜，主人还坐在电脑前');
    } else if (hour >= 6 && hour < 23) {
      this._lateNightApplied = false;
    }

    if (idle >= this.opts.sleepyMs) {
      if (!this._sleepyAnnounced) {
        this._sleepyAnnounced = true;
        this.setEmotion('sleepy', this.opts.sleepyMs); // 睡到下次交互
        this._proactive('sleepy', '主人已经一小时没理我了');
        this.personality.applyEvent('long_idle');
      }
    } else if (idle >= this.opts.boredMs) {
      if (!this._boredAnnounced) {
        this._boredAnnounced = true;
        this.setEmotion('bored', this.opts.boredMs);
        this._proactive('bored', '主人半个小时没理我了');
        this.personality.applyEvent('long_idle');
      }
    }
  }

  /** 场景变化响应：基于真实屏幕内容的有动因主动交流（非随机刷屏） */
  _onSceneChange({ scene, confidence, detail } = {}) {
    if (!scene || scene === 'unknown') return;
    // 场景理解引擎：LLM 识别结果注入为 hint（供 isDnd/getStableScene 使用）
    this.perception?.setSceneHint?.(scene);
    // DND 门控：会议/视频/演示/深夜 或 引擎判 idle → 本次不主动搭话
    if (this.perception?.isDnd?.(scene)) {
      console.log('[PetController] 免打扰场景，跳过主动搭话:', scene);
      return;
    }
    const now = Date.now();
    if (scene === this._lastSceneCommented) return;
    if (now - this._lastSceneCommentAt < this.opts.sceneCommentGapMs) return;
    if (Math.random() > this.opts.sceneCommentProb) return;

    this._lastSceneCommented = scene;
    this._lastSceneCommentAt = now;

    const evtMap = { work: 'scene_work', fun: 'scene_fun', slack: 'scene_slack' };
    if (evtMap[scene]) this.personality.applyEvent(evtMap[scene]);

    // 有动因的主动交流：感知 detail（GLM-4V 看到的真实屏幕内容）+ 场景 →
    // LLM 生成针对性话题（如看到报错→主动帮忙、久看视频→提醒休息）
    this._proactiveWithCause(scene, detail);
  }

  /**
   * 带动因的主动说话：屏幕感知内容 → LLM 生成针对性开场
   * 动因规则（内置）+ LLM 润色：
   *   - work + 连续工作 → 加油/提醒休息
   *   - work + 屏幕有报错/异常 → 主动关心要不要帮忙
   *   - fun → 对内容本身搭话（看到什么就聊什么）
   *   - slack → 轻松吐槽
   *   - rest → 静静陪伴
   */
  async _proactiveWithCause(scene, detail) {
    const now = new Date();
    const hour = now.getHours();
    let cause = '';
    switch (scene) {
      case 'work':
        if (/报错|错误|error|exception|失败|bug|红/i.test(detail || '')) {
          cause = `主人屏幕上似乎出现了报错/异常（${detail}），主动关心是否需要帮忙`;
        } else if (this._lastSceneCommented === 'work' && hour >= 12 && hour < 14) {
          cause = `主人在午间还在工作（${detail}），提醒吃午饭`;
        } else if (hour >= 22 || hour < 6) {
          cause = `主人深夜还在工作（${detail}），心疼提醒早点休息`;
        } else {
          cause = `主人在专注工作（${detail}），简短鼓励不打断`;
        }
        break;
      case 'fun':
        cause = `主人在放松（${detail}），对屏幕内容本身搭话，表现兴趣`;
        break;
      case 'slack':
        cause = `主人在摸鱼（${detail}），轻松吐槽但不批评`;
        break;
      case 'rest':
        cause = '主人离开了座位，安静等待不打扰';
        break;
      default:
        cause = `主人屏幕：${detail || '切换了内容'}`;
    }
    await this._proactive('scene_' + scene, cause);
  }
}

export default PetController;
export { PetController, EMOTIONS, DEFAULTS, CHARACTER_IDS, DEFAULT_CHARACTER_ID };
