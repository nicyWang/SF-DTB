// knowledge-test.mjs — 知识库（越聊越懂我）单测
// mock llm + mock fetch(embeddings) + 内存 storage

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('PASS: ' + name); }
  else { fail++; console.log('FAIL: ' + name + (detail ? ' (' + detail + ')' : '')); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 内存 localStorage
function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// mock LLM：提取按脚本返回
function makeLLM(extractScript = []) {
  let i = 0;
  return {
    getConfig: () => ({ model: 'glm-4-flash', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k' }),
    chat: async () => {
      const r = extractScript[i] ?? '[]';
      i++;
      return r;
    },
  };
}

// mock fetch：embeddings 返回确定性向量
const origFetch = globalThis.fetch;
function installMockFetch(vecFn) {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/embeddings')) {
      const body = JSON.parse(init.body);
      const vec = vecFn(body.input);
      return { ok: true, json: async () => ({ data: [{ embedding: vec }] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

const { KnowledgeBase, KB_KEY } = await import('../src/core/knowledge.js');

// ---------- 1. 构造校验 ----------
{
  try { new KnowledgeBase({}); assert('缺llm抛TypeError', false); }
  catch (e) { assert('缺llm抛TypeError', e instanceof TypeError); }
}

// ---------- 2. add + 向量化 + 容量 ----------
{
  const storage = makeStorage();
  // 三组正交基向量（测余弦相似度）
  installMockFetch((text) => {
    const g = /React|前端/.test(text) ? [1, 0, 0] : /火锅|辣/.test(text) ? [0, 1, 0] : [0, 0, 1];
    return g;
  });
  const kb = new KnowledgeBase({ llm: makeLLM(), storage });
  const r1 = await kb.add('主人是前端工程师，常用React技术栈');
  assert('知识入库', r1 === true && kb.stats().count === 1);
  assert('条目已向量化', kb.stats().vectorized === 1);
  const r2 = await kb.add('主人特别喜欢吃火锅，无辣不欢');
  assert('第二条入库', r2 === true && kb.stats().count === 2);
  const r3 = await kb.add('短');
  assert('过短文本拒收', r3 === false && kb.stats().count === 2);
  // 语义去重：同向量的近似表述
  const r4 = await kb.add('主人喜欢React和前端开发');
  assert('高相似语义去重（不入库）', r4 === false && kb.stats().count === 2);
  // 持久化
  const raw = JSON.parse(storage.getItem(KB_KEY));
  assert('localStorage持久化', Array.isArray(raw.items) && raw.items.length === 2);
}

// ---------- 3. search 余弦检索 ----------
{
  const storage = makeStorage();
  // 4维正交：技术/饮食/宠物/天气（天气查询向量独立，验证不误命中）
  installMockFetch((text) => {
    if (/React|前端|代码/.test(text)) return [1, 0, 0, 0];
    if (/火锅|辣|吃/.test(text)) return [0, 1, 0, 0];
    if (/猫|团子/.test(text)) return [0, 0, 1, 0];
    return [0, 0, 0, 1]; // 天气等其它 → 独立维度
  });
  const kb = new KnowledgeBase({ llm: makeLLM(), storage });
  await kb.add('主人是前端工程师，常用React技术栈');
  await kb.add('主人特别喜欢吃火锅，无辣不欢');
  await kb.add('主人养了一只叫团子的橘猫');
  const hits1 = await kb.search('帮我看看这段React代码');
  assert('技术话题检索到技术知识', hits1.length === 1 && hits1[0].text.includes('React'), JSON.stringify(hits1));
  const hits2 = await kb.search('晚饭吃火锅怎么样');
  assert('吃饭话题检索到饮食偏好', hits2.length === 1 && hits2[0].text.includes('火锅'));
  const hits3 = await kb.search('今天天气怎么样');
  assert('无关话题无检索结果', hits3.length === 0, JSON.stringify(hits3));
  // 命中热度累计
  await kb.search('React组件怎么写');
  const raw = JSON.parse(storage.getItem(KB_KEY));
  const react = raw.items.find((i) => i.text.includes('React'));
  assert('检索命中热度累计', (react.hits || 0) >= 2, 'hits=' + (react.hits || 0));
}

// ---------- 4. onDialogue 提取链路 ----------
{
  const storage = makeStorage();
  // 向量按内容区分（深圳/健身 各自独立维度，避免被语义去重合并）
  installMockFetch((text) => {
    if (/深圳|后端/.test(text)) return [1, 0, 0];
    if (/健身| gym/.test(text)) return [0, 1, 0];
    return [0, 0, 1];
  });
  // onDialogue 首轮不提取（EXTRACT_EVERY=2），第二轮首次调用 chat → 直接返回事实
  const llm = makeLLM(['["主人在深圳工作，是后端程序员", "主人最近在健身，每周去三次健身房"]']);
  const kb = new KnowledgeBase({ llm, storage });
  await kb.onDialogue('你好', '你好呀');
  assert('首轮不提取（EXTRACT_EVERY=2）', kb.stats().count === 0);
  await kb.onDialogue('我在深圳做后端开发，最近开始健身了', '深圳很好呀，健身要坚持哦！');
  assert('第二轮提取两条', kb.stats().count === 2, 'count=' + kb.stats().count);
}

// ---------- 5. mock 模式跳过提取 ----------
{
  const storage = makeStorage();
  installMockFetch(() => [1, 0]);
  const llm = makeLLM(['["主人是测试员"]']);
  llm.getConfig = () => ({ model: 'mock' });
  const kb = new KnowledgeBase({ llm, storage });
  await kb.onDialogue('a', 'b');
  await kb.onDialogue('c', 'd');
  assert('mock模式不提取', kb.stats().count === 0);
}

// ---------- 6. buildPromptBlock 注入格式 ----------
{
  const storage = makeStorage();
  installMockFetch((text) => /React|代码/.test(text) ? [1, 0] : [0, 1]);
  const kb = new KnowledgeBase({ llm: makeLLM(), storage });
  await kb.add('主人是前端工程师，常用React技术栈');
  await kb.add('主人喜欢熬夜写代码到凌晨');
  const block = await kb.buildPromptBlock('React代码');
  assert('知识块包含标题', block.includes('【对主人的了解'));
  assert('知识块含检索命中条目', block.includes('- 主人'), block);
}

// ---------- 7. embedding失败降级关键词检索 ----------
{
  const storage = makeStorage();
  globalThis.fetch = async () => { throw new Error('network down'); };
  const kb = new KnowledgeBase({ llm: makeLLM(), storage });
  await kb.add('主人是前端工程师，常用React技术栈'); // 向量失败仍入库
  await kb.add('主人特别喜欢火锅');
  assert('向量失败仍入库', kb.stats().count === 2 && kb.stats().vectorized === 0);
  const hits = await kb.search('React 前端');
  assert('降级关键词检索', hits.length === 1 && hits[0].text.includes('React'), JSON.stringify(hits));
}

// ---------- 8. clear ----------
{
  const storage = makeStorage();
  installMockFetch(() => [1]);
  const kb = new KnowledgeBase({ llm: makeLLM(), storage });
  await kb.add('主人的测试知识条目');
  kb.clear();
  assert('clear清空', kb.stats().count === 0);
}

// 恢复 fetch
globalThis.fetch = origFetch;

console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
