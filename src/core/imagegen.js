// ============================================================
// imagegen.js — 生图服务（OpenAI 兼容 images/generations，fetch 直调）
// 运行环境：Electron 渲染进程（浏览器环境，ES module）
// 契约：class ImageGenService { generate / setConfig / getConfig }
//   - generate 永不 throw，统一返回 {ok, imageBase64?, error?, mock?}
//   - mock 模式（model='mock'）：canvas 程序化生成占位立绘，零成本测试全流程
//   - 配置持久化 localStorage 'pet-imagegen-config'：{baseURL, apiKey, model}
// ============================================================

const STORAGE_KEY = 'pet-imagegen-config';

const DEFAULT_CONFIG = {
  baseURL: '',
  apiKey: '',
  model: '',
};

// 无 canvas 环境（node 单测）的兜底 1x1 PNG（透明）
const FALLBACK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

class ImageGenService {
  /**
   * @param {object} [config] {baseURL, apiKey, model} 缺省从 localStorage 读取，再缺省用默认值
   * 显式传入字段优先级最高（不落盘，除非调用 setConfig）
   */
  constructor(config) {
    const stored = this._loadConfig();
    this.config = { ...DEFAULT_CONFIG, ...stored, ...(config || {}) };
  }

  // ---------- 配置 ----------

  setConfig(newConfig) {
    this.config = { ...this.config, ...(newConfig || {}) };
    this._saveConfig();
    return this.getConfig();
  }

  getConfig() {
    return { ...this.config };
  }

  // ---------- 对外接口 ----------

  /**
   * 生成立绘图片
   * @param {string} prompt 生图提示词
   * @param {string} [size] 尺寸，默认 '1024x1536'（竖版立绘）
   * @returns {Promise<{ok:boolean, imageBase64?:string, error?:string, mock?:boolean}>}
   */
  async generate(prompt, size = '1024x1536') {
    if (this._isMock()) return this._mockGenerate(size);

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { ok: false, error: '（生图失败：提示词为空）' };
    }
    if (!this.config.baseURL || !this.config.model) {
      return { ok: false, error: '（生图服务未配置：请先填写 Base URL、模型并保存）' };
    }

    let res;
    try {
      res = await fetch(this._url('/images/generations'), {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          n: 1,
          size,
        }),
      });
    } catch (err) {
      console.error('[ImageGenService] network error:', err);
      return { ok: false, error: this._friendlyError(err, null) };
    }
    if (!res.ok) {
      const errText = await this._errText(res);
      console.error(`[ImageGenService] HTTP ${res.status}:`, errText);
      return { ok: false, error: this._friendlyError(null, res.status) };
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: '（生图接口返回了非 JSON 内容：请检查 baseURL 是否指向 OpenAI 兼容的 /v1 端点）' };
    }

    const item = data && Array.isArray(data.data) ? data.data[0] : null;
    if (item && typeof item.b64_json === 'string' && item.b64_json) {
      return { ok: true, imageBase64: item.b64_json };
    }
    if (item && typeof item.url === 'string' && item.url) {
      // url 形式：下载图片转 base64
      try {
        const imgRes = await fetch(item.url);
        if (!imgRes.ok) {
          return { ok: false, error: `（图片下载失败 HTTP ${imgRes.status}）` };
        }
        const buf = await imgRes.arrayBuffer();
        return { ok: true, imageBase64: this._bufToBase64(buf) };
      } catch (err) {
        console.error('[ImageGenService] image download error:', err);
        return { ok: false, error: `（图片下载失败：${err && err.message ? err.message : err}）` };
      }
    }
    console.error('[ImageGenService] unexpected response shape:', data);
    return { ok: false, error: '（生图接口返回格式异常：缺少 b64_json / url 字段）' };
  }

  // ---------- 内部：请求构造 ----------

  _url(path) {
    const base = (this.config.baseURL || '').replace(/\/+$/, '');
    return `${base}${path}`;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async _errText(res) {
    try {
      const t = await res.text();
      return t.slice(0, 500);
    } catch {
      return '(无响应体)';
    }
  }

  // ---------- 内部：Mock 模式 ----------

  _isMock() {
    return this.config.model === 'mock';
  }

  /**
   * mock 生图：canvas 程序化绘制占位立绘（浅灰背景 + 人形轮廓 + "MOCK角色"文字）
   * 浅灰背景 (#d9d9d9) 保证 sprite.js 的 chroma key 能扣掉；轮廓深色保留。
   * 无 canvas 环境（node）退化为 1x1 PNG 常量。
   */
  async _mockGenerate(size) {
    const { w, h } = this._parseSize(size);
    try {
      if (typeof document === 'undefined' || !document.createElement) {
        throw new Error('no document');
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');

      // 浅灰纯色背景（chroma key 可处理）
      ctx.fillStyle = '#d9d9d9';
      ctx.fillRect(0, 0, w, h);

      // 人形轮廓（头 + 肩到脚的躯干），深色保留
      const cx = w / 2;
      ctx.fillStyle = '#5a6e85';
      ctx.beginPath(); // 头
      ctx.arc(cx, h * 0.16, w * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath(); // 躯干（肩→脚梯形，肩部圆滑）
      ctx.moveTo(cx - w * 0.20, h * 0.94);
      ctx.lineTo(cx - w * 0.10, h * 0.29);
      ctx.quadraticCurveTo(cx, h * 0.25, cx + w * 0.10, h * 0.29);
      ctx.lineTo(cx + w * 0.20, h * 0.94);
      ctx.closePath();
      ctx.fill();

      // 文字标注
      ctx.fillStyle = '#3a4656';
      ctx.font = `bold ${Math.max(16, Math.round(w * 0.07))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('MOCK角色', cx, h * 0.055);

      const dataUrl = canvas.toDataURL('image/png');
      return { ok: true, imageBase64: dataUrl.replace(/^data:image\/\w+;base64,/, ''), mock: true };
    } catch {
      return { ok: true, imageBase64: FALLBACK_PNG_BASE64, mock: true };
    }
  }

  _parseSize(size) {
    const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(size || ''));
    let w = m ? parseInt(m[1], 10) : 1024;
    let h = m ? parseInt(m[2], 10) : 1536;
    const clamp = (v) => Math.max(64, Math.min(1536, v));
    w = clamp(w);
    h = clamp(h);
    return { w, h };
  }

  // ---------- 内部：二进制 → base64（浏览器/node 通用） ----------

  _bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      return Buffer.from(bytes).toString('base64');
    }
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ---------- 内部：配置持久化（localStorage） ----------

  _loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  _saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch (err) {
      console.warn('[ImageGenService] 配置保存失败:', err);
    }
  }

  // ---------- 内部：友好错误 ----------

  _friendlyError(err, status) {
    if (err && /Failed to fetch|NetworkError|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(err))) {
      return '（网络连接失败：请检查网络，以及生图 baseURL 是否正确可达）';
    }
    if (status === 401) return '（鉴权失败：API Key 未填写或无效）';
    if (status === 403) return '（无权限：该 Key 无权访问此模型，或账号受限）';
    if (status === 404) return '（接口不存在：请检查 baseURL，应形如 https://api.openai.com/v1）';
    if (status === 429) return '（请求受限：调用过于频繁或额度不足，请稍后再试）';
    if (status >= 500) return `（服务端错误 HTTP ${status}：请稍后重试或更换端点）`;
    if (err) return `（请求出错：${String(err && err.message ? err.message : err)}）`;
    return `（生图失败 HTTP ${status}）`;
  }
}

export default ImageGenService;
export { ImageGenService, DEFAULT_CONFIG, STORAGE_KEY };
