// ============================================================
// pet.js — 宠物控制器：状态机 + 主动行为引擎
// 消费：llm.js / memory.js / personality.js / live2d.js（被 sprite.js 替代）/ bubble.js（依赖注入）
// 契约见 CONTRACT.md：//   setEmotion / playMotion / speak / getState / chat / startLiveMode / stopLiveMode / setCharacter }
// ============================================================

import PersonalityEngine from './personality.js';
import MemoryService from './memory.js';
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
  { type: 'function', function: { name: 'read_file', description: '读取文本文件内容', parameters: { type: 'object', properties: { file: { type: 'string', description: '文件绝对路径' } }, required: ['file'] } } },
  { type: 'function', function: { name: 'write_file', description: '写文件（新建/覆盖）', parameters: { type: 'object', properties: { file: { type: 'string', description: '目标路径' }, content: { type: 'string', description: '写入内容' } }, required: ['file', 'content'] } } },
  { type: 'function', function: { name: 'move_file', description: '移动/重命名文件或目录（可用来整理桌面）', parameters: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } }, required: ['src', 'dst'] } } },
  { type: 'function', function: { name: 'open_url', description: '用默认浏览器打开网址', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'run_applescript', description: '执行AppleScript自动化macOS（控制窗口/通知/应用消息等）', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'shell', description: '执行白名单shell命令（ls/cat/mkdir/cp/mv/open/say等）', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'screenshot', description: '截取全屏保存到/tmp（需要屏幕录制权限）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'system_info', description: '获取系统信息（用户/内存/时间）', parameters: { type: 'object', properties: {}, required: [] } } },
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
          const toolRule = { role: 'system', content: '【工具使用铁律】你不能直接改变电脑状态，必须调用工具真实执行；历史里说过"已打开/已完成"不代表现在完成了，主人再次要求就重新调用。不调工具就说"已完成"是撒谎。【工具选择规则】打开/启动应用→立即用 open-app（appName填应用名如"备忘录"对应Notes、"微信"对应WeChat，不要去找文件！应用不在文件夹里）；整理桌面→tidy-desktop（一步到位，别去逐个move_file）；设置提醒/闹钟→set-reminder；发消息→wechat-send；关闭应用→close-app；搜索资料→web-search；看目录→list-dir；点界面元素→ui-click；输入文字→type-text/ui-set；组合键→hotkey-text。选错工具=任务失败。' };
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
    try { engine = localStorage.getItem('pet-voice-engine') || 'self'; } catch { /* ignore */ }
    const useDoubao = engine === 'doubao' && this.doubao?.isConfigured?.();

    // ---- 豆包端到端实时语音（几百ms延迟，服务端VAD打断）----
    if (useDoubao) {
      this._emitVoiceState('listening');
      this.bubble.showHint?.('实时语音连接中…');
      let interrupted = false; // 运行中断开（非启动失败）
      let failMsg = null;
      const ok = await this.doubao.start({
        onUserText: (text, interim) => {
          if (interim) this.bubble.showHint?.(`你说：${text}`);
          // 双保险①：豆包回复带 [DO:] → onReplyText 解析执行（主路径）
          // 双保险②：豆包没带标签（模型不稳定）但转写明显是操作指令 → 3秒后兜底执行
          if (!interim && text && !this._toolRouting) {
            const ACTION = /^(打开|关闭|关掉|点击|点一下|点|启动|帮我.{0,10}(打开|关闭|点击|发|设)|设置?个?提醒|定个?提醒|发(微信|消息)|按(一下)?|输入|截屏|截图)/.test(text.trim());
            if (ACTION) {
              clearTimeout(this._doubaoFallbackT);
              this._doubaoFallbackText = text.trim();
              this._doubaoFallbackT = setTimeout(() => {
                if (!this._toolRouting && this._voiceActive) {
                  console.log('[PetController] DO兜底（豆包未带标签）:', this._doubaoFallbackText);
                  this._execDoubaoCommand(this._doubaoFallbackText);
                }
              }, 3000); // 3秒窗口等豆包自己的 DO 标签，没等到就兜底
            }
          }
        },
        onReplyText: (delta) => {
          this.bubble.streamAppend(delta);
          // 豆包意图自判：回复含 [DO:指令] → 剥标签执行（豆包负责判断，渲染层只解析）
          const m = /\[DO[:：]\s*([^\]\n]{2,80})\]/.exec(delta || '');
          if (m && !this._toolRouting && this._voiceActive) {
            clearTimeout(this._doubaoFallbackT); // 豆包带标签了，取消兜底
            const cmd = m[1].trim();
            console.log('[PetController] 豆包DO标签:', cmd);
            this._execDoubaoCommand(cmd);
          }
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
   * 豆包实时模式·智能工具分流（两段式）：
   * 第一段：LLM 判断是否需要调工具（含理解口语化表达如"打开微信/看看桌面"）
   *   - 纯聊天 → 不介入（豆包低延迟回复）
   *   - 工具意图 → 先让豆包回一句"好的，我来处理"（用户听到即时响应）
   * 第二段：GLM+function-calling 执行 → 结果由豆包音色代播
   * 防抖：执行期间重复指令直接忽略
   */
  _maybeVoiceToolRoute(text) {
    if (!this._voiceActive || this._toolRouting) return;
    this._toolRouting = true;
    (async () => {
      try {
        // ── 第一段：LLM 意图判断（快，一次小请求）──
        const needTool = await this._llmNeedTool(text);
        if (!needTool) {
          this._toolRouting = false;
          return; // 纯聊天：不介入，豆包自己回复
        }
        // 豆包人设已含工具能力——它自己会爽快应答"好嘞马上打开"（无需我方补话，
        // 之前补话导致"我没这个功能"+"好嘞帮你打开"双声打架）。此处只等它应答完。
        this._emitVoiceState('speaking');
        await new Promise(r => setTimeout(r, 2500));
        if (!this._voiceActive) return;
        // ── 第二段：执行 ──
        this.doubao?.suppressAudio?.();
        this._emitVoiceState('thinking');

        // 屏幕操作类 → CUA 行动回路（截屏→定位→执行→验证循环，自动重试）
        let reply;
        if (this._isScreenAction?.(text) && this._canCaptureScreen()) {
          const result = await this._screenActionLoop(text);
          reply = result;
          this.bubble.showText(result, Math.max(4000, result.length * 120));
        } else {
          this.bubble.showHint?.(`🔧 处理：${text.slice(0, 30)}`, 2500);
          reply = await this.chat(text); // GLM + 工具链
        }
        if (reply && this._voiceActive && this.doubao?.active) {
          this.doubao.say?.(reply); // 豆包音色播结果
          this.bubble.showText(reply, Math.max(4000, reply.length * 120));
          this._emitVoiceState('speaking');
          await new Promise(r => setTimeout(r, Math.min(15000, 1500 + reply.length * 180)));
        } else if (reply) {
          await this._speakReply(reply); // 降级链路
        }
      } catch (e) {
        console.warn('[PetController] 工具分流失败:', e?.message);
        this.bubble.showHint?.('刚才那个没处理好，再说一次？', 2500);
      } finally {
        this._toolRouting = false;
        this.doubao?.resumeAudio?.();
        this._micMutedGuard?.();
        if (this._voiceActive && this.doubao?.active) this._emitVoiceState('listening');
      }
    })();
  }

  /**
   * 行动回路（CUA 式 act-and-verify）：任务 → 截屏 → 定位 → 执行 → 验证 → 重试
   * 触发：指令是"操作类"（点/关/拖/输入 到屏幕目标），区别于"看屏类"（只描述）。
   * 最多 maxSteps 轮，每轮重新截屏（屏幕会变化），失败换坐标重试。
   * 返回：成功与否的自然语言汇报（供豆包代播）。
   */
  /**
   * 任务验证器：任务分类 → 专属验证策略（判断"真完成"的统一入口）。
   * 每类任务有独立的证据链，不依赖单一按钮文字：
   *  - 播放/暂停：按钮语义双向校验 + 执行前记录状态，要求状态翻转
   *  - 打开应用：目标进程存在（系统级）
   *  - 打开面板/页面：AX 树新增元素对比（执行前快照 vs 执行后）
   *  - 输入文字：目标输入框 value 非空
   *  - 文件操作：文件系统直接查
   *  - 其他：AX 树变化 + vision 证据
   */
  async _verifyTask(task, axTreeBefore) {
    const taskS = String(task);
    // 1) 播放/暂停类：终极证据=麦克风听扬声器能量（2秒采样，RMS>0.02=有声）
    //    （按钮文本不可靠：酷狗切换后 AX desc 不刷新）
    if (/播放|放.*(歌|音乐|电台)/.test(taskS) && !/暂停|停/.test(taskS)) {
      try {
        const r = await window.windowAPI.invokeTool('mic-energy', {});
        const rms = Number(r?.result) || 0;
        if (rms > 0.02) return { ok: true, evidence: '扬声器有声（RMS=' + rms.toFixed(3) + '）' };
        return { ok: false, evidence: '扬声器静默（RMS=' + rms.toFixed(3) + '）' };
      } catch { /* 无此工具则落按钮检测 */ }
    }
    if (/(暂停|停止).*(音乐|歌|播放)/.test(taskS)) {
      try {
        const r = await window.windowAPI.invokeTool('mic-energy', {});
        const rms = Number(r?.result) || 0;
        if (rms < 0.01) return { ok: true, evidence: '已静音（RMS=' + rms.toFixed(3) + '）' };
      } catch { /* ignore */ }
    }
    // 1b) 按钮状态（次选，酷狗等不刷新的会漏——由上面能量法兜底）
    if (/播放|放.*(歌|音乐|电台)/.test(taskS)) {
      try {
        const r = await window.windowAPI.invokeTool('ui-list', {});
        const t = String(r?.result || '');
        const btn = t.split('\n').find((l) => /\[(\d+)\].*(暂停|播放)/.test(l) && !/列表|随机|电台|模式|歌单/.test(l));
        if (btn) {
          const nowPaused = btn.includes('暂停');
          const wasPaused = axTreeBefore ? (axTreeBefore.split('\n').find((l) => /暂停/.test(l) && !/列表|随机|电台|模式|歌单/.test(l)) ? true : false) : false;
          if (nowPaused !== wasPaused) return { ok: true, evidence: nowPaused ? '已暂停' : '已开始播放' };
          return { ok: false, evidence: nowPaused ? '仍处于暂停（点击未生效）' : '本来就在播放' };
        }
      } catch { /* ignore */ }
    }
    // 2) 打开应用类：查进程
    if (/打开|启动/.test(taskS) && /微信|酷狗|网易云|备忘录|浏览器|Safari|Chrome|音乐|计算器|日历|访达/.test(taskS)) {
      const APP_PROC = { '微信': 'WeChat', '酷狗': 'KugouMusic', '网易云': 'NeteaseMusic', '备忘录': 'Notes', '浏览器': 'Safari', 'Safari': 'Safari', 'Chrome': 'Google Chrome', '计算器': 'Calculator', '日历': 'Calendar', '访达': 'Finder' };
      const key = Object.keys(APP_PROC).find((k) => taskS.includes(k));
      if (key) {
        try {
          const r = await window.windowAPI.invokeTool('shell', { cmd: 'pgrep -x ' + APP_PROC[key] });
          if (String(r?.result || '').trim()) return { ok: true, evidence: APP_PROC[key] + ' 进程已运行' };
          return { ok: false, evidence: '未检测到进程' };
        } catch { /* ignore */ }
      }
    }
    // 3) 通用：AX 树有变化（元素数/内容差异）
    try {
      const r = await window.windowAPI.invokeTool('ui-list', {});
      const after = String(r?.result || '');
      if (axTreeBefore && axTreeBefore !== after) {
        const aL = axTreeBefore.split('\n').filter(Boolean);
        const bL = after.split('\n').filter(Boolean);
        const added = bL.filter((l) => !aL.includes(l)).length;
        if (added > 0) return { ok: true, evidence: '界面新增 ' + added + ' 个元素（状态已变化）' };
      }
    } catch { /* ignore */ }
    return null; // 无法判定 → 由 vision evidence 兜底
  }

  _isScreenAction(text) {
    return /(点|点击|单击|双击|右键|关掉|关闭|按下|勾选|选择|拖|输入|填).{0,20}(它|那个|这个|按钮|弹窗|窗口|选项|框|图标|位置|搜索|输入)|帮我(点|关|拖|选|填|处理)|(点|关)一下(它|那个)|在.{0,12}(里|中|上面).{0,6}(输入|填|写)|^(播放|放).{0,12}(歌|音乐|电台|电台歌曲|歌单)|(播放|放一?首)/.test(text);
  }

  _canCaptureScreen() {
    return typeof window.screenAPI?.getScreenshot === 'function';
  }

  async _screenActionLoop(task) {
    this._screenLooping = true;
    try {
      // ── 预处理：播放类任务（播放XX/打开XX电台）先启动目标应用 ──
      const playApp = task.match(/播放|听.*(歌|音乐|电台)/) && task.match(/酷狗|网易云|QQ音乐|QQ音乐|SpoBox|iTunes|音乐/);
      if (playApp) {
        const APP_MAP = { '酷狗': 'KugouMusic', '网易云': 'NeteaseMusic', 'QQ音乐': 'QQMusic', 'iTunes': 'Music' };
        const key = Object.keys(APP_MAP).find((k) => task.includes(k));
        if (key) {
          try { await window.windowAPI.invokeTool('open-app', { appName: APP_MAP[key] }); await new Promise((r) => setTimeout(r, 1800)); } catch { /* ignore */ }
        }
      }
      // ── 快通路：任务里提到明确元素名 → AX 名字直击（毫秒级，零截图）──
      // 提取候选名：引号内容 → "的XX按钮" → 动词短语 → 宽松兜底（去英文/助词后再提取）
      const quoted = task.match(/["''「」“”]([^"''「」“”]{1,12}?)["''「」“”]/);
      const de = task.match(/的([一-龥A-Za-z0-9]{2,8}?)按钮/);
      const verbObj = task.match(/(?:点击|点一下|点|按一下|按|关掉|关闭|按下)(?:那个)?([一-龥A-Za-z0-9]{2,8}?)(?:按钮|选项|图标|菜单|标签|键)/);
      let cand = (quoted?.[1] || de?.[1] || verbObj?.[1] || '').trim();
      if (!cand) {
        const cleaned = task.replace(/[A-Za-z]+|的|一下|那个|帮我/g, '');
        const loose = cleaned.match(/(?:点击|点|按|关掉|关闭)([一-龥]{2,8})/);
        cand = (loose?.[1] || '').trim();
      }
      if (cand && cand.length >= 2) {
        try {
          this.bubble.showHint?.(`⚡ 直接找「${cand}」…`, 1500);
          const r = await window.windowAPI.invokeTool('ui-click', { name: cand });
          const rs = String(r?.result || r || '');
          if (r?.ok === true && rs.includes('已') && !rs.includes('执行失败')) {
            return `搞定啦（直击）！${rs.slice(0, 50)}`;
          }
        } catch { /* AX 没找到 → 落视觉回路 */ }
      }
      return await this._screenActionLoopInner(task);
    } finally { this._screenLooping = false; }
  }

  async _screenActionLoopInner(task) {
    const MAX_STEPS = 8; // 多步任务（如"播放电台"需 开应用→找入口→点播放 多轮）4轮不够
    let axTreeBefore = null; // 执行前 AX 快照（供 _verifyTask 状态对比）
    let silentTries = 0; // 同一目标静默点击次数（2次无效自动降级真实点击——菜单栏等系统元素不响应AX）
    let lastTarget = '';
    this.bubble.showHint?.('🎯 开始操作…', 2000);
    for (let step = 1; step <= MAX_STEPS; step++) {
      try {
        // 1) 感知（Codex 式双通道）：
        //    a. AX 控件树（首选）：读系统 Accessibility 的元素名+精确坐标——零猜测
        //    b. 截图（辅助）：树里找不到目标（自绘UI/游戏）时视觉兜底
        // 任务提到具体应用 → 每轮确保其在前台（置顶小球会抢焦点，需反复激活）
        const APP_MAP2 = { '酷狗': 'KugouMusic', '网易云': 'NeteaseMusic', 'QQ音乐': 'QQMusic', '微信': 'WeChat', '备忘录': 'Notes', '浏览器': 'Safari', 'Safari': 'Safari', 'Chrome': 'Google Chrome', '访达': 'Finder', 'Finder': 'Finder', 'iTunes': 'Music' };
        const appKey = Object.keys(APP_MAP2).find((k) => task.includes(k));
        if (appKey) {
          try { await window.windowAPI.invokeTool('open-app', { appName: APP_MAP2[appKey] }); await new Promise((r) => setTimeout(r, 600)); } catch { /* ignore */ }
        }
        let axTree = '';
        try {
          const r = await window.windowAPI.invokeTool('ui-list', {});
          if (r?.ok && r.result) axTree = String(r.result);
        } catch { /* ignore */ }
        if (step === 1) axTreeBefore = axTree; // 记录初始状态
        const b64 = this._canCaptureScreen() ? await window.screenAPI.getScreenshot() : null;
        if (!b64 && !axTree) return '截屏失败，没法操作屏幕';
        const img = b64 || null;
        if (!img) return '无法截屏';
        const treeHint = axTree
          ? `\n【可交互元素表：索引 角色 名称 状态 @坐标】\n${axTree.split('\n').slice(0, 35).join('\n')}`
          : '';
        const visionP = this.llm.vision(img,
          `任务："${task}"。当前屏幕截图（第${step}轮，此前已执行过${step - 1}次点击）。${treeHint}
判定规则：
- done=true：任务意图已达成（目标面板弹出/状态变化/文字可见）。例："点时间"→面板弹出即完成；"播放歌曲"→正在播放/播放面板出现即完成。
- 定位规则：元素表里有的目标，直接用表里的绝对坐标（填入x_abs/y_abs），准确无误；表里没有才从截图估归一化坐标。
done 判定必须给证据（防误报）：done=true 时 evidence 必须写明看到了什么（如"播放条显示歌名《xx》且按钮变暂停"/"目标面板已展开且内容可见"）。仅"页面打开了/点过了"不算完成——任务的核心结果必须已发生。
严格JSON：{"done":bool, "evidence":"done时的可见证据，没有则空", "element_index":想点的元素索引号(来自元素表[N]，没有合适则-1), "target":{"name":"元素名","x":0-1000归一化,"y":0-1000,"x_abs":表里的绝对x或-1,"y_abs":表里的绝对y或-1,"action":"click|dblclick|rclick|type|none"}, "type_text":"", "status":"20字内画面状态"}
（优先用 element_index 点元素——索引由执行器换算真实坐标零误差；元素表没有目标才用x/y估坐标）`,
          'image/png');
        const analysis = await Promise.race([visionP, new Promise((rj) => setTimeout(() => rj(new Error('vision超时45s')), 45000))]).catch((e) => { throw e; });
        const m = String(analysis || '').match(/\{[\s\S]*\}/);
        if (!m) return `第${step}轮看不懂屏幕，放弃了。任务：${task}`;
        const j = JSON.parse(m[0]);
        // 2.5) 系统级验证器：done 声称完成 → 用该任务类型的专属证据链复核
        if (j.done) {
          const ver = await this._verifyTask(task, axTreeBefore);
          if (ver && ver.ok === false) {
            console.log('[行动回路] 验证器否决:', ver.evidence, '→ 继续执行');
            j.done = false;
            j.target = j.target || {};
            if (!j.target.action || j.target.action === 'none') j.target.action = 'click';
          } else if (ver && ver.ok === true) {
            j.evidence = ver.evidence; // 系统证据覆盖 vision 证据（更硬）
          }
        }
        // 2) 完成 → 证据校验（防"点开了≠完成了"误报）：无证据的 done 不信，继续干活
        if (j.done) {
          const ev = String(j.evidence || '').trim();
          if (!ev || ev.length < 4) {
            console.log('[行动回路] done无证据，忽略继续执行');
          } else {
            return step === 1 ? `搞定啦！${ev}` : `搞定啦（${step}轮）！${ev}`;
          }
        }
        console.log(`[行动回路] 第${step}轮 done=false target=(${j.target?.x},${j.target?.y}) status=${j.status}`);
        // 3) 无目标无动作 → 报告卡住
        if (!j.target || j.target.action === 'none') {
          if (step >= MAX_STEPS) return `试了${step}轮还是不知道怎么操作：${j.status}`;
          continue; // 再看一眼（屏幕可能在动）
        }
        // 3.5) 播放类任务专项验证（酷狗实测语义）：
        // 按钮显示"暂停"=当前处于暂停状态（没在放）！必须再点它才会开始播放。
        // 点击后再查：按钮变"播放/继续"才算真正在放歌。
        if (j.done && /播放|放.*歌|电台|音乐/.test(task) && axTree) {
          const btnLine = axTree.split('\n').find((l) => /暂停|播放/.test(l) && !/列表|随机|电台|歌单|模式/.test(l));
          const paused = /暂停/.test(btnLine || '');
          if (paused) {
            console.log('[行动回路] 播放任务但按钮=暂停（未在放）→ 补一次点击启动播放');
            j.done = false;
            j.target = j.target || { name: '播放按钮' };
            j.target.action = 'click';
            // 优先点暂停按钮本身（点它=恢复播放）
            const mBtn = /\[(\d+)\].*暂停/.exec(btnLine || '');
            if (mBtn) j.element_index = Number(mBtn[1]);
          }
        }

        // 4) 行动：索引优先（模型给 or 本地关键词兜底匹配）> 绝对坐标 > 归一化估算
        let elIdx = Number(j.element_index);
        // 模型失能兜底：element_index=-1 → 用任务关键词直查元素表（本地匹配零智力依赖）
        if (!(Number.isInteger(elIdx) && elIdx >= 0)) {
          const kwMap = [
            [/播放|放歌|听歌|放音乐/, /\[(\d+)\]\s*\w+\s*\/?暂停(?!列表|模式)/],
            [/暂停|停止/, /\[(\d+)\]\s*\w+\s*\/?播放(?!列表|模式|电台|歌单)/],
            [/搜索|查找/, /\[(\d+)\]\s*AX(SearchField|TextField)/],
          ];
          for (const [kw, re] of kwMap) {
            if (kw.test(task) && axTree) {
              const m2 = re.exec(axTree);
              if (m2) { elIdx = Number(m2[1]); console.log('[行动回路] 模型未给索引，本地匹配元素[' + elIdx + ']'); break; }
            }
          }
        }
        if (Number.isInteger(elIdx) && elIdx >= 0 && (j.target?.action === 'click' || !j.target?.action)) {
          try {
            const r = await window.windowAPI.invokeTool('ui-click', { index: elIdx, app: appKey ? APP_MAP2[appKey] : undefined });
            if (r?.ok === true) {
              this.bubble.showHint?.(`🖱 点元素[${elIdx}] · 第${step}轮`, 2000);
              await new Promise((r2) => setTimeout(r2, 1000)); // 等界面响应，下一轮刷新快照验证
              continue;
            }
          } catch (e) { console.warn('[行动回路] 索引点击失败，落坐标:', e?.message); }
        }
        const absX = Number(j.target.x_abs), absY = Number(j.target.y_abs);
        let px = (Number.isFinite(absX) && absX > 10) ? Math.round(absX) : Math.round((Number(j.target.x) / 1000) * screen.width);
        let py = (Number.isFinite(absY) && absY > 10) ? Math.round(absY) : Math.round((Number(j.target.y) / 1000) * screen.height);
        // 坐标防呆：落到屏幕角落(0,0 附近)=无效目标 → 本轮跳过不点（防误点）
        if (px < 30 && py < 30) {
          console.log('[行动回路] 目标坐标无效 (' + px + ',' + py + ')，跳过本轮点击');
          continue;
        }
        const act = j.target.action;
        const sameTarget = lastTarget === j.target.name;
        silentTries = sameTarget ? silentTries + 1 : 0;
        lastTarget = j.target.name;
        const useSilent = silentTries < 2; // 前两次静默
        let actDesc = act === 'click' ? '点击' : act === 'dblclick' ? '双击' : act === 'rclick' ? '右键' : '输入';
        if (act === 'click' && !useSilent) actDesc += '(真实)';
        this.bubble.showHint?.(`🖱 ${actDesc} ${j.target.name} (${px},${py}) · 第${step}轮`, 2000);
        if (act === 'click') await window.windowAPI.invokeTool('click-at', { x: px, y: py, silent: useSilent });
        else if (act === 'dblclick') await window.windowAPI.invokeTool('mouse-dblclick', { x: px, y: py });
        else if (act === 'rclick') await window.windowAPI.invokeTool('mouse-rightclick', { x: px, y: py });
        else if (act === 'type') {
          await window.windowAPI.invokeTool('click-at', { x: px, y: py, silent: true });
          await new Promise(r => setTimeout(r, 400));
          await window.windowAPI.invokeTool('type-text', { text: String(j.type_text || '') });
        }
        await new Promise(r => setTimeout(r, 900)); // 等界面响应，下一轮截屏验证
      } catch (e) {
        console.warn('[PetController] 行动回路异常:', e?.message);
        if (step >= MAX_STEPS) return `操作出错了：${e?.message || '未知'}`;
      }
    }
    return `试了${MAX_STEPS}轮没完成，我先停了（怕乱点）。你可以再说得更具体些～`;
  }

  /** 豆包 DO 标签执行器：豆包已判断意图，这里只管干活 */
  _execDoubaoCommand(cmd) {
    this._toolRouting = true;
    (async () => {
      try {
        this.doubao?.suppressAudio?.();
        this._emitVoiceState('thinking');
        let result;
        if (this._isScreenAction?.(cmd) && this._canCaptureScreen()) {
          result = await this._screenActionLoop(cmd); // 屏幕操作→CUA回路（含AX直击快通路）
        } else {
          const reply = await this.chat(cmd); // 其他→GLM 工具链
          result = reply;
        }
        if (result && this._voiceActive) {
          this.bubble.showText(String(result).slice(0, 120), Math.max(4000, String(result).length * 120));
          if (this.doubao?.active) {
            this.doubao.say?.(String(result).slice(0, 200)); // 结果豆包代播
            this._emitVoiceState('speaking');
            await new Promise(r => setTimeout(r, Math.min(15000, 1500 + String(result).length * 180)));
          } else {
            await this._speakReply(String(result));
          }
        }
      } catch (e) {
        console.warn('[PetController] DO执行失败:', e?.message);
        this.bubble.showHint?.('那个没处理好，再说一次？', 2500);
      } finally {
        this._toolRouting = false;
        this.doubao?.resumeAudio?.();
        if (this._voiceActive && this.doubao?.active) this._emitVoiceState('listening');
      }
    })();
  }

  /** 屏幕相关请求判定（触发实时截屏分析） */
  _isScreenRequest(text) {
    return /(屏幕|画面|截屏|截图|窗口|弹窗|按钮|那个东西|这个位置|坐标|点一下|点击|关掉它|右上|左下|帮我处理)/.test(text);
  }

  /**
   * 实时屏幕分析：截屏 → vision 识别（内容+目标元素坐标）
   * 返回注入对话的上下文（含屏幕尺寸与目标坐标，供 AppleScript 工具执行点击）
   */
  async _analyzeScreenFor(query) {
    try {
      if (!this._canCaptureScreen()) return '';
      this.bubble.showHint?.('📸 正在看你的屏幕…', 2000);
      const b64 = await window.screenAPI.getScreenshot();
      if (!b64) return '';
      const analysis = await this.llm.vision(b64,
        `主人说："${query}"。请分析这张屏幕截图：1)屏幕上有什么（应用/窗口/主要内容，30字内）2)与主人请求相关的目标元素在图中的位置（归一化坐标0-1000，左上原点）3)操作类请求给出建议动作。严格JSON：{"scene":"描述","target":{"name":"元素名","x":123,"y":456,"action":"click|close|none"}}`, 'image/png');
      const m = String(analysis || '').match(/\{[\s\S]*\}/);
      if (!m) return `【屏幕实况】刚截了你的屏幕，画面内容：${String(analysis).slice(0, 80)}`;
      const j = JSON.parse(m[0]);
      const w = screen.width, h = screen.height;
      const px = j.target ? Math.round((j.target.x / 1000) * w) : 0;
      const py = j.target ? Math.round((j.target.y / 1000) * h) : 0;
      this._screenTarget = j.target ? { ...j.target, px, py, screenW: w, screenH: h } : null;
      let ctx = `【屏幕实况】你能实时看到主人屏幕（刚截图分析过）。画面：${j.scene}`;
      if (this._screenTarget) {
        ctx += `。与请求相关的目标：${j.target.name}，屏幕绝对坐标约 (${px}, ${py})（屏幕 ${w}x${h}）`;
        if (j.target.action === 'click') ctx += '。可用 run_applescript 工具在该坐标执行点击。';
      }
      ctx += ' 回答时自然描述你看到的内容，证明你能看到屏幕。';
      return ctx;
    } catch (e) {
      console.warn('[PetController] 屏幕分析失败:', e?.message);
      return '';
    }
  }


  /** LLM 意图判断：是否需要调用工具（理解口语化表达，10s超时默认false） */
  async _llmNeedTool(text) {
    try {
      const r = await Promise.race([
        this.llm.chat([
          { role: 'system', content: '判断这句话是否是让助手在本机执行操作的指令（需调用工具）。判定规则（重要）：出现"点击/点一下/单击/按下/关掉/勾选/双击/右键"等操作动词（无论后面跟什么名词，如"下一步""确认""登录""它"）→必须yes；①"打开/启动/开一下/我要用 + 应用"→yes ②"提醒/闹钟/叫我/X分钟后"→yes ③"看看/列出/整理 + 桌面/文件夹/文件"→yes ④"截屏/截图"→yes ⑤涉及屏幕内容："屏幕上/画面上/那个窗口/弹窗/按钮/关掉/点一下/右上角/左下角/帮我处理"→yes ⑤b "输入/打字/填上/写上 + 内容"→yes ⑤c "发微信/给XX发消息/发条消息/发给他/发给她"→yes ⑤b "输入/打字/填上/写上 + 内容"→yes（键盘输入工具） ⑥问"能看到我屏幕吗"→yes ⑦纯聊天/讲笑话/问天气→no。只回答yes或no。' },
          { role: 'user', content: text },
        ]),
        new Promise(res => setTimeout(() => res('no'), 10000)),
      ]);
      let ans = String(r || '').toLowerCase().includes('yes');
      // 双保险：LLM 漏判时的强化正则（口语化变体兜底）
      if (!ans) {
        const RE = /(打开|启动|开一下|开个|我要用|我想用|帮我开).{0,12}(微信|safari|访达|finder|备忘录|音乐|日历|计算器|地图|邮件|照片|终端|浏览器|应用|app)|((看看|列出|整理|查查?|有什么).{0,8}(桌面|下载|文档|文件夹|目录|文件))|(提醒|闹钟|叫我|截屏|截图)/i;
        ans = RE.test(text);
      if (!ans) {
        const SCREEN_RE = /(屏幕|画面|截图|截屏|窗口|弹窗|按钮).{0,20}(哪个|哪里|什么|位置|看到|帮我|处理|关掉|点击|点一下)|帮我(关闭|点击|处理)|能看到.{0,8}(屏幕|我)/i;
        ans = SCREEN_RE.test(text);
      if (!ans) ans = /(发|发送|回).{0,6}(微信|消息)|(给|帮).{1,12}(发|送)(个|条|下)?.{0,4}(微信|消息|信息)/i.test(text);
      if (!ans) ans = /(按|敲|点).{0,15}(command|cmd|⌘|ctrl|control|快捷键|回车|esc|删除键|tab)|(复制|粘贴|全选|截图|撤销|保存)一下?$|(复制|粘贴|全选|撤销)/.test(text);
      if (!ans) ans = /^(点击|点一下|单击|双击|右键点击|按下|按一下|按|勾选|关掉|关闭|打开)(.{0,14})$/m.test(text.trim()); // 操作动词开头=指令
      }
      }
      console.log('[PetController] 工具意图判断:', ans ? 'TOOL' : 'chat', '←', text.slice(0, 20));
      return ans;
    } catch { return false; }
  }


  async _processVoiceText(text) {
    if (!text || !this._voiceActive) return;
    const t0 = Date.now();
    this.voice.stopListen?.();
    this._emitVoiceState('thinking');
    this.bubble.showHint?.(`你说：${text}`, 3000);

    // 先应答（操作类指令即时给"好嘞"——感知延迟降到零，GLM 后台干活）
    const ACTION_HINT = /^(打开|关闭|关掉|点击|点|启动|帮我|设置?个?|定个?|发|按|输入)/.test(text.trim());
    if (ACTION_HINT) {
      this.bubble.showHint?.('好嘞，马上！', 1200);
    }

    let reply = '';
    try {
      reply = await this.chat(text); // GLM 原生工具链（chat 内含工具铁律+两阶段强制）
    } catch (err) {
      console.error('[PetController] 语音 chat 失败:', err);
    }
    console.log(`[self-pipe] 全链路耗时 ${Date.now() - t0}ms`);
    if (!this._voiceActive) return; // 会话已被用户终止

    // 病理文本清洗：错误文案（含HTTP状态码等）不该原样念给主人听，也不该把半截 JSON 念出来
    const isErrText = /^(（.*(失败|错误|受限|不可用|稍后)|.*HTTP \d+.*）?$)/.test(String(reply || '').trim());
    const clean = String(reply || '')
      .replace(/\{[^{}]*"(index|finish_reason|choices|delta)"[^{}]*\}/g, '')  // 流中断残留的 SSE JSON 片段
      .replace(/data:.*$/gm, '')
      .trim();
    if (isErrText || !clean) {
      // 冷却 60s：服务过载/限流时连续失败不该连环播报"再说一次"（用户被念到烦）
      const now = Date.now();
      if (this._voiceActive && now - (this._lastErrHintAt || 0) > 60000) {
        this._lastErrHintAt = now;
        this.bubble.showHint?.('哎呀，我脑子刚才卡了一下，再说一次？', 2500);
        await this._speakReply('哎呀，我刚才没反应过来，主人再说一次好不好');
      } else if (this._voiceActive) {
        this.bubble.showHint?.('（网络开小差了，稍等下再试～）', 2000);
      }
      if (!this._voiceActive) return;
    } else {
      if (reply) await this._speakReply(clean);
    }
    if (!this._voiceActive) return;

    // 播报结束 → 继续听（循环对话）
    if (this.voice.getVoiceLoopActive?.()) {
      this._emitVoiceState('listening');
    } else {
      this._startVoiceListen();
    }
  }

  /**
   * TTS 播报 + 口型续命（Edge → 智谱 → 系统三级降级；打电话式可打断）
   * 播报期间 VAD 武装打断模式：用户插嘴 → 立即停所有 TTS → 插话录音断句转写（走 _processVoiceText）
   * @returns {Promise<'full'|'interrupted'|'none'>}
   */
  async _speakReply(reply) {
    this._speakingVoice = true;
    this._setFrozen(true); // 播报期间静止（气泡可读）
    this._emitVoiceState('speaking');
    let lipTimer = null;
    const startLip = () => {
      lipTimer = setInterval(() => this.live2d.lipSpeak?.(1400), 1200);
    };
    // 打断回调：用户插嘴瞬间 → 闭嘴（Edge afplay kill + 智谱/系统 TTS cancel）
    if (this.voice.getVoiceLoopActive?.()) {
      this.voice.armInterrupt?.(() => {
        this.voice.stopAllTTS();
        this.bubble.showHint?.('（好，你先说～）', 1800);
      });
    }
    let outcome = 'none';
    try {
      // 0) 豆包 TTS（火山语音合成大模型·灿灿甜美女声——与极速模式同源豆包嗓，体验统一）
      if (outcome === 'none' && typeof this.voice.speakDoubao === 'function') {
        try {
          const r = await this.voice.speakDoubao(reply, { onStart: startLip, emotion: this.state.emotion });
          if (r) outcome = 'full';
        } catch (e) { console.warn('[PetController] 豆包TTS失败，降级:', e?.message); }
      }
      // 1) Edge TTS（微软神经网络，甜美真人音色，免费）
      if (outcome === 'none' && typeof this.voice.speakEdge === 'function') {
        const r = await this.voice.speakEdge(reply, { onStart: startLip });
        if (r === 'full' || r === 'interrupted') outcome = r;
      }
      // 2) 智谱 GLM-TTS（配置了 key 时）
      if (outcome === 'none' && typeof this.voice.speakCloud === 'function') {
        const r = await this.voice.speakCloud(reply, { onStart: startLip });
        if (r) outcome = 'full';
      }
      // 3) 系统 speechSynthesis 兜底
      if (outcome === 'none') {
        const r = await this.voice.speak(reply, { onStart: startLip });
        if (r) outcome = 'full';
      }
      // 注：任何一级播报中被插嘴 → stopAllTTS 已停当前级 → 此处不降级（用户在说话），
      // outcome 保持该级返回值（Edge 级可识别 interrupted；其余级被停即返回 false→none，
      // 但不打紧——插话的转写会开启新一轮 _processVoiceText）
    } finally {
      this.voice.disarmInterrupt?.();
      if (lipTimer) clearInterval(lipTimer);
      this._speakingVoice = false;
      this._setFrozen(false); // 播报结束解冻
    }
    return outcome;
  }

  /** 语音出错：SR 致命错误自动降级 VAD；其他错误友好提示 + 结束会话 */
  async _onVoiceError(msg) {
    // SpeechRecognition 报 network/service-not-allowed（Electron 缺 Google key）
    // → getASRMode() 已自动切 recorder → 这里无缝转入 VAD 持续听，不打断用户
    if (this._voiceActive && this.voice?.getASRMode?.() === 'recorder'
        && typeof this.voice.startVoiceLoop === 'function') {
      this.bubble.showHint?.('实时识别不可用，已切换到录音转写模式，请继续说～', 3500);
      const ok = await this.voice.startVoiceLoop({
        onPartial: () => {},
        onFinal: (text) => this._processVoiceText(text),
        onError: (m) => this._onVoiceError(m),
        onState: (s) => this._emitVoiceState(s === 'transcribing' ? 'thinking' : 'listening'),
      });
      if (ok) return;
      // VAD 也失败（无麦/权限）→ 走下面的常规报错
    }
    this._voiceActive = false;
    this.voice?.stopListen?.();
    this._stopVoiceLoop?.();
    this._emitVoiceState('idle');
    this.bubble.showHint?.(`语音不可用：${msg || '未知错误'}。双击我用文字聊天吧～`, 4500);
  }

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

  async _buildMessages(queryText) {
    const sysLines = [this.personality.getSystemPrompt()];

    // 知识库检索：与当前话题最相关的"对主人的了解"注入（越聊越懂主人）
    if (this.knowledge) {
      try {
        const kbBlock = await this.knowledge.buildPromptBlock(queryText || '');
        if (kbBlock) sysLines.push('', kbBlock);
      } catch (e) { /* 知识库故障不阻塞对话 */ }
    }

    // 屏幕感知注入：主人当前在干什么（问"你能看到我屏幕吗"时有真话可说）
    const snap = this.perception?.getLatestSnapshot?.();
    if (snap && !snap.stale) {
      const label = { work: '工作', fun: '娱乐', slack: '摸鱼', rest: '休息', late_night: '深夜用电脑' }[snap.scene] || snap.scene;
      sysLines.push('', `【屏幕感知】你能实时看到主人的屏幕（周期截屏分析）。当前画面：主人正在${label}——${snap.detail}。主人问到屏幕相关话题时，基于此回答，不要说"看不到"。`);
    }

    const ctx = await this.memory.getContext(20);
    // 记忆块：长期+情感（短期走对话流，避免重复）
    const memoryItems = ctx.filter((it) => it.type !== 'short');
    if (memoryItems.length) {
      sysLines.push('', '【记忆】');
      const label = { long: '长期', emotional: '情感' };
      for (const it of memoryItems) {
        const content = it.content.length > 80 ? it.content.slice(0, 80) + '…' : it.content;
        sysLines.push(`- (${label[it.type] || it.type}) ${content}`);
      }
    }
    const messages = [{ role: 'system', content: sysLines.join('\n') }];

    // 最近对话：短期记忆还原多轮（最新在前 → 反转为时间正序）
    const shorts = ctx.filter((it) => it.type === 'short').slice(0, 10);
    const dialogue = shorts
      .slice()
      .reverse()
      .map((it) => {
        if (it.content.startsWith('主人说：')) return { role: 'user', content: it.content.slice(4) };
        if (it.content.startsWith('我回复：')) return { role: 'assistant', content: it.content.slice(4) };
        return { role: 'user', content: it.content };
      })
      .slice(-8); // 最多8条近对话
    messages.push(...dialogue);
    return messages;
  }

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
