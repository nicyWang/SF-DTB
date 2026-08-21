// ============================================================
// memory.js — 记忆系统（短期/长期/情感三层）
// 运行环境：Electron 渲染进程（浏览器环境，ES module）
// 存储载体：localStorage（key 'pet-memory-{characterId}'）；集成阶段可替换为
// IPC 落盘 data/memory.json，对外接口保持不变。
// 旧版本（无后缀）首次访问时迁移到默认角色（'handsome'）—— 平滑升级
// 契约见 CONTRACT.md：class MemoryService { add / search / getContext / summarize }
// ============================================================

const LEGACY_STORAGE_KEY = 'pet-memory';
const DEFAULT_MIGRATION_TARGET = 'handsome';

// 分词缓存（WeakMap：不污染记忆条目本体，避免被序列化进localStorage）
const _tokenCache = new WeakMap();

const DEFAULTS = {
  shortLimit: 50,       // 短期记忆容量（FIFO 裁剪）
  emotionalLimit: 200,  // 情感记忆容量（超出按低分/低旧淘汰）
  longThreshold: 30,    // long 条数超过该值触发 summarize 压缩
  longBatch: 15,        // 每次压缩的最旧条数
};

/**
 * @typedef {Object} MemoryItem
 * @property {string|number} id
 * @property {string} content
 * @property {Object} meta {timestamp, source, score?, ...}
 */

class MemoryService {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.characterId='handsome'] 角色ID，决定 localStorage key 后缀
   * @param {import('./llm.js').default} [opts.llm] LLMService实例（summarize用；缺省走本地兜底压缩）
   * @param {number} [opts.shortLimit=50]
   * @param {number} [opts.emotionalLimit=200]
   * @param {number} [opts.longThreshold=30]
   */
  constructor(opts = {}) {
    this.llm = opts.llm || null;
    this.opts = {
      shortLimit: opts.shortLimit ?? DEFAULTS.shortLimit,
      emotionalLimit: opts.emotionalLimit ?? DEFAULTS.emotionalLimit,
      longThreshold: opts.longThreshold ?? DEFAULTS.longThreshold,
      longBatch: opts.longBatch ?? DEFAULTS.longBatch,
    };
    this.characterId = opts.characterId || DEFAULT_MIGRATION_TARGET;
    this.STORAGE_KEY = `pet-memory-${this.characterId}`;
    this._store = this._load() || this._tryMigrateLegacy() || { short: [], long: [], emotional: [] };
  }

  /**
   * 尝试从旧 key 迁移到当前角色。
   * 规则：仅当目标 STORAGE_KEY 不存在 + 旧 key 存在 + 当前角色为默认迁移目标时迁移。
   */
  _tryMigrateLegacy() {
    if (this.characterId !== DEFAULT_MIGRATION_TARGET) return null;
    try {
      const rawOld = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!rawOld) return null;
      const parsed = JSON.parse(rawOld);
      if (!parsed || !Array.isArray(parsed.short) || !Array.isArray(parsed.long) || !Array.isArray(parsed.emotional)) {
        return null;
      }
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(parsed));
      try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) { /* ignore */ }
      console.log(`[MemoryService] 旧 key 迁移: ${LEGACY_STORAGE_KEY} → ${this.STORAGE_KEY}`);
      return parsed;
    } catch (err) {
      console.warn('[MemoryService] 旧 key 迁移失败:', err);
      return null;
    }
  }

  // ---------- 对外接口 ----------

  /**
   * 写入一条记忆
   * @param {'short'|'long'|'emotional'} type
   * @param {string} content
   * @param {Object} [meta] {timestamp?, source?, score?, ...} score用于emotional高光排序（礼物价值/连续天数等里程碑）
   * @returns {Promise<MemoryItem>} 写入后的条目（含生成的id）
   */
  async add(type, content, meta = {}) {
    if (!['short', 'long', 'emotional'].includes(type)) {
      throw new Error(`add(type): 非法type "${type}"，应为 short|long|emotional`);
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('add(content): content必须是非空字符串');
    }
    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      content: content.trim(),
      meta: { timestamp: Date.now(), ...meta },
    };

    const pool = this._store[type];
    if (type === 'short') {
      // 最新在前，FIFO 裁掉最旧
      pool.unshift(item);
      if (pool.length > this.opts.shortLimit) pool.length = this.opts.shortLimit;
    } else if (type === 'emotional') {
      pool.unshift(item);
      // 超上限：优先淘汰低分，同分淘汰更旧
      if (pool.length > this.opts.emotionalLimit) {
        pool.sort((a, b) => this._emoRank(b) - this._emoRank(a));
        pool.length = this.opts.emotionalLimit;
      }
    } else {
      // long：最新在前，容量由 summarize() 压缩管理
      pool.unshift(item);
    }
    this._save();
    return { ...item, type };
  }

  /**
   * 相关性检索（关键词词项重叠 + 时间衰减）
   * @param {string} query 检索文本
   * @param {number} [limit=5]
   * @returns {Promise<Array<MemoryItem & {type:string, relevance:number}>>} 按相关性降序
   */
  async search(query, limit = 5) {
    const qTokens = this._tokenize(query || '');
    if (qTokens.size === 0) return [];
    // limit入口clamp：负数/NaN归零，避免slice(0,-1)之类的语义错误
    const n = Math.max(0, Math.floor(Number(limit) || 0));

    const results = [];
    for (const type of ['short', 'long', 'emotional']) {
      for (const item of this._store[type]) {
        const cTokens = this._tokenizedCache(item);
        let overlap = 0;
        for (const t of qTokens) if (cTokens.has(t)) overlap++;
        if (overlap === 0) continue;
        const overlapScore = overlap / qTokens.size; // 0~1
        const ageDays = (Date.now() - (item.meta?.timestamp || 0)) / 86400000;
        const decay = 1 / (1 + ageDays); // 时间衰减：当天1.0，一周≈0.59，一月≈0.32
        results.push({
          ...item,
          type,
          relevance: Math.round(overlapScore * decay * 1000) / 1000,
        });
      }
    }
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, n);
  }

  /**
   * 组装LLM上下文：近期short + 相关long + emotional高光（优先高分）
   * @param {number} [maxItems=10]
   * @returns {Promise<Array<MemoryItem & {type:string}>>}
   */
  async getContext(maxItems = 10) {
    // 入口clamp：0/负数/NaN返回空数组
    const n = Math.max(0, Math.floor(Number(maxItems) || 0));
    if (n === 0) return [];

    // 名额分配：emotional最多3条（score降序）→ rest内short约6成、long约4成
    // 空池/不足池的名额逐级回填（long空→给short；short空→给long；都空→给emotional），总数尽量达到maxItems
    const emoLen = this._store.emotional.length;
    const shortLen = this._store.short.length;
    const longLen = this._store.long.length;

    const eN = Math.min(3, n, emoLen);
    let rest = n - eN;
    let sN = Math.min(Math.max(0, Math.round(rest * 0.6)), shortLen);
    let lN = Math.min(Math.max(0, rest - sN), longLen);

    // 回填：把某池拿不完的名额依次让给还有余量的池
    let leftover = rest - sN - lN;
    if (leftover > 0) {
      const moreS = Math.min(leftover, shortLen - sN);
      sN += moreS;
      leftover -= moreS;
    }
    if (leftover > 0) {
      const moreL = Math.min(leftover, longLen - lN);
      lN += moreL;
      leftover -= moreL;
    }
    let eFinal = eN;
    if (leftover > 0) {
      const moreE = Math.min(leftover, emoLen - eN);
      eFinal += moreE;
    }

    const emotional = [...this._store.emotional]
      .sort((a, b) => this._emoRank(b) - this._emoRank(a))
      .slice(0, eFinal);
    const short = this._store.short.slice(0, sN); // 最新在前
    const long = this._store.long.slice(0, lN);

    // 输出顺序：情感高光 → 长期 → 近期对话（时间上由远及近更贴近对话流）
    return [
      ...emotional.map((it) => ({ ...it, type: 'emotional' })),
      ...long.map((it) => ({ ...it, type: 'long' })),
      ...short.map((it) => ({ ...it, type: 'short' })),
    ];
  }

  /**
   * 压缩长期记忆：long超过阈值时，取最旧一批用LLM压成一条摘要
   * @returns {Promise<{summarized:boolean, summary?:string, compressed?:number, message:string}>}
   */
  async summarize() {
    const pool = this._store.long;
    if (pool.length <= this.opts.longThreshold) {
      return { summarized: false, message: `long记忆 ${pool.length} 条未超过阈值 ${this.opts.longThreshold}，无需压缩` };
    }
    // 最旧的一批在数组尾部
    const batch = pool.splice(pool.length - this.opts.longBatch, this.opts.longBatch).reverse();
    const summary = await this._makeSummary(batch);

    const summaryItem = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      content: summary,
      meta: {
        timestamp: Date.now(),
        source: 'summarize',
        summarized: true,
        sourceCount: batch.length,
      },
    };
    pool.unshift(summaryItem);
    this._save();
    return {
      summarized: true,
      summary,
      compressed: batch.length,
      message: `已将最旧 ${batch.length} 条long记忆压缩为1条摘要`,
    };
  }

  // ---------- 内部：存储 ----------

  _load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.short) && Array.isArray(parsed.long) && Array.isArray(parsed.emotional)) {
        return parsed;
      }
    } catch (err) {
      console.warn('[MemoryService] 读取本地记忆失败，重新初始化:', err);
    }
    return null;
  }

  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this._store));
    } catch (err) {
      console.error('[MemoryService] 记忆保存失败:', err);
    }
  }

  /** 调试用：查看当前存储（含未持久化状态） */
  stats() {
    const s = this._store;
    return { short: s.short.length, long: s.long.length, emotional: s.emotional.length };
  }

  // ---------- 内部：相关性 ----------

  /** 分词：英文/数字词 + 中文单字与二元组（无embedding时的轻量方案） */
  _tokenize(text) {
    const tokens = new Set();
    const lower = String(text || '').toLowerCase();
    for (const w of lower.match(/[a-z0-9]+/g) || []) tokens.add(w);
    for (const run of lower.match(/[\u4e00-\u9fa5]+/g) || []) {
      for (let i = 0; i < run.length; i++) {
        tokens.add(run[i]);
        if (i + 1 < run.length) tokens.add(run.slice(i, i + 2));
      }
    }
    return tokens;
  }

  _tokenizedCache(item) {
    let t = _tokenCache.get(item);
    if (!t) {
      t = this._tokenize(item.content);
      _tokenCache.set(item, t);
    }
    return t;
  }

  /** emotional排序权重：score优先（高分=高光里程碑），同分更新近优先 */
  _emoRank(item) {
    const score = Number(item.meta?.score) || 0;
    return score * 1e12 + (item.meta?.timestamp || 0);
  }

  // ---------- 内部：摘要 ----------

  async _makeSummary(items) {
    const lines = items.map((it, i) => `${i + 1}. ${it.content}`).join('\n');
    if (this.llm) {
      const reply = await this.llm.chat([
        {
          role: 'system',
          content:
            '你是桌面宠物的记忆压缩器。把下列编号记忆压缩成一段简洁的第三人称摘要，保留关键事实（人名/数字/偏好/事件），不超过150字，直接输出摘要正文。',
        },
        { role: 'user', content: lines },
      ]);
      // LLM失败判定（保守：疑似失败即降级本地兜底，宁可摘要质量低也不丢数据）：
      // 空/过短回复、以"（"开头（llm.js错误串格式）、含错误特征关键词
      const t = typeof reply === 'string' ? reply.trim() : '';
      const failed = !t || t.length < 10 || t.startsWith('（') || /失败|错误|无法|请检查|请稍后/.test(t);
      if (!failed) return t;
      console.warn('[MemoryService] LLM摘要疑似失败，使用本地兜底:', reply);
    }
    // 本地兜底：逐条截取前30字拼接
    return `[摘要] ${items.map((it) => this._clip(it.content, 30)).join('；')}`;
  }

  _clip(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
}

export default MemoryService;
export { MemoryService, LEGACY_STORAGE_KEY, DEFAULT_MIGRATION_TARGET, DEFAULTS };
