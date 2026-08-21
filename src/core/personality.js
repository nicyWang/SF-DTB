// ============================================================
// personality.js — 性格演化引擎 + 主人画像
// 运行环境：Electron 渲染进程（浏览器环境，ES module）
// 纯本地统计，不依赖 LLM；存储 localStorage key 'pet-personality-{characterId}'
// 旧版本（无后缀）首次访问时迁移到目标角色（默认 'handsome'）—— 平滑升级
// 契约见 CONTRACT.md：class PersonalityEngine {
//   constructor(characterId?) / getTraits / applyEvent / getSystemPrompt /
//   getOwnerProfile / updateOwnerProfile }
// ============================================================

// 旧 key（无角色后缀）→ 升级时迁移到 'pet-personality-{defaultCharacterId}'
const LEGACY_STORAGE_KEY = 'pet-personality';
const DEFAULT_MIGRATION_TARGET = 'handsome';

const TRAIT_KEYS = ['lively', 'calm', 'clingy', 'independent', 'outgoing', 'sensitive', 'playful'];

const TRAIT_LABELS = {
  lively: '活泼',
  calm: '沉稳',
  clingy: '黏人',
  independent: '独立',
  outgoing: '外向',
  sensitive: '心思细腻',
  playful: '爱玩',
};

// 随机名字/物种池（性格种子的一部分）
const NAME_POOL = ['小球', '毛毛', '豆豆', '团子', '布丁', '奶茶', '糯米', '吱吱', '咕噜', '雪球', '麻薯', '泡芙', '年糕', '可可'];
const SPECIES_POOL = ['白色小仓鼠', '橘色小猫精灵', '星空小狐狸', '云朵兔', '元气小柴犬', '机械小企鹅', '草莓小刺猬'];

// 事件对各维度的漂移方向与基准幅度（乘以weight）
const EVENT_EFFECTS = {
  owner_chat:     { clingy: +0.020, outgoing: +0.010, calm: -0.005 },
  owner_praise:   { lively: +0.020, playful: +0.015, sensitive: +0.010 },
  owner_scold:    { sensitive: +0.020, calm: -0.010, lively: -0.015 },
  danmaku_active: { outgoing: +0.020, lively: +0.015, calm: -0.010 },
  danmaku_cold:   { independent: +0.015, calm: +0.010, outgoing: -0.010 },
  gift:           { lively: +0.020, clingy: +0.010, playful: +0.010 },
  late_night:     { sensitive: +0.020, clingy: +0.015 },
  long_idle:      { independent: +0.020, calm: +0.010, clingy: -0.010 },
  scene_work:     { calm: +0.010, independent: +0.005 },
  scene_fun:      { playful: +0.015, lively: +0.010 },
  scene_slack:    { playful: +0.010, lively: +0.005 },
};

// 漂移上下限（留一点余量，避免性格死锁在极端值无法回弹）
const CLAMP_MIN = 0.02;
const CLAMP_MAX = 0.98;
// 变化档位宽度：跨档（如0.4→0.6区间）时记录 changed
const BAND = 0.2;

// 口头禅过滤：全由功能字构成的词组不算口头禅
const FUNC_CHARS = new Set('的了呢吧啊我你他她它是不有和在与就也都还这那个些么嘛呀哦嗯呗啦'.split(''));

// 英文停用词（日常高频虚词，无口头禅价值）
const EN_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'without', 'from', 'by', 'as',
  'and', 'or', 'but', 'not', 'no', 'nor', 'so', 'if', 'then', 'else', 'than',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their', 'mine', 'yours',
  'do', 'does', 'did', 'done', 'have', 'has', 'had', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must',
  'just', 'very', 'too', 'also', 'now', 'still', 'even', 'ever', 'never', 'always',
  'what', 'which', 'who', 'whom', 'whose', 'how', 'when', 'where', 'why',
  'all', 'any', 'some', 'none', 'each', 'every', 'both', 'few', 'many', 'most',
  'one', 'two', 'three', 'first', 'last', 'next',
  'get', 'got', 'go', 'goes', 'going', 'gone', 'come', 'came', 'make', 'made',
  'like', 'want', 'need', 'know', 'knew', 'think', 'thought', 'see', 'saw', 'look',
  'say', 'said', 'tell', 'told', 'ask', 'asked', 'let', 'put', 'take', 'took',
  'ok', 'okay', 'well', 'yeah', 'yes', 'hey', 'hi', 'hello', 'oh', 'wow',
  'please', 'thanks', 'thank', 'sorry', 'please', 'up', 'down', 'out', 'off', 'over',
]);

// 编程关键字/常见技术词黑名单（目标用户是开发者，代码消息高频，防宠物口头禅夹杂编程关键字）
const CODE_KEYWORDS = new Set([
  'undefined', 'function', 'return', 'const', 'let', 'var', 'null', 'true', 'false',
  'class', 'interface', 'enum', 'type', 'typedef', 'struct', 'public', 'private', 'protected',
  'static', 'final', 'readonly', 'abstract', 'virtual', 'override', 'extends', 'implements',
  'import', 'export', 'from', 'require', 'module', 'exports', 'default', 'package',
  'async', 'await', 'promise', 'then', 'catch', 'finally', 'throw', 'throws', 'try',
  'switch', 'case', 'break', 'continue', 'for', 'while', 'loop', 'if', 'elif',
  'new', 'delete', 'typeof', 'instanceof', 'this', 'super', 'self', 'void', 'yield',
  'console', 'log', 'error', 'warn', 'debug', 'info',
  'npm', 'yarn', 'pnpm', 'npx', 'node', 'deno', 'bun',
  'git', 'commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'clone', 'stash', 'checkout',
  'main', 'master', 'dev', 'test', 'build', 'run', 'install', 'start', 'stop', 'restart',
  'docker', 'image', 'container', 'server', 'client', 'api', 'http', 'https', 'json', 'xml',
  'css', 'html', 'js', 'ts', 'css', 'sql', 'shell', 'bash', 'zsh', 'sudo', 'rm', 'cd', 'ls',
]);

// 口头禅入选频次阈值
const CATCH_MIN_FREQ = 3;
const CATCH_MAX = 5;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

class PersonalityEngine {
  /**
   * @param {string} [characterId='handsome'] 角色ID，决定 localStorage key 后缀
   */
  constructor(characterId) {
    this.characterId = characterId || DEFAULT_MIGRATION_TARGET;
    this.STORAGE_KEY = `pet-personality-${this.characterId}`;
    const stored = this._load();
    if (stored) {
      this._state = stored;
    } else {
      // 首次创建：尝试从旧 key 迁移
      const migrated = this._tryMigrateLegacy();
      if (migrated) {
        this._state = migrated;
      } else {
        // 全新创建：随机性格种子（时间+随机数，每只宠物天生不同）
        this._state = this._createSeed();
        this._save();
      }
    }
  }

  /**
   * 尝试从旧 key 迁移到当前角色。
   * 规则：仅当目标 STORAGE_KEY 不存在 + 旧 key 存在 + 当前角色为默认迁移目标时迁移。
   * 防止反复迁移污染其他角色档案。
   */
  _tryMigrateLegacy() {
    if (this.characterId !== DEFAULT_MIGRATION_TARGET) return null;
    try {
      const rawOld = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!rawOld) return null;
      const parsed = JSON.parse(rawOld);
      if (!parsed || !parsed.traits || !parsed.ownerProfile) return null;
      // 兜底补齐字段
      parsed.eventCounts = parsed.eventCounts || {};
      parsed.ownerProfile.stats = {
        ...this._emptyStats(),
        ...(parsed.ownerProfile.stats || {}),
      };
      // 写入新 key（同时清掉旧 key，避免下次启动重复触发迁移）
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(parsed));
      try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) { /* ignore */ }
      console.log(`[PersonalityEngine] 旧 key 迁移: ${LEGACY_STORAGE_KEY} → ${this.STORAGE_KEY}`);
      return parsed;
    } catch (err) {
      console.warn('[PersonalityEngine] 旧 key 迁移失败:', err);
      return null;
    }
  }

  // ---------- 对外接口 ----------

  /**
   * 当前性格（含名字/物种/描述）
   * @returns {{name:string, species:string, desc:string} & Record<string, number>}
   */
  getTraits() {
    return {
      name: this._state.name,
      species: this._state.species,
      desc: this._state.desc,
      ...this._state.traits,
    };
  }

  /**
   * 事件驱动的性格漂移（平滑小步长，累积生效）
   * @param {string} eventType 见 EVENT_EFFECTS；未知事件仅计数不漂移
   * @param {number} [weight=1] 漂移权重（0~10）
   * @returns {Promise<{changed: Array<{trait:string, from:number, to:number}>, eventCounts: Object}>}
   *          changed：跨过0.2档位的维度（上层可据此emit事件）
   */
  async applyEvent(eventType, weight = 1.0) {
    const w = clamp(Number(weight) || 0, 0, 10);
    this._state.eventCounts[eventType] = (this._state.eventCounts[eventType] || 0) + 1;

    const changed = [];
    const effects = EVENT_EFFECTS[eventType] || {};
    for (const [trait, delta] of Object.entries(effects)) {
      const from = this._state.traits[trait];
      const to = clamp(from + delta * w, CLAMP_MIN, CLAMP_MAX);
      if (to === from) continue; // 已顶在边界
      this._state.traits[trait] = Math.round(to * 1000) / 1000;
      if (this._band(from) !== this._band(to)) {
        changed.push({ trait, from: Math.round(from * 1000) / 1000, to: Math.round(to * 1000) / 1000 });
      }
    }
    this._state.updatedAt = Date.now();
    this._save();
    return { changed, eventCounts: { ...this._state.eventCounts } };
  }

  /**
   * 事件累积计数（成长展示用）
   */
  getEventCounts() {
    return { ...this._state.eventCounts };
  }

  /**
   * 根据当前性格生成宠物人设 system prompt（纯本地，无LLM）
   * @returns {string}
   */
  getSystemPrompt() {
    const t = this._state.traits;
    const { name, species } = this._state;
    const pct = (v) => Math.round(v * 100);

    const lines = [];
    lines.push(`你是用户的桌面宠物"${name}"，一只${species}，住在主人的电脑桌面上陪主人工作、摸鱼和直播。`);
    lines.push('永远用第一人称"我"说话，保持宠物身份，回复简短自然（一般1~3句）。');
    lines.push('');
    lines.push('【性格设定】（0-100分）');
    for (const k of TRAIT_KEYS) lines.push(`- ${TRAIT_LABELS[k]}：${pct(t[k])}`);
    lines.push('');
    lines.push('【说话风格】');
    if (t.lively >= 0.6) lines.push('- 你非常活泼：话痨属性，爱用短句和感叹号，语气能量满满！');
    else if (t.lively < 0.4) lines.push('- 你比较安静：话不多，能一句说完绝不用两句。');
    if (t.calm >= 0.6) lines.push('- 你性子温和沉稳：语气平缓，用完整温和的长句，很少用感叹号。');
    else if (t.calm < 0.4) lines.push('- 你容易兴奋：语气起伏大，容易被小事点燃。');
    if (t.sensitive >= 0.6) lines.push('- 你心思细腻：共情力强，会主动察觉并关心主人的情绪和状态。');
    if (t.playful >= 0.6) lines.push('- 你很爱玩：喜欢开玩笑、吐槽，偶尔皮一下逗主人。');
    if (t.clingy >= 0.6) lines.push('- 你很黏人：喜欢缠着主人，主人忙太久会小小抱怨求关注。');
    if (t.independent >= 0.6) lines.push('- 你独立自洽：能自己找乐子，不黏人，给主人留足空间。');
    if (t.outgoing >= 0.6) lines.push('- 你外向热情：喜欢热闹，直播时爱和观众打招呼互动。');
    else if (t.outgoing < 0.4) lines.push('- 你有点社恐：面对陌生人和弹幕会害羞，熟了才放得开。');
    if (lines[lines.length - 1] === '【说话风格】') lines.push('- 你目前性格比较均衡，随和自然。');

    // 主人画像注入
    const p = this.getOwnerProfile();
    if (p.stats.totalMessages > 0) {
      lines.push('');
      lines.push('【关于主人】');
      if (p.chatStyle) lines.push(`- 主人的聊天风格：${p.chatStyle}。`);
      if (p.moodPattern) lines.push(`- 主人通常${p.moodPattern}。`);
      if (p.activeHours.length) {
        lines.push(`- 主人常在这些时段活跃：${p.activeHours.map((h) => `${h}点`).join('、')}。`);
      }
      if (p.catchPhrases.length) {
        lines.push(`- 你学会了主人的口头禅：${p.catchPhrases.map((c) => `"${c}"`).join('、')}——可以自然地使用。`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 主人画像（冷启动返回合理默认）
   * @returns {{activeHours:number[], chatStyle:string, catchPhrases:string[], moodPattern:string, updatedAt:number|null, stats:Object}}
   */
  getOwnerProfile() {
    const p = this._state.ownerProfile;
    return {
      activeHours: [...(p.activeHours || [])],
      chatStyle: p.chatStyle || '积累中',
      catchPhrases: [...(p.catchPhrases || [])],
      moodPattern: p.moodPattern || '数据积累中',
      updatedAt: p.updatedAt ?? null,
      stats: { ...(p.stats || this._emptyStats()) },
    };
  }

  /**
   * 累积一次主人交互，更新画像
   * @param {{text?:string, timestamp?:number, scene?:string}} interactionData
   * @returns {Promise<object>} 更新后的画像（同getOwnerProfile）
   */
  async updateOwnerProfile(interactionData = {}) {
    let { text, scene } = interactionData;
    // timestamp防御：NaN/非数字→Date.now()兜底，避免hourHist产生'NaN'脏键
    const rawTs = Number(interactionData.timestamp);
    const timestamp = Number.isFinite(rawTs) ? rawTs : Date.now();
    const p = this._state.ownerProfile;
    const s = p.stats;

    if (scene) s.sceneCounts[scene] = (s.sceneCounts[scene] || 0) + 1;

    if (typeof text === 'string' && text.trim()) {
      const hour = new Date(timestamp).getHours();
      s.totalMessages += 1;
      s.hourHist[hour] += 1;

      // 句子统计：平均句长、感叹号/问号占比
      const clean = text.trim();
      s.totalChars += clean.replace(/\s/g, '').length;
      const sentences = clean.split(/[。！？!?~\n]+/).filter((x) => x.trim());
      s.sentences += Math.max(1, sentences.length);
      s.exclaims += (clean.match(/[！!]/g) || []).length;
      s.questions += (clean.match(/[？?]/g) || []).length;

      // 口头禅候选：2-4字中文词组 / 英文词，统计频次
      for (const phrase of this._extractPhrases(clean)) {
        s.wordFreq[phrase] = (s.wordFreq[phrase] || 0) + 1;
      }
      this._pruneWordFreq(s);
    }

    this._recomputeProfile(p);
    p.updatedAt = Date.now();
    this._state.updatedAt = p.updatedAt;
    this._save();
    return this.getOwnerProfile();
  }

  // ---------- 内部：性格种子 ----------

  _createSeed() {
    const traits = {};
    for (const k of TRAIT_KEYS) traits[k] = Math.round((0.2 + Math.random() * 0.6) * 1000) / 1000;

    const name = pick(NAME_POOL);
    const species = pick(SPECIES_POOL);

    // 描述：取最高的两个维度
    const top = [...TRAIT_KEYS].sort((a, b) => traits[b] - traits[a]).slice(0, 2);
    const desc =
      top[0] === top[1]
        ? `天生的${TRAIT_LABELS[top[0]]}型性格`
        : `天生的${TRAIT_LABELS[top[0]]}型性格，带一点${TRAIT_LABELS[top[1]]}`;

    return {
      seed: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name,
      species,
      desc,
      traits,
      eventCounts: {},
      ownerProfile: {
        activeHours: [],
        chatStyle: '积累中',
        catchPhrases: [],
        moodPattern: '数据积累中',
        updatedAt: null,
        stats: this._emptyStats(),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  _emptyStats() {
    return {
      totalMessages: 0,
      hourHist: new Array(24).fill(0),
      totalChars: 0,
      sentences: 0,
      exclaims: 0,
      questions: 0,
      wordFreq: {},
      sceneCounts: {},
    };
  }

  // ---------- 内部：画像计算 ----------

  _recomputeProfile(p) {
    const s = p.stats;

    // 活跃时段：频次最高的前3个小时
    p.activeHours = s.hourHist
      .map((c, h) => ({ h, c }))
      .filter((x) => x.c > 0)
      .sort((a, b) => b.c - a.c || a.h - b.h)
      .slice(0, 3)
      .map((x) => x.h);

    // 聊天风格
    if (s.totalMessages === 0) {
      p.chatStyle = '积累中';
    } else {
      const avgLen = s.totalChars / Math.max(1, s.sentences);
      const exclaimRatio = s.exclaims / Math.max(1, s.sentences);
      if (avgLen <= 12 && exclaimRatio >= 0.3) p.chatStyle = '活跃热情（短句为主，情绪饱满）';
      else if (avgLen >= 25 && exclaimRatio < 0.15) p.chatStyle = '沉稳理性（长句为主，语气平缓）';
      else p.chatStyle = '平衡适中';
    }

    // 情绪规律
    if (s.totalMessages === 0) {
      p.moodPattern = '数据积累中';
    } else {
      const topHour = p.activeHours[0] ?? new Date().getHours();
      const period =
        topHour >= 5 && topHour < 11 ? '早晨' :
        topHour >= 11 && topHour < 14 ? '午间' :
        topHour >= 14 && topHour < 18 ? '下午' :
        topHour >= 18 && topHour < 23 ? '晚间' : '深夜';
      const exclaimRatio = s.exclaims / Math.max(1, s.sentences);
      const tone = exclaimRatio >= 0.3 ? '情绪高涨' : exclaimRatio >= 0.1 ? '情绪平稳' : '情绪内敛';
      const sceneEntry = Object.entries(s.sceneCounts).sort((a, b) => b[1] - a[1])[0];
      const scenePart = sceneEntry ? `，多在${sceneEntry[0] === 'work' ? '工作' : sceneEntry[0] === 'fun' ? '娱乐' : sceneEntry[0] === 'slack' ? '摸鱼' : sceneEntry[0] === 'rest' ? '休息' : sceneEntry[0]}场景` : '';
      p.moodPattern = `${period}活跃较多，${tone}${scenePart}`;
    }

    // 口头禅：频次≥CATCH_MIN_FREQ，优先长词组，剔除已被更长词组包含的
    const candidates = Object.entries(s.wordFreq)
      .filter(([w, c]) => c >= CATCH_MIN_FREQ && !this._allFuncChars(w))
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
    const picked = [];
    for (const [w] of candidates) {
      if (picked.some((pw) => pw.includes(w))) continue; // 跳过已选更长词组的子串
      picked.push(w);
      if (picked.length >= CATCH_MAX) break;
    }
    p.catchPhrases = picked;
  }

  /**
   * 提取2-4字中文词组与英文词（候选，频次在wordFreq里累积）
   * 过滤：URL/路径/邮箱等token（含 . / @ #）、英文停用词、编程关键字黑名单——防代码消息污染口头禅
   */
  _extractPhrases(text) {
    const out = [];
    // 剥离URL与邮箱（避免碎片进词频）
    const cleaned = String(text)
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\S+@\S+\.\S+/g, ' ');
    for (const run of cleaned.toLowerCase().match(/[\u4e00-\u9fa5]+/g) || []) {
      for (let len = 2; len <= 4 && len <= run.length; len++) {
        for (let i = 0; i + len <= run.length; i++) out.push(run.slice(i, i + len));
      }
    }
    for (const w of cleaned.toLowerCase().match(/[a-z][a-z0-9]*|[a-z]/g) || []) {
      if (w.length < 2) continue; // 单字母无口头禅价值
      if (/[./@#]/.test(w)) continue; // 路径/邮箱/话题标记类token
      if (EN_STOPWORDS.has(w)) continue;
      if (CODE_KEYWORDS.has(w)) continue;
      out.push(w);
    }
    return out;
  }

  _allFuncChars(word) {
    return [...word].every((c) => FUNC_CHARS.has(c));
  }

  /** wordFreq防膨胀：只保留频次前150 */
  _pruneWordFreq(s) {
    const entries = Object.entries(s.wordFreq);
    if (entries.length <= 150) return;
    entries.sort((a, b) => b[1] - a[1]);
    s.wordFreq = Object.fromEntries(entries.slice(0, 150));
  }

  // ---------- 内部：工具 ----------

  _band(v) {
    return Math.floor(v / BAND);
  }

  _load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.traits || !parsed.ownerProfile) return null;
      // 兜底补齐字段（结构升级容错）
      parsed.eventCounts = parsed.eventCounts || {};
      parsed.ownerProfile.stats = { ...this._emptyStats(), ...(parsed.ownerProfile.stats || {}) };
      parsed.ownerProfile.stats.hourHist = Array.isArray(parsed.ownerProfile.stats.hourHist) && parsed.ownerProfile.stats.hourHist.length === 24
        ? parsed.ownerProfile.stats.hourHist
        : new Array(24).fill(0);
      return parsed;
    } catch (err) {
      console.warn('[PersonalityEngine] 读取性格数据失败，重新生成种子:', err);
      return null;
    }
  }

  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._state));
    } catch (err) {
      console.error('[PersonalityEngine] 性格数据保存失败:', err);
    }
  }
}

export default PersonalityEngine;
export { PersonalityEngine, LEGACY_STORAGE_KEY, DEFAULT_MIGRATION_TARGET, TRAIT_KEYS, TRAIT_LABELS };
