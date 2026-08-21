// ============================================================
// characters.js — 角色管理器（角色工坊）
// 内置角色（handsome/beauty，assets/ 下 6 情绪帧）+ 用户自建角色
// （data/characters/{id}/normal.png，主进程 IPC 存取）。
// 注册表：localStorage 'pet-characters' =
//   [{id, name, source:'photo'|'ai', style, createdAt, model, path}]
// 活动角色：localStorage 'pet-active-character'（沿用 v1 的 key，向后兼容）
// ============================================================

const REGISTRY_KEY = 'pet-characters';
const ACTIVE_KEY = 'pet-active-character';
const DEFAULT_CHARACTER_ID = 'handsome';

// 内置角色（source:'builtin'，图片在 assets/characters/{id}/ 下，不可删除）
const BUILTIN_CHARACTERS = {
  handsome: { id: 'handsome', name: '凌川', role: '小狼狗', source: 'builtin' },
  beauty: { id: 'beauty', name: '苏晚', role: '小甜心', source: 'builtin' },
};

class CharacterManager {
  /**
   * @param {object} [opts]
   *   opts.ipc: {saveImage, deleteDir, readImage} 文件 IPC 适配器，
   *   缺省取 window.characterAPI（preload 注入）；node 测试可注入 mock。
   */
  constructor(opts = {}) {
    this.ipc = opts.ipc
      || (typeof window !== 'undefined' ? window.characterAPI : null)
      || null;
  }

  // ---------- 查询 ----------

  /** 全部角色（内置在前 + 用户角色按创建时间） */
  list() {
    const user = this._loadRegistry();
    return [...Object.values(BUILTIN_CHARACTERS).map((c) => ({ ...c })), ...user.map((c) => ({ ...c }))];
  }

  /** 按 id 取角色信息（内置或用户），未知返回 null */
  get(id) {
    if (BUILTIN_CHARACTERS[id]) return { ...BUILTIN_CHARACTERS[id] };
    const hit = this._loadRegistry().find((c) => c.id === id);
    return hit ? { ...hit } : null;
  }

  /** 当前活动角色 id（校验存在性，非法/已删除回退 'handsome'） */
  getActive() {
    let v = null;
    try { v = localStorage.getItem(ACTIVE_KEY); } catch { v = null; }
    return this.get(v) ? v : DEFAULT_CHARACTER_ID;
  }

  /** 设置活动角色（须存在于列表），返回设置后的 id */
  setActive(id) {
    if (!this.get(id)) return this.getActive();
    try { localStorage.setItem(ACTIVE_KEY, id); } catch (e) { /* ignore */ }
    return id;
  }

  /** 角色图片目录：内置 → assets 相对路径；用户 → data 相对路径；未知 → null */
  getDir(id) {
    if (BUILTIN_CHARACTERS[id]) return `assets/characters/${id}`;
    const hit = this._loadRegistry().find((c) => c.id === id);
    return hit ? (hit.path ? hit.path.replace(/\/normal\.png$/, '') : `data/characters/${id}`) : null;
  }

  /**
   * 渲染信息（sprite.js 加载用）：
   * 内置 → {mode:'frames', dir}；用户 → {mode:'single', imageBase64}
   * 未知/读取失败 → null
   */
  async resolve(id) {
    const info = this.get(id);
    if (!info) return null;
    if (info.source === 'builtin') {
      return { ...info, mode: 'frames', dir: `assets/characters/${id}` };
    }
    const b64 = await this.readImage(id);
    if (!b64) return null;
    return { ...info, mode: 'single', imageBase64: b64 };
  }

  /** 读用户角色图片（纯 base64）；内置角色/失败返回 null */
  async readImage(id) {
    if (BUILTIN_CHARACTERS[id] || !this.ipc) return null;
    const dir = this.getDir(id);
    if (!dir) return null;
    try {
      return await this.ipc.readImage(`${dir}/normal.png`);
    } catch (err) {
      console.error('[CharacterManager] readImage failed:', err);
      return null;
    }
  }

  // ---------- 写操作 ----------

  /**
   * 创建用户角色：保存图片（data URL 或纯 base64 均可）+ 注册
   * @param {string} name 角色名
   * @param {string} imageBase64 PNG 数据（可带 data:image/...;base64, 前缀）
   * @param {object} [meta] {source:'photo'|'ai', style, model}
   * @returns {Promise<{ok:boolean, character?:object, error?:string}>}
   */
  async create(name, imageBase64, meta = {}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { ok: false, error: '（角色名不能为空）' };
    const b64 = this._normalizeBase64(imageBase64);
    if (!b64 || b64.length < 32) return { ok: false, error: '（图片数据无效）' };
    if (!this.ipc) return { ok: false, error: '（当前环境不支持保存角色文件（需要 Electron 主进程 IPC））' };

    const id = this._genId();
    let res;
    try {
      res = await this.ipc.saveImage(id, b64);
    } catch (err) {
      return { ok: false, error: `（保存图片失败：${err && err.message ? err.message : err}）` };
    }
    if (!res || res.ok === false) {
      return { ok: false, error: `（保存图片失败：${(res && res.error) || '未知错误'}）` };
    }

    const entry = {
      id,
      name: cleanName.slice(0, 20),
      source: meta.source === 'photo' ? 'photo' : 'ai',
      style: String(meta.style || ''),
      createdAt: Date.now(),
      model: String(meta.model || ''),
      path: (res && res.path) || `data/characters/${id}/normal.png`,
    };
    const registry = this._loadRegistry();
    registry.push(entry);
    this._saveRegistry(registry);
    return { ok: true, character: { ...entry } };
  }

  /**
   * 删除用户角色（内置不可删），同时清理图片目录；
   * 若删除的是当前活动角色，活动角色回退 'handsome'。
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async remove(id) {
    if (BUILTIN_CHARACTERS[id]) {
      return { ok: false, error: '（内置角色不可删除）' };
    }
    const registry = this._loadRegistry();
    const idx = registry.findIndex((c) => c.id === id);
    if (idx < 0) return { ok: false, error: '（角色不存在）' };

    registry.splice(idx, 1);
    this._saveRegistry(registry);
    if (this.ipc) {
      try { await this.ipc.deleteDir(id); } catch (err) {
        console.warn('[CharacterManager] 删除图片目录失败（已从注册表移除）:', err);
      }
    }
    if (this.getActive() === id) this.setActive(DEFAULT_CHARACTER_ID);
    return { ok: true };
  }

  // ---------- 内部 ----------

  _genId() {
    return 'uc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  _normalizeBase64(b64) {
    if (typeof b64 !== 'string' || !b64) return '';
    const m = /^data:image\/[\w.+-]+;base64,(.*)$/s.exec(b64);
    return (m ? m[1] : b64).replace(/\s/g, '');
  }

  _loadRegistry() {
    try {
      const raw = localStorage.getItem(REGISTRY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr)
        ? arr.filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
        : [];
    } catch {
      return [];
    }
  }

  _saveRegistry(registry) {
    try {
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
    } catch (err) {
      console.warn('[CharacterManager] 注册表保存失败:', err);
    }
  }
}

export default CharacterManager;
export {
  CharacterManager,
  BUILTIN_CHARACTERS,
  REGISTRY_KEY,
  ACTIVE_KEY,
  DEFAULT_CHARACTER_ID,
};
