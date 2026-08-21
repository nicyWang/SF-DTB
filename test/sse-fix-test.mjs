// llm.js chatStream SSE分隔符修复验证（stub fetch，覆盖\n\n与\r\n\r\n及跨chunk截断）
const kv = new Map();
globalThis.localStorage = {
  getItem: (k) => (kv.has(k) ? kv.get(k) : null),
  setItem: (k, v) => kv.set(k, String(v)),
};

const { default: LLMService } = await import('../src/core/llm.js');

let pass = 0, fail = 0;
const assert = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.error('FAIL:', name, extra); }
};

// 构造stub fetch：body为可分块推送的reader
const makeStreamFetch = (chunks) => {
  let i = 0;
  return async () => ({
    ok: true,
    json: async () => ({}),
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) return { done: false, value: new TextEncoder().encode(chunks[i++]) };
            return { done: true, value: undefined };
          },
        };
      },
    },
  });
};

const runStream = async (chunks) => {
  const svc = new LLMService({ baseURL: 'http://x/v1', apiKey: 'k', model: 'gpt-4o-mini' });
  let out = '';
  const full = await svc.chatStream([{ role: 'user', content: 'hi' }], (d) => { out += d; });
  return { out, full };
};

// 1. 标准LF分隔（回归：现有行为不变）
{
  globalThis.fetch = makeStreamFetch([
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"呀"}}]}\n\ndata: [DONE]\n\n',
  ]);
  const { out, full } = await runStream();
  assert('\\n\\n分隔正常解析', out === '你好呀' && full === '你好呀', JSON.stringify({ out, full }));
}

// 2. CRLF分隔（本次修复目标）
{
  globalThis.fetch = makeStreamFetch([
    'data: {"choices":[{"delta":{"content":"晚"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"上"}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
  ]);
  const { out, full } = await runStream();
  assert('\\r\\n\\r\\n分隔正常解析', out === '晚上好' && full === '晚上好', JSON.stringify({ out, full }));
}

// 3. 跨chunk截断的CRLF事件（\r在上一chunk末尾，\n\r\n在下一chunk）
{
  globalThis.fetch = makeStreamFetch([
    'data: {"choices":[{"delta":{"content":"截"}}]}\r',
    '\n\r\ndata: {"choices":[{"delta":{"content":"断"}}]}\r\n\r\n',
  ]);
  const { out } = await runStream();
  assert('跨chunk截断的CRLF事件不丢', out === '截断', JSON.stringify(out));
}

// 4. 结尾残留buffer（无尾随空行）flush
{
  globalThis.fetch = makeStreamFetch([
    'data: {"choices":[{"delta":{"content":"尾"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"巴"}}]}',
  ]);
  const { out } = await runStream();
  assert('结尾无空行的事件被flush', out === '尾巴', JSON.stringify(out));
}

console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
