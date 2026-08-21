/**
 * LiveMode — 直播模式（弹幕互动 + 冷场救场）
 *
 * 职责：
 *  - 开播：连接弹幕源 → 开播问候（手动开启；OBS 自动检测可注入 detector）
 *  - 弹幕互动：关键词规则 + LLM 生成回复，驱动宠物说话/情绪（经全局事件总线）
 *  - 礼物感谢：分级反应（大礼物更兴奋），同用户连续送礼合并感谢防刷屏
 *  - 进入/关注：概率欢迎，带冷却（人多不刷屏）
 *  - 冷场检测：N 秒无弹幕 → 主动抛话题救场（LLM 或话题池）
 *  - 下播：stop() 时下播问候
 *
 * 输出（经 bus，默认 window.PetEvents，对齐 CONTRACT.md）：
 *  'speak:request' {text, duration?}   宠物说话
 *  'emotion:change' {emotion}          情绪 happy/excited/shy/...
 *  'motion:play' {name}                动作请求（挥手/跳舞等，pet.js 集成层监听）
 *  'live:event' {kind, detail?}        调试/统计事件
 *
 * 不直接依赖 pet.js / memory.js（经事件总线解耦）；LLM 可选，
 * 缺省或调用失败时回退到内置规则话术。
 */

// ---------------------------------------------------------------------------
// 内置规则数据
// ---------------------------------------------------------------------------

/** 关键词规则表（按序匹配，命中即用） */
const KEYWORD_RULES = [
  {
    name: 'greet',
    pattern: /(你好|大家好|hello|hi|嗨|哈喽|晚上好|早上好|下午好|打卡|来了)/i,
    motions: ['wave'],
    emotion: 'happy',
    replies: ['你好呀~ 欢迎欢迎！', '来啦来啦，等你很久了！', '嗨~ 今天过得怎么样呀？'],
  },
  {
    name: 'praise',
    pattern: /(好听|厉害|666|好看|爱了|yyds|牛|棒|赞|可爱|喜欢)/i,
    motions: ['nod', 'dance'],
    emotion: 'shy',
    replies: ['哎呀，被夸得不好意思了~', '谢谢夸奖！你会继续陪着我的对吧？', '嘿嘿，那再来一个！'],
  },
  {
    name: 'song',
    pattern: /(点歌|唱一首|来首|唱个|想听)/i,
    motions: ['sing'],
    emotion: 'excited',
    replies: ['好呀好呀，清清嗓子~', '收到！这就为你献上一曲！', '点歌成功！这首送给你！'],
  },
  {
    name: 'urge',
    pattern: /(催更|多播|别下播|再来|加更|明天播)/i,
    motions: ['nod'],
    emotion: 'happy',
    replies: ['好啦好啦，我会多播一会儿的~', '你们的催更就是我的动力！', '记下了，明天还来看我好吗？'],
  },
  {
    name: 'follow-up', // 追问/互动类，直接走 LLM 或通用回复
    pattern: /(加群|粉丝团|关注|怎么加)/i,
    motions: ['wave'],
    emotion: 'happy',
    replies: ['点个关注就能找到我啦，感谢~', '欢迎加入粉丝团，抱一个！'],
  },
];

/** 问题类弹幕（交给 LLM） */
const QUESTION_PATTERN = /[?？]|(怎么|什么|为什么|哪|多少|是不是|有没有| can |how |what |why )/i;

/** 通用回复（未命中规则且无 LLM 时） */
const GENERIC_REPLIES = [
  '哈哈哈，说得对！',
  '有道理有道理~',
  '我看到你的弹幕啦！',
  '嘿嘿，继续陪我聊天嘛~',
  '这位小伙伴真有意思！',
];

/** 冷场话题池（无 LLM 时） */
const IDLE_TOPICS = [
  '咦，大家都去哪了呀？说句话嘛~',
  '那我先讲个冷笑话：为什么程序员不喜欢大自然？因为太多 bug 了！',
  '安静下来了…要不要听我哼首歌？',
  '刚才那条弹幕说得真好，你们觉得呢？',
  '偷偷告诉大家，我最喜欢的一句话是：慢慢来，比较快。',
  '有人想听我讲讲今天遇到了什么趣事吗？',
  '弹幕刷起来呀，我一个人有点无聊~',
  '听说深呼吸三次，烦恼会少一半。大家试试？',
];

/** 礼物分级 */
const GIFT_TIERS = [
  { names: ['火箭', '嘉年华'], tier: 'grand', emotion: 'excited', motion: 'dance' },
  { names: ['能量棒', '棒棒糖', '鲜花'], tier: 'mid', emotion: 'happy', motion: 'nod' },
  { names: ['小心心'], tier: 'small', emotion: 'happy', motion: 'wave' },
];

const GIFT_THANKS = {
  grand: ['哇！！{user}的{gift}！！太震撼了，感谢老板！！', '天呐，{user}送出{gift}！今天最大的排面！'],
  mid: ['谢谢 {user} 的{gift}，爱你！', '{user} 谢谢你的{gift}，超级感动~'],
  small: ['谢谢 {user} 的{gift}~', '收到 {user} 的{gift}啦，比心！'],
};

/** 开播/下播问候 */
const OPEN_GREETINGS = [
  '开播啦开播啦！大家快进来坐~',
  '欢迎来到直播间！我是你的桌面小伙伴~',
  '开播了！今天也请多多关照呀！',
];
const CLOSE_GREETINGS = [
  '今天的直播就到这里啦，大家晚安~',
  '下播啦，记得想我哦！明天见~',
  '感谢今天的陪伴，我们下次直播见！',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const fill = (tpl, map) => tpl.replace(/\{(\w+)\}/g, (_, k) => map[k] ?? `{${k}}`);

// ---------------------------------------------------------------------------
// LiveMode
// ---------------------------------------------------------------------------

export class LiveMode {
  /**
   * @param {object} opts
   *   danmaku: DanmakuService 实例（必需）
   *   llm: LLMService 实例（可选；提供则弹幕回复/冷场话题由 LLM 生成）
   *   bus: 事件总线（可选，默认 window.PetEvents；都没有则内部兜底空总线）
   *   detector: async ()=>boolean 进程检测器（可选，如 OBS 自动开播检测）
   */
  constructor(opts = {}) {
    if (!opts.danmaku) throw new Error('LiveMode: opts.danmaku (DanmakuService) is required');
    this.danmaku = opts.danmaku;
    this.llm = opts.llm || null;
    this.bus = opts.bus || (typeof window !== 'undefined' && window.PetEvents) || { emit() {} };
    this.detector = typeof opts.detector === 'function' ? opts.detector : null;

    this.running = false;
    this._handlers = [];       // danmaku 事件解绑队列
    this._timers = new Set();  // 所有定时器（stop 时清理）

    // 互动调参（可被 start(config) 覆盖）
    this.cfg = {
      idleTimeout: 60000,        // 冷场判定：N ms 无弹幕
      replyCooldown: 2000,       // 全局说话最小间隔
      replyQueueMax: 5,          // 待回复弹幕队列上限（超出丢最旧）
      enterWelcomeRate: 0.25,    // 进入欢迎概率
      enterCooldown: 8000,       // 进入欢迎冷却
      giftMergeWindow: 6000,     // 同用户礼物合并窗口
      detectorInterval: 10000,   // OBS 等开播进程检测轮询间隔
      useLLM: true,              // 允许在无 llm 时自动关闭
      personality: null,         // 性格描述（注入 LLM prompt，T9 集成）
      ...opts.config,
    };

    // 运行时状态
    this._lastDanmakuAt = 0;     // 最近一条弹幕时间
    this._lastSpeakAt = 0;       // 最近说话时间
    this._lastEnterWelcomeAt = 0;
    this._replyQueue = [];       // 待回复弹幕
    this._giftBuffer = new Map();// user -> {gift, count, timer} 合并感谢
    this._recent = [];           // 最近弹幕（LLM 上下文）
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  /**
   * 开播。
   * @param {object} [config] 覆盖调参 + 弹幕源配置 source
   *   {source?: {type:'mock'|'douyin', ...}, idleTimeout?, ...}
   */
  async start(config = {}) {
    if (this.running) return;
    this.cfg = { ...this.cfg, ...config };

    const source = config.source || { type: 'mock' };
    const ok = await this.danmaku.connect(source);
    if (!ok && !this.danmaku.connected) {
      this._emit('live:event', { kind: 'start-failed', detail: 'danmaku source unavailable' });
      return false;
    }

    this.running = true;
    this._bindDanmaku();

    // 开播问候
    this._speak(pick(OPEN_GREETINGS));
    this._setEmotion('excited');
    this._emit('live:event', { kind: 'live-start', detail: { source: this.danmaku.connectedType } });

    this._lastDanmakuAt = Date.now();
    this._watchIdle();
    this._watchDetector(); // detector 存在时轮询（下播自动停止）
    this._scheduleReplyLoop();
    return true;
  }

  /** 下播：问候 + 断开源 + 清理全部定时器 */
  async stop({ greet = true } = {}) {
    if (!this.running) return;
    this.running = false;
    if (greet) {
      this._speak(pick(CLOSE_GREETINGS));
      this._setEmotion('sleepy');
    }
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this._unbindDanmaku();
    await this.danmaku.disconnect();
    this._emit('live:event', { kind: 'live-stop' });
  }

  // ------------------------------------------------------------------
  // 弹幕事件处理
  // ------------------------------------------------------------------

  _bindDanmaku() {
    const d = this.danmaku;
    const add = (evt, fn) => { d.on(evt, fn); this._handlers.push([evt, fn]); };

    add('message', (p) => this._onMessage(p));
    add('gift', (p) => this._onGift(p));
    add('enter', (p) => this._onEnter(p));
    add('follow', (p) => this._onFollow(p));
  }

  _unbindDanmaku() {
    for (const [evt, fn] of this._handlers) this.danmaku.off(evt, fn);
    this._handlers = [];
  }

  /** 弹幕：记录 + 冷场计时重置 + 入回复队列 */
  _onMessage({ user, text }) {
    if (!this.running) return;
    this._lastDanmakuAt = Date.now();
    this._pushRecent({ user, text });

    // 入队（限长）
    this._replyQueue.push({ user, text, at: Date.now() });
    if (this._replyQueue.length > this.cfg.replyQueueMax) this._replyQueue.shift();
  }

  /** 礼物：分级感谢 + 合并窗口防刷屏 */
  _onGift({ user, gift, count }) {
    if (!this.running) return;
    this._lastDanmakuAt = Date.now();

    const tier = GIFT_TIERS.find((t) => t.names.includes(gift)) || { tier: 'mid', emotion: 'happy', motion: 'nod' };
    this._setEmotion(tier.emotion);
    this._playMotion(tier.motion);
    this._emit('live:event', { kind: 'gift', detail: { user, gift, count, tier: tier.tier } });

    const prev = this._giftBuffer.get(user);
    if (prev) {
      if (prev.gift === gift) {
        // 同礼物：窗口内累计，只感谢一次
        prev.count += count;
        return;
      }
      // 不同礼物：不合并。先清掉旧 timer 并立即 flush 旧礼物感谢，
      // 避免旧 timer 之后读到被覆盖的新数据（或读到 undefined 丢感谢）。
      clearTimeout(prev.timer);
      this._timers.delete(prev.timer);
      this._flushGift(user);
    }
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      this._flushGift(user);
    }, this.cfg.giftMergeWindow);
    this._timers.add(timer);
    this._giftBuffer.set(user, { user, gift, count, tier, timer });
  }

  /** 结算某用户的礼物合并缓冲并发感谢（幂等：无缓冲或已停止则跳过） */
  _flushGift(user) {
    const g = this._giftBuffer.get(user);
    this._giftBuffer.delete(user);
    if (!g || !this.running) return;
    const tpl = pick(GIFT_THANKS[g.tier.tier] || GIFT_THANKS.mid);
    this._speak(fill(tpl, { user: g.user, gift: g.gift + (g.count > 1 ? ` x${g.count}` : '') }));
  }

  /** 进入：概率欢迎 + 冷却 */
  _onEnter({ user }) {
    if (!this.running) return;
    this._lastDanmakuAt = Date.now();
    const now = Date.now();
    if (Math.random() > this.cfg.enterWelcomeRate) return;
    if (now - this._lastEnterWelcomeAt < this.cfg.enterCooldown) return;
    this._lastEnterWelcomeAt = now;
    this._speak(`欢迎 ${user} 进入直播间~`);
    this._playMotion('wave');
  }

  /** 关注：必感谢（低频事件） */
  _onFollow({ user }) {
    if (!this.running) return;
    this._lastDanmakuAt = Date.now();
    this._speak(`感谢 ${user} 的关注！以后就是一家人啦~`);
    this._setEmotion('happy');
    this._playMotion('wave');
  }

  // ------------------------------------------------------------------
  // 回复循环：周期消费弹幕队列 → 规则/LLM 回复
  // ------------------------------------------------------------------

  _scheduleReplyLoop() {
    const tick = async () => {
      if (!this.running) return;
      try {
        await this._drainReplyQueue();
      } catch (err) {
        console.error('[LiveMode] reply loop error:', err);
      }
      if (!this.running) return; // await 期间 stop() 则不再排下一轮
      const timer = setTimeout(tick, this.cfg.replyCooldown);
      this._timers.add(timer);
    };
    tick();
  }

  async _drainReplyQueue() {
    const now = Date.now();
    if (now - this._lastSpeakAt < this.cfg.replyCooldown) return;
    if (this._replyQueue.length === 0) return;
    const item = this._replyQueue.shift();

    // 1) 关键词规则优先（快、稳定、带动作）
    const rule = KEYWORD_RULES.find((r) => r.pattern.test(item.text));
    if (rule) {
      this._playMotion(pick(rule.motions));
      this._setEmotion(rule.emotion);
      this._speak(pick(rule.replies));
      this._emit('live:event', { kind: 'reply', detail: { by: 'rule', rule: rule.name, to: item.user } });
      return;
    }

    // 2) LLM 回复（问题类或普通闲聊）
    if (this.llm && this.cfg.useLLM) {
      const isQuestion = QUESTION_PATTERN.test(item.text);
      try {
        const reply = await this._llmReply(item, isQuestion);
        if (reply && this.running) {
          this._speak(reply);
          this._setEmotion(isQuestion ? 'happy' : 'happy');
          this._emit('live:event', { kind: 'reply', detail: { by: 'llm', to: item.user } });
          return;
        }
      } catch (err) {
        console.error('[LiveMode] llm reply failed, fallback to rules:', err);
      }
    }

    // 3) 兜底通用回复
    this._speak(pick(GENERIC_REPLIES));
    this._emit('live:event', { kind: 'reply', detail: { by: 'generic', to: item.user } });
  }

  /** 构造直播人设 prompt + 最近弹幕上下文，调 LLM */
  async _llmReply(item, isQuestion) {
    const persona = this.cfg.personality
      ? `你的性格：${typeof this.cfg.personality === 'string' ? this.cfg.personality : JSON.stringify(this.cfg.personality)}。`
      : '';
    const context = this._recent
      .slice(-8)
      .map((m) => `${m.user}: ${m.text}`)
      .join('\n');
    const messages = [
      {
        role: 'system',
        content: `你是一只住在主播桌面上的虚拟宠物搭档，正在直播间陪大家聊天。${persona}要求：回复口语化、简短（30字以内）、亲切活泼，像朋友聊天，不要用列表和markdown。观众问了问题就认真回答。`,
      },
      { role: 'user', content: `最近的直播间弹幕：\n${context}\n\n请回复这条弹幕：${item.user}: ${item.text}` },
    ];
    const out = await this.llm.chat(messages);
    return typeof out === 'string' ? out.trim().slice(0, 80) : null;
  }

  // ------------------------------------------------------------------
  // 冷场救场 & 开播检测
  // ------------------------------------------------------------------

  _watchIdle() {
    const check = () => {
      if (!this.running) return;
      const idle = Date.now() - this._lastDanmakuAt;
      if (idle >= this.cfg.idleTimeout) {
        this._rescueIdle();
        this._lastDanmakuAt = Date.now(); // 救场后重置计时
      }
      const timer = setTimeout(check, Math.min(this.cfg.idleTimeout / 2, 10000));
      this._timers.add(timer);
    };
    const timer = setTimeout(check, Math.min(this.cfg.idleTimeout / 2, 10000));
    this._timers.add(timer);
  }

  async _rescueIdle() {
    this._emit('live:event', { kind: 'idle-rescue', detail: { idleMs: this.cfg.idleTimeout } });
    // 优先 LLM 生成话题，失败/无 LLM 用话题池
    if (this.llm && this.cfg.useLLM) {
      try {
        const context = this._recent.slice(-5).map((m) => `${m.user}: ${m.text}`).join('\n') || '（直播间刚刚还很热闹）';
        const out = await this.llm.chat([
          {
            role: 'system',
            content: '你是直播间桌面宠物，弹幕冷场了，主动抛一个新话题带动气氛。只输出你要说的话，20字以内，口语化，可以带一个反问。',
          },
          { role: 'user', content: `刚才大家在聊：\n${context}\n\n现在冷场了，说点什么？` },
        ]);
        if (out && this.running) {
          this._speak(out.trim().slice(0, 60));
          this._setEmotion('bored');
          return;
        }
      } catch (err) {
        console.error('[LiveMode] idle llm failed, use topic pool:', err);
      }
    }
    this._speak(pick(IDLE_TOPICS));
    this._setEmotion('bored');
  }

  /** detector 提供时轮询检测（如 OBS 退出 → 自动下播）；首次检查 3s 后 */
  _watchDetector() {
    if (!this.detector) return;
    const interval = Math.max(500, this.cfg.detectorInterval || 10000);
    const check = async () => {
      if (!this.running) return;
      try {
        const alive = await this.detector();
        if (!alive) {
          this._emit('live:event', { kind: 'detector-down' });
          await this.stop(); // 检测到下播（OBS 关闭）→ 自动下播问候
          return;
        }
      } catch (err) {
        console.error('[LiveMode] detector error:', err);
      }
      if (!this.running) return; // await 期间 stop() 则不再排下一轮
      const timer = setTimeout(check, interval);
      this._timers.add(timer);
    };
    const timer = setTimeout(check, Math.min(interval, 3000));
    this._timers.add(timer);
  }

  // ------------------------------------------------------------------
  // 输出 & 工具
  // ------------------------------------------------------------------

  _speak(text) {
    this._lastSpeakAt = Date.now();
    this.bus.emit('speak:request', { text, duration: Math.max(2000, text.length * 180) });
  }

  _setEmotion(emotion) {
    this.bus.emit('emotion:change', { emotion });
  }

  _playMotion(name) {
    this.bus.emit('motion:play', { name });
  }

  _emit(name, payload) {
    this.bus.emit(name, payload);
  }

  _pushRecent(m) {
    this._recent.push(m);
    if (this._recent.length > 30) this._recent.shift();
  }

  /** 最近触发记录（调试/测试用） */
  getRecent() {
    return { recent: [...this._recent], queueLen: this._replyQueue.length };
  }
}

export default LiveMode;
