// ============================================================
// llm.js — LLM 服务封装（OpenAI 兼容 API，fetch 直调，无 SDK）
// 运行环境：Electron 渲染进程（浏览器环境，ES module）
// 契约见 CONTRACT.md：class LLMService { chat / chatStream / vision }
// ============================================================

const STORAGE_KEY = 'pet-llm-config';

const DEFAULT_CONFIG = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  visionModel: '', // 可选：独立视觉模型（如 glm-4v-flash）；空则用 model
};

class LLMService {
  /**
   * @param {object} [config] {baseURL, apiKey, model} 缺省从 localStorage 读取，再缺省用默认值
   * 显式传入的字段优先级最高（不落盘，除非调用 setConfig）
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
   * 普通对话（非流式）
   * @param {Array<{role:string, content:(string|Array)}>} messages OpenAI 格式
   * @returns {Promise<string>} 助手回复文本；出错时返回友好错误信息字符串
   */
  async chat(messages) {
    if (this._isMock()) return this._mockReply(messages);

    let res;
    try {
      res = await fetch(this._url('/chat/completions'), {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ model: this.config.model, messages, stream: true, thinking: { type: 'disabled' } }),
      });
    } catch (err) {
      console.error('[LLMService] chat network error:', err);
      return this._friendlyError(err, null);
    }
    if (!res.ok) {
      const errText = await this._errText(res);
      console.error(`[LLMService] chat HTTP ${res.status}:`, errText);
      return this._friendlyError(null, res.status, errText);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    // content 为数组（部分兼容端点返回分段）时拼接文本段
    if (Array.isArray(content)) {
      return content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    }
    console.error('[LLMService] unexpected response shape:', data);
    return '（模型返回了空内容，请重试或更换模型）';
  }

  /**
   * 工具调用对话（Agent核心）：messages + tools → 模型可能发起tool_calls →
   * 执行工具（executor）→ 结果回传 → 循环直至最终文本回复
   * @param {Array} messages OpenAI格式消息
   * @param {Array} tools 工具定义（TOOL_SPECS）
   * @param {Function} executor async (name, args) => string 工具执行器
   * @param {Function} [onToolCall] (name, args) => void 工具调用提示回调（可选，用于气泡显示"正在执行xx"）
   * @returns {Promise<string>} 最终回复文本
   */
  async chatWithTools(messages, tools, executor, onToolCall) {
    if (this._isMock()) return this._mockReply(messages);
    const msgs = [...messages];
    for (let round = 0; round < 6; round++) { // 最多6轮工具调用防死循环
      let res;
      try {
        res = await fetch(this._url('/chat/completions'), {
          method: 'POST',
          headers: this._headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: msgs,
          thinking: { type: 'disabled' }, // 思考型模型(豆包Seed2.1)会吞token不吐正文——语音对话要快
          tools,
          tool_choice: 'auto',
          stream: true,
        }),
        });
      } catch (err) {
        return this._friendlyError(err, null);
      }
      if (!res.ok) {
        const errText = await this._errText(res);
        console.error(`[LLMService] tools HTTP ${res.status}:`, errText);
        return this._friendlyError(null, res.status, await this._errText(res));
      }
      const full = await this._readToolStream(res, onToolCall);
      if (full !== null) {
        if (!full.trim()) return '（模型返回空，请重试）';
        return full;
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message;
      if (!msg) return '（模型返回空，请重试）';
      let toolCalls = this._lastToolCalls || msg.tool_calls;
      this._lastToolCalls = null;
      // 无工具调用 且 首轮 且 用户消息像操作指令 → glm-4-flash 工具多时"选择困难"不发起；
      // 二阶段：tool_choice:'required' 强制重试一次（判断该不该调由意图启发式把关）
      if ((!toolCalls || !toolCalls.length) && round === 0) {
        const lastUser = String((msgs[msgs.length - 1] || {}).content || '');
        const looksLikeAction = /(打开|关闭|关掉|点|按|输入|填|发送|发|提醒|闹钟|看看|列出|读取|写入|移动|整理|截屏|截图|滚|拖)/.test(lastUser);
        if (looksLikeAction) {
          try {
            const res2 = await fetch(this._url('/chat/completions'), {
              method: 'POST',
              headers: this._headers(),
              body: JSON.stringify({
                model: this.config.model,
                messages: msgs,
                thinking: { type: 'disabled' },
                tools,
                tool_choice: 'required',
                stream: true,
              }),
            });
            if (res2.ok) {
              const forcedFull = await this._readToolStream(res2);
              const forcedCalls = this._lastToolCalls || [];
              this._lastToolCalls = null;
              if (forcedCalls.length) {
                // 用强制结果继续（把 msg 换成 msg2）
                msgs.push({ role: 'assistant', content: forcedFull || '', tool_calls: forcedCalls });
                for (const tc of forcedCalls) {
                  const name = tc?.function?.name;
                  let args = {};
                  try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* ignore */ }
                  if (typeof onToolCall === 'function') { try { onToolCall(name, args); } catch (e) { /* ignore */ } }
                  let toolResult;
                  try {
                    const r = await executor(name, args);
                    toolResult = typeof r === 'string' ? r : JSON.stringify(r);
                  } catch (err) {
                    toolResult = `工具执行错误: ${err.message || err}`;
                  }
                  if (toolResult.length > 6000) toolResult = toolResult.slice(0, 6000) + '...（截断）';
                  msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(toolResult) });
                }
                continue; // 带工具结果进入下一轮
              }
            }
          } catch (e) { /* required 重试失败→按无工具处理 */ }
        }
      }
      if (!toolCalls || !toolCalls.length) {
        const content = typeof msg.content === 'string' ? msg.content
          : (Array.isArray(msg.content) ? msg.content.map(p => p?.text || '').join('') : '');
        return content || '（我做完了～）';
      }
      // 有工具调用 → 逐个执行并回传
      msgs.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const name = tc?.function?.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { /* 容错空参数 */ }
        let toolResult;
        if (typeof onToolCall === 'function') { try { onToolCall(name, args); } catch (e) { /* ignore */ } }
        try {
          const r = await executor(name, args);
          toolResult = typeof r === 'string' ? r : JSON.stringify(r);
        } catch (err) {
          toolResult = `工具执行错误: ${err.message || err}`;
        }
        if (toolResult.length > 6000) toolResult = toolResult.slice(0, 6000) + '...（截断）';
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(toolResult) });
      }
      // 继续下一轮：带上工具结果再次请求
    }
    return '（工具调用轮次太多，我先停一下～）';
  }

  async _readToolStream(res, onToolCall) {
    if (!res.body || typeof res.body.getReader !== 'function') return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolBuffers = new Map();
    const handleEvent = (eventText) => {
      const lines = eventText.split(/\r?\n/);
      const dataLines = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
      if (!dataLines.length) return;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;
      let json;
      try { json = JSON.parse(payload); } catch { return; }
      const delta = json?.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content) content += delta.content;
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0;
        if (!toolBuffers.has(index)) toolBuffers.set(index, { id: '', name: '', arguments: '' });
        const item = toolBuffers.get(index);
        if (call.id) item.id = call.id;
        if (call.function?.name) item.name = call.function.name;
        if (call.function?.arguments) item.arguments += call.function.arguments;
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const event of events) handleEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(buffer);
    } catch (err) {
      console.error('[LLMService] tools stream read error:', err);
      if (!content) return null;
    }
    if (toolBuffers.size) {
      this._lastToolCalls = [...toolBuffers.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => ({
        id: item.id,
        function: { name: item.name, arguments: item.arguments || '{}' },
      }));
      return '';
    }
    this._lastToolCalls = null;
    return content;
  }

  /**
   * 流式对话
   * @param {Array} messages OpenAI 格式
   * @param {(deltaText: string) => void} onChunk 每次收到增量文本回调
   * @returns {Promise<string>} 完整回复文本；出错时通过 onChunk 推送友好错误并返回该错误字符串
   */
  async chatStream(messages, onChunk) {
    if (typeof onChunk !== 'function') {
      throw new TypeError('chatStream(messages, onChunk): onChunk 必须是函数');
    }
    if (this._isMock()) return this._mockStream(messages, onChunk);

    let res;
    try {
      res = await fetch(this._url('/chat/completions'), {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ model: this.config.model, messages, stream: true, thinking: { type: 'disabled' } }),
      });
    } catch (err) {
      console.error('[LLMService] chatStream network error:', err);
      const msg = this._friendlyError(err, null);
      onChunk(msg);
      return msg;
    }
    if (!res.ok) {
      const errText = await this._errText(res);
      console.error(`[LLMService] chatStream HTTP ${res.status}:`, errText);
      const msg = this._friendlyError(null, res.status, await this._errText(res));
      onChunk(msg);
      return msg;
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      // 运行环境不支持流式读取，降级为非流式
      console.warn('[LLMService] res.body 不可读，降级为非流式请求');
      const full = await this.chat(messages);
      onChunk(full);
      return full;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    const handleEvent = (evtText) => {
      const delta = this._parseSSEEvent(evtText);
      if (delta) {
        full += delta;
        onChunk(delta);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE事件分隔：规范为空行，兼容 \n\n 与 \r\n\r\n（部分网关/代理会改写换行符）
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const evt of events) handleEvent(evt);
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(buffer);
    } catch (err) {
      console.error('[LLMService] chatStream read error:', err);
      // 错误文案不进 onChunk（会被气泡展示+TTS念出"HTTP xxx"）——仅返回值携带，调用方清洗
      return full + this._friendlyError(err, null);
    }
    return full;
  }

  /**
   * 视觉理解：传入 base64 图片 + 文本提问
   * @param {string} imageBase64 纯 base64（不含 data: 前缀）
   * @param {string} [prompt] 提问文本，默认"请描述这张图片"
   * @param {string} [mime] 图片MIME子类型（如 'png'/'jpeg'/'webp'）；缺省自动探测：
   *   base64以 iVBOR 开头（PNG魔数）判为 png，否则 jpeg（历史默认，向后兼容）
   * @returns {Promise<string>}
   */
  async vision(imageBase64, prompt, mime) {
    if (this._isMock()) return this._mockVisionReply(imageBase64, prompt);

    const detected = typeof imageBase64 === 'string' && imageBase64.startsWith('iVBOR')
      ? 'png' : 'jpeg';
    const mimeSub = mime || detected;

    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt || '请描述这张图片' },
          {
            type: 'image_url',
            image_url: { url: `data:image/${mimeSub};base64,${imageBase64}` },
          },
        ],
      },
    ];
    // 视觉模型：visionModel > model（智谱 glm-4v-flash 免费且带视觉；主模型自带视觉时可不配）
    const useModel = this.config.visionModel || this.config.model;
    let res;
    try {
      res = await fetch(this._url('/chat/completions'), {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({ model: useModel, messages }),
      });
    } catch (err) {
      return this._friendlyError(err, null);
    }
    if (!res.ok) {
      const errText = await this._errText(res);
      console.error(`[LLMService] vision HTTP ${res.status}:`, errText);
      return this._friendlyError(null, res.status, await this._errText(res));
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    }
    return '（视觉模型返回空内容）';
  }

  // ---------- 内部：请求构造 ----------

  _url(path) {
    const base = (this.config.baseURL || DEFAULT_CONFIG.baseURL).replace(/\/+$/, '');
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

  // ---------- 内部：SSE 解析 ----------

  /** 解析单个 SSE 事件块，返回拼接后的 delta 文本（可能为 null） */
  _parseSSEEvent(evtText) {
    if (!evtText) return null;
    let out = '';
    for (const line of evtText.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) out += delta;
      } catch {
        // JSON 不完整（跨 chunk 截断）——留在 buffer 的场景由外层 split 保证，此处忽略
      }
    }
    return out || null;
  }

  // ---------- 内部：Mock 模式 ----------

  _isMock() {
    return this.config.model === 'mock';
  }

  _mockReply(messages) {
    const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user');
    const text =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.filter((p) => p?.type === 'text').map((p) => p.text).join(' ')
          : '';

    if (/你好|您好|hello|hi|嗨|哈喽/i.test(text)) {
      return '[mock] 你好呀主人！我是mock模式下的桌面搭档，不需要API key也能陪你说说话～';
    }
    if (/[?？]\s*$/.test(text) || text.includes('?') || text.includes('？')) {
      return '[mock] 这是个好问题！不过我目前运行在mock模式（model="mock"），只会说预设的话。在设置里填好 baseURL、apiKey 和真实模型名，我就能认真回答啦。';
    }
    if (/你是谁|你叫什么|introduce/i.test(text)) {
      return '[mock] 我是你的桌面AI搭档（mock模式），负责陪你聊天、看屏幕、直播时帮你接弹幕。';
    }
    const pool = [
      '[mock] 收到收到！虽然我现在的脑子是预设的（mock模式），但我一直在听～',
      '[mock] 唔……mock模式的我暂时想不到机智的回答，先卖个萌吧 (ฅ\'ω\'ฅ)',
      '[mock] 主人说的有道理！等我接上真实模型，我们再深入聊这个话题。',
      '[mock] （戳了戳屏幕）在的在的，mock模式下我也会认真陪伴哦。',
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _mockVisionReply(imageBase64, prompt) {
    const scenes = ['工作', '摸鱼', '写代码', '看文档', '聊天'];
    const scene = scenes[Math.floor(Math.random() * scenes.length)];
    const size = imageBase64 ? `（图片数据 ${Math.round(imageBase64.length * 0.75 / 1024)}KB）` : '';
    return `[mock]（视觉模拟${size}）我"看"了一眼屏幕：主人好像正在${scene}。${
      prompt ? `关于"${prompt}"——mock模式下我无法真正识图，接上支持vision的模型后即可真正看屏幕。` : ''
    }`;
  }

  async _mockStream(messages, onChunk) {
    const reply = this._mockReply(messages);
    for (const ch of reply) {
      onChunk(ch);
      await new Promise((r) => setTimeout(r, 25));
    }
    return reply;
  }

  // ---------- 内部：配置持久化（localStorage） ----------

  _loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      console.warn('[LLMService] 读取本地配置失败，使用默认配置:', err);
      return {};
    }
  }

  _saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch (err) {
      console.warn('[LLMService] 配置保存失败:', err);
    }
  }

  // ---------- 内部：友好错误 ----------

  _friendlyError(err, status, errText = '') {
    if (err && /Failed to fetch|NetworkError|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(err))) {
      return '（网络连接失败：请检查网络，以及 baseURL 是否正确可达）';
    }
    if (status === 401) return '（鉴权失败：API Key 未填写或无效）';
    if (status === 403) return '（无权限：该 Key 无权访问此模型，或账号受限）';
    if (status === 404) {
      if (/InvalidEndpointOrModel|model or endpoint/i.test(errText)) {
        return '（模型或推理接入点不存在/无权限：请到火山方舟开通模型，并把“模型”改成 ep-xxx 或可用模型 ID）';
      }
      return '（接口不存在：请检查 baseURL，应形如 https://api.openai.com/v1）';
    }
    if (status === 429) return '（请求受限：调用过于频繁或额度不足，请稍后再试）';
    if (status >= 500) return `（服务端错误 HTTP ${status}：请稍后重试或更换端点）`;
    if (err) return `（请求出错：${String(err && err.message ? err.message : err)}）`;
    return `（请求失败 HTTP ${status}）`;
  }
}

export default LLMService;
export { LLMService, DEFAULT_CONFIG, STORAGE_KEY };
