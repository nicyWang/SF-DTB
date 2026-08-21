// ============================================================
// knowledge.js — 个人知识库（越聊越懂主人）
// 机制：对话后 LLM 提取"值得长期记住的用户事实/偏好" → 智谱 embedding-3
// 向量化 → 本地 JSONL 存储 → chat 前按语义相似度检索 top-N 注入 system prompt
// 存储：localStorage 'pet-knowledge-db'（{items:[{id,text,vec,ts,hits}], embeddings:'zhipu-embedding-3'}）
// ============================================================

const KB_KEY = 'pet-knowledge-db';
const LLM_CONFIG_KEY = 'pet-llm-config';
const MAX_ITEMS = 300;          // 知识条目上限（超出淘汰最旧最少用）
const TOP_K = 6;                // 检索注入条数
const MIN_SCORE = 0.55;         // 相似度阈值（余弦）
const EXTRACT_EVERY = 2;        // 每 N 轮对话做一次提取（省 token）
const DEDUP_SCORE = 0.90;       // 高于此相似度视为重复

// 提取 prompt：从对话中挖"主人这个人的信息"
const EXTRACT_PROMPT = `你是记忆提取器。从下面的对话中提取关于"主人（用户）本人"的长期有用信息：职业/工作内容、技术栈、偏好（食物/音乐/游戏/风格）、习惯（作息/操作习惯）、人际关系（提及的人）、目标计划、观点立场、身体状况等。
规则：
- 只提取关于主人本人的稳定事实或偏好，不要提取一次性的闲聊内容
- 不要提取关于宠物/AI助手自己的内容
- 每条一句话，第三人称"主人"开头（如"主人是前端工程师，常用React"）
- 没有值得提取的内容就返回空数组
只返回JSON数组，不要任何其他文字或markdown围栏：["条目1","条目2"]`;

class KnowledgeBase {
  /**
   * @param {object} opts
   * @param {import('./llm.js').default} opts.llm LLM服务（提取+embedding共用配置）
   * @param {object} [opts.storage] localStorage兼容对象
   */
  constructor(opts = {}) {
    if (!opts.llm) throw new TypeError('KnowledgeBase: 必须注入 llm');
    this.llm = opts.llm;
    this.storage = opts.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    this._db = this._load();
    this._turnCount = 0;
  }

  // ---------- 存储 ----------

  _load() {
    if (!this.storage) return { items: [] };
    try {
      const raw = JSON.parse(this.storage.getItem(KB_KEY) || 'null');
      if (raw && Array.isArray(raw.items)) return raw;
    } catch { /* ignore */ }
    return { items: [] };
  }

  _save() {
    if (!this.storage) return;
    try { this.storage.setItem(KB_KEY, JSON.stringify(this._db)); } catch (e) {
      console.warn('[Knowledge] 保存失败（可能超容量）:', e?.message);
      // 容量满：砍掉一半最旧条目重试
      try {
        this._db.items.sort((a, b) => (a.ts + a.hits * 1e12) - (b.ts + b.hits * 1e12));
        this._db.items = this._db.items.slice(Math.floor(this._db.items.length / 2));
        this.storage.setItem(KB_KEY, JSON.stringify(this._db));
      } catch { /* 放弃 */ }
    }
  }

  // ---------- 对外接口 ----------

  /**
   * 对话轮次钩子：每 EXTRACT_EVERY 轮提取一次知识
   * @param {string} userText 主人这轮说的话
   * @param {string} assistantText 宠物回复
   */
  async onDialogue(userText, assistantText) {
    this._turnCount++;
    if (this._turnCount % EXTRACT_EVERY !== 0) return;
    if (this.llm.getConfig?.().model === 'mock') return; // mock 模式不烧假数据
    const facts = await this._extract(userText, assistantText);
    for (const f of facts) await this.add(f);
  }

  /**
   * 新增知识条目：LLM 提取的事实 → 向量化（失败也可检索文本，弱化模式）→ 去重入库
   * @param {string} text
   * @returns {Promise<boolean>} 是否入库
   */
  async add(text) {
    const clean = String(text || '').trim();
    if (!clean || clean.length < 6) return false; // 太短无信息量
    if (clean.length > 200) return false;

    const vec = await this._embed(clean).catch(() => null);
    // 语义去重：与已有条目相似度过高则合并（hits+1 刷新热度）
    if (vec) {
      for (const it of this._db.items) {
        if (it.vec && this._cosine(vec, it.vec) > DEDUP_SCORE) {
          it.hits = (it.hits || 0) + 1;
          it.ts = Date.now();
          if (clean.length > it.text.length) it.text = clean; // 留更完整的表述
          this._save();
          return false;
        }
      }
    } else {
      // 无向量时文本前缀去重
      if (this._db.items.some((it) => it.text === clean)) return false;
    }

    this._db.items.push({
      id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: clean,
      vec: vec || null,
      ts: Date.now(),
      hits: 0,
    });
    // 容量控制：淘汰最旧最少用
    if (this._db.items.length > MAX_ITEMS) {
      this._db.items.sort((a, b) => (a.ts + (a.hits || 0) * 1e12) - (b.ts + (b.hits || 0) * 1e12));
      this._db.items = this._db.items.slice(-MAX_ITEMS);
    }
    this._save();
    return true;
  }

  /**
   * 检索与查询最相关的知识（余弦相似度）
   * @param {string} query
   * @param {number} [topK]
   * @returns {Promise<Array<{text:string, score:number}>>}
   */
  async search(query, topK = TOP_K) {
    const q = String(query || '').trim();
    if (!q || !this._db.items.length) return [];
    const qvec = await this._embed(q).catch(() => null);

    let scored;
    if (qvec) {
      scored = this._db.items
        .filter((it) => it.vec)
        .map((it) => ({ text: it.text, score: this._cosine(qvec, it.vec), id: it.id }))
        .filter((s) => s.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score);
    } else {
      // 弱化模式：关键词匹配
      const kws = [...new Set(q.split(/[\s,，。？?！!、]+/).filter((w) => w.length >= 2))];
      scored = this._db.items
        .map((it) => {
          const hits = kws.filter((k) => it.text.includes(k)).length;
          return { text: it.text, score: kws.length ? hits / kws.length : 0, id: it.id };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
    }
    const top = scored.slice(0, topK);
    // 命中热度 +1（越用越靠前的正反馈）
    for (const s of top) {
      const it = this._db.items.find((x) => x.id === s.id);
      if (it) it.hits = (it.hits || 0) + 1;
    }
    if (top.length) this._save();
    return top.map(({ text, score }) => ({ text, score: Math.round(score * 100) / 100 }));
  }

  /** 组装注入 system prompt 的知识块 */
  async buildPromptBlock(query) {
    const hits = await this.search(query);
    if (!hits.length) return '';
    return '【对主人的了解（按相关度）】\n' + hits.map((h) => `- ${h.text}`).join('\n');
  }

  stats() {
    return {
      count: this._db.items.length,
      vectorized: this._db.items.filter((it) => it.vec).length,
    };
  }

  clear() {
    this._db = { items: [] };
    this._save();
  }

  // ---------- 内部 ----------

  async _extract(userText, assistantText) {
    try {
      const reply = await this.llm.chat([
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `【主人说】${String(userText || '').slice(0, 800)}\n【你回复】${String(assistantText || '').slice(0, 400)}` },
      ]);
      const m = String(reply || '').match(/\[[\s\S]*\]/);
      if (!m) return [];
      const arr = JSON.parse(m[0]);
      return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, 5) : [];
    } catch (e) {
      console.warn('[Knowledge] 提取失败:', e?.message);
      return [];
    }
  }

  /** 智谱 embedding-3（OpenAI 兼容 /embeddings） */
  async _embed(text) {
    const cfg = this.llm.getConfig?.() || {};
    const base = String(cfg.baseURL || '').replace(/\/+$/, '');
    if (!base || !cfg.apiKey) throw new Error('未配置 LLM');
    const res = await fetch(base + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: 'embedding-3', input: String(text).slice(0, 512), dimensions: 1024 }),
    });
    if (!res.ok) throw new Error('embeddings HTTP ' + res.status);
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error('embedding 格式异常');
    return vec;
  }

  _cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }
}

export default KnowledgeBase;
export { KnowledgeBase, KB_KEY };
