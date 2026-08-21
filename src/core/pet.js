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
  { type: 'function', function: { name: 'list_dir', description: '列出目录内容（默认桌面/用户目录）', parameters: { type: 'object', properties: { dir: { type: 'string', description: '目录绝对路径，如 /Users/mac/Desktop' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: '读取文本文件内容', parameters: { type: 'object', properties: { file: { type: 'string', description: '文件绝对路径' } }, required: ['file'] } } },
  { type: 'function', function: { name: 'write_file', description: '写文件（新建/覆盖）', parameters: { type: 'object', properties: { file: { type: 'string', description: '目标路径' }, content: { type: 'string', description: '写入内容' } }, required: ['file', 'content'] } } },
  { type: 'function', function: { name: 'move_file', description: '移动/重命名文件或目录（可用来整理桌面）', parameters: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } }, required: ['src', 'dst'] } } },
  { type: 'function', function: { name: 'open_app', description: '打开macOS应用，如 WeChat/Safari/Netease Music', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'open_url', description: '用默认浏览器打开网址', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'run_applescript', description: '执行AppleScript自动化macOS（控制窗口/通知/应用消息等）', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'shell', description: '执行白名单shell命令（ls/cat/mkdir/cp/mv/open/say等）', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'screenshot', description: '截取全屏保存到/tmp（需要屏幕录制权限）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'system_info', description: '获取系统信息（用户/内存/时间）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'open-app', description: '打开macOS应用（安全版：应用名仅限字母数字空格，如 Safari / WeChat / Netease Music）', parameters: { type: 'object', properties: { appName: { type: 'string', description: '应用名' } }, required: ['appName'] } } },
  { type: 'function', function: { name: 'list-dir', description: '列出目录内容（安全版：仅限 ~/Desktop ~/Documents ~/Downloads ~/WorkBuddy，最多50项）', parameters: { type: 'object', properties: { dirPath: { type: 'string', description: '如 ~/Desktop' } }, required: ['dirPath'] } } },
  { type: 'function', function: { name: 'set-reminder', description: '设置定时提醒：N分钟后提醒主人某事（到点会弹出通知）', parameters: { type: 'object', properties: { minutes: { type: 'number', description: '分钟数(1-720)' }, text: { type: 'string', description: '提醒内容' } }, required: ['minutes', 'text'] } } },
  { type: 'function', function: { name: 'cancel-reminder', description: '取消一个未触发的提醒', parameters: { type: 'object', properties: { id: { type: 'string', description: 'set-reminder返回的id' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'wechat-send', description: '通过微信给指定联系人发消息（自动开微信→搜索→输入→发送）。需微信已在Mac登录。调用前必须先向用户复述联系人与内容获得确认', parameters: { type: 'object', properties: { contact: { type: 'string', description: '联系人备注名/昵称' }, message: { type: 'string', description: '消息内容' } }, required: ['contact', 'message'] } } },
  { type: 'function', function: { name: 'mouse-move', description: '移动鼠标到屏幕坐标(不点击)', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'mouse-dblclick', description: '双击屏幕坐标', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'mouse-rightclick', description: '右键点击屏幕坐标', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } },
  { type: 'function', function: { name: 'mouse-drag', description: '拖拽：从一点按住拖到另一点', parameters: { type: 'object', properties: { fromX: { type: 'number' }, fromY: { type: 'number' }, toX: { type: 'number' }, toY: { type: 'number' }, duration: { type: 'number' } }, required: ['fromX', 'fromY', 'toX', 'toY'] } } },
  { type: 'function', function: { name: 'mouse-scroll', description: '滚动（deltaY负=上,正=下,像素）', parameters: { type: 'object', properties: { deltaY: { type: 'number' }, deltaX: { type: 'number' } }, required: ['deltaY'] } } },
  { type: 'function', function: { name: 'key-press', description: '按键(key:enter/esc/tab/space/方向键/F1-12/单字符; modifiers:["cmd","shift","ctrl","alt"])', parameters: { type: 'object', properties: { key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string' } } }, required: ['key'] } } },
  { type: 'function', function: { name: 'hotkey-text', description: '快捷键："cmd+c" "cmd+shift+3" "enter" "esc"', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
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
    this.avatar = deps.avatar || null; // 火山实时数字人（可选；语音对话出镜）
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
    this._events?.emit?.('emotion:change', { emotion: target });

    const motion = EMOTION_MOTIONS[target] || EMOTION_MOTIONS.normal;
    this.live2d.playMotion(motion.group, motion.index);

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
    this._setFrozen(true);
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
        if (this._isScreenAction?.(text) && window.screenAPI?.getScreenshot && !this._screenLooping) {
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
          reply = await this.llm.chatWithTools(messages, TOOL_SPECS,
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
                'mouse-move': '移鼠标', 'mouse-dblclick': '双击', 'mouse-rightclick': '右键',
                'mouse-drag': '拖拽', 'mouse-scroll': '滚动', 'key-press': '按键', 'hotkey-text': `按 ${args?.text || '快捷键'}`,
              };
              this.bubble.showHint(`🔧 ${labels[name] || name}中…`);
            });
          this.bubble.showText(reply, Math.max(4000, reply.length * 120));
        } else {
          reply = await this.llm.chatStream(messages, (chunk) => {
            this.bubble.streamAppend(chunk);
          });
          this.bubble.streamEnd();
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

      // 6. 回复完心情转好
      if (this.state.emotion === 'normal' || this.state.emotion === 'sad') {
        this.setEmotion('happy', 10000);
      }
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

    // ---- 优先级1：豆包端到端实时语音（几百ms延迟，服务端VAD打断）----
    if (this.doubao?.isConfigured?.()) {
      this._emitVoiceState('listening');
      this.bubble.showHint?.('实时语音连接中…');
      let interrupted = false; // 运行中断开（非启动失败）
      let failMsg = null;
      const ok = await this.doubao.start({
        onUserText: (text, interim) => {
          if (interim) this.bubble.showHint?.(`你说：${text}`);
          else if (text) this._maybeVoiceToolRoute(text); // 最终转写：工具意图分流
        },
        onReplyText: (delta) => this.bubble.streamAppend(delta),
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
        if (this._isScreenAction?.(text) && window.screenAPI?.getScreenshot) {
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
  _isScreenAction(text) {
    return /(点|点击|单击|双击|右键|关掉|关闭|按下|勾选|选择|拖|输入|填).{0,20}(它|那个|这个|按钮|弹窗|窗口|选项|框|图标|位置|搜索|输入)|帮我(点|关|拖|选|填|处理)|(点|关)一下(它|那个)|在.{0,12}(里|中|上面).{0,6}(输入|填|写)/.test(text);
  }

  async _screenActionLoop(task) {
    const MAX_STEPS = 4;
    this.bubble.showHint?.('🎯 开始操作…', 2000);
    for (let step = 1; step <= MAX_STEPS; step++) {
      try {
        // 1) 感知：截屏 + 定位目标 + 判断当前状态
        const b64 = window.screenAPI?.getScreenshot ? await window.screenAPI.getScreenshot() : null;
        if (!b64) return '截屏失败，没法操作屏幕';
        const img = 'data:image/png;base64,' + b64;
        const analysis = await this.llm.vision(img,
          `任务："${task}"。这是当前屏幕截图（第${step}轮）。严格JSON回答：
{"done": bool(任务是否已完成——对比任务目标判断),
 "target": {"name":"要操作元素名", "x":0-1000, "y":0-1000, "action":"click|dblclick|rclick|type|none"},
 "type_text": "action=type 时要输入的文字",
 "status": "20字内描述当前画面状态"}`,
          'image/png');
        const m = String(analysis || '').match(/\{[\s\S]*\}/);
        if (!m) return `第${step}轮看不懂屏幕，放弃了。任务：${task}`;
        const j = JSON.parse(m[0]);
        // 2) 完成 → 汇报成功
        if (j.done) {
          return step === 1 ? `搞定啦！${j.status}` : `搞定啦（${step}轮）！${j.status}`;
        }
        // 3) 无目标无动作 → 报告卡住
        if (!j.target || j.target.action === 'none') {
          if (step >= MAX_STEPS) return `试了${step}轮还是不知道怎么操作：${j.status}`;
          continue; // 再看一眼（屏幕可能在动）
        }
        // 4) 行动：坐标换算 + 执行
        const px = Math.round((j.target.x / 1000) * screen.width);
        const py = Math.round((j.target.y / 1000) * screen.height);
        const act = j.target.action;
        let actDesc = act === 'click' ? '点击' : act === 'dblclick' ? '双击' : act === 'rclick' ? '右键' : '输入';
        this.bubble.showHint?.(`🖱 ${actDesc} ${j.target.name} (${px},${py}) · 第${step}轮`, 2000);
        if (act === 'click') await window.windowAPI.invokeTool('click-at', { x: px, y: py });
        else if (act === 'dblclick') await window.windowAPI.invokeTool('mouse-dblclick', { x: px, y: py });
        else if (act === 'rclick') await window.windowAPI.invokeTool('mouse-rightclick', { x: px, y: py });
        else if (act === 'type') {
          await window.windowAPI.invokeTool('click-at', { x: px, y: py });
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
      if (!window.screenAPI?.getScreenshot) return '';
      this.bubble.showHint?.('📸 正在看你的屏幕…', 2000);
      const b64 = await window.screenAPI.getScreenshot();
      if (!b64) return '';
      const img = 'data:image/png;base64,' + b64;
      const analysis = await this.llm.vision(img,
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
          { role: 'system', content: '判断这句话是否是让助手在本机执行操作的指令（需调用工具）。判定规则：①"打开/启动/开一下/我要用 + 应用"→yes ②"提醒/闹钟/叫我/X分钟后"→yes ③"看看/列出/整理 + 桌面/文件夹/文件"→yes ④"截屏/截图"→yes ⑤涉及屏幕内容："屏幕上/画面上/那个窗口/弹窗/按钮/关掉/点一下/右上角/左下角/帮我处理"→yes ⑤b "输入/打字/填上/写上 + 内容"→yes ⑤c "发微信/给XX发消息/发条消息/发给他/发给她"→yes ⑤b "输入/打字/填上/写上 + 内容"→yes（键盘输入工具） ⑥问"能看到我屏幕吗"→yes ⑦纯聊天/讲笑话/问天气→no。只回答yes或no。' },
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
      }
      }
      console.log('[PetController] 工具意图判断:', ans ? 'TOOL' : 'chat', '←', text.slice(0, 20));
      return ans;
    } catch { return false; }
  }


  async _processVoiceText(text) {
    if (!text || !this._voiceActive) return;
    this.voice.stopListen?.();
    this._emitVoiceState('thinking');
    this.bubble.showHint?.(`你说：${text}`, 3000);

    let reply = '';
    try {
      reply = await this.chat(text); // 复用现有文字流程（LLM 流式 + 打字机气泡 + 记忆/性格回写）
    } catch (err) {
      console.error('[PetController] 语音 chat 失败:', err);
    }
    if (!this._voiceActive) return; // 会话已被用户终止

    if (reply) await this._speakReply(reply);
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
