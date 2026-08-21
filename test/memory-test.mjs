// memory.js 自动化验证脚本（node 运行，含 localStorage shim）
const kv = new Map();
globalThis.localStorage = {
  getItem: (k) => (kv.has(k) ? kv.get(k) : null),
  setItem: (k, v) => kv.set(k, String(v)),
  removeItem: (k) => kv.delete(k),
};

const assert = (name, cond) => {
  if (!cond) { console.error('FAIL:', name); process.exit(1); }
  console.log('PASS:', name);
};
const reset = () => kv.clear(); // 用例间隔离，避免共享localStorage污染

const { default: MemoryService } = await import('../src/core/memory.js');
const { default: LLMService } = await import('../src/core/llm.js');

const mem = new MemoryService({ llm: new LLMService({ model: 'mock' }) });
const now = Date.now();

// 1. add 基本类型
await mem.add('short', '主人说今晚要早点睡');
await mem.add('long', '主人喜欢喝冰美式，每天下午一杯', { source: 'user' });
await mem.add('emotional', '收到大礼物嘉年华，破纪录！', { score: 100 });
let st = mem.stats();
assert('add 三类写入', st.short === 1 && st.long === 1 && st.emotional === 1);

// 2. 非法参数
let threw = false;
try { await mem.add('bad', 'x'); } catch { threw = true; }
assert('非法type抛错', threw);
threw = false;
try { await mem.add('short', ''); } catch { threw = true; }
assert('空content抛错', threw);

// 3. short FIFO 裁剪到50
for (let i = 0; i < 60; i++) await mem.add('short', '短期记忆编号' + i);
st = mem.stats();
assert('short FIFO裁剪至50 (实际' + st.short + ')', st.short === 50);
const oldest = mem._store.short[mem._store.short.length - 1];
assert('最旧的被裁掉', oldest.content.includes('编号10'));

// 4. emotional 上限200，低分先淘汰
for (let i = 0; i < 205; i++) {
  await mem.add('emotional', '普通情感事件' + i, { score: (i % 5) + 1 }); // 分1-5
}
st = mem.stats();
assert('emotional裁剪至200 (实际' + st.emotional + ')', st.emotional === 200);
const s1count = mem._store.emotional.filter((e) => e.meta.score === 1).length;
const s2up = mem._store.emotional.filter((e) => e.meta.score >= 2).length;
const hasHighGift = mem._store.emotional.some((e) => e.content.includes('嘉年华'));
// 206条裁到200：淘汰6条，全部来自score=1组（41→35）；score>=2的164条与高分礼物全保留
assert('低分先淘汰（score=1剩35条，实际' + s1count + '）', s1count === 35);
assert('score>=2全保留（含礼物共165条，实际' + s2up + '）', s2up === 165);
assert('高分礼物保留', hasHighGift);

// 5. search 相关性排序
const results = await mem.search('冰美式 咖啡', 5);
assert('search命中相关记忆', results.length >= 1 && results[0].content.includes('冰美式'));
assert('search返回relevance', typeof results[0].relevance === 'number' && results[0].relevance > 0);
const none = await mem.search('完全不存在的词xyzq', 5);
assert('无匹配返回空', none.length === 0);

// 5b. 时间衰减：同内容新旧两条，新的排前
reset();
const memFresh = new MemoryService();
await memFresh.add('long', '主人在学吉他', { timestamp: now });
await memFresh.add('long', '主人在学吉他', { timestamp: now - 30 * 86400000 });
const r2 = await memFresh.search('吉他', 2);
assert('时间衰减排序（新记忆优先）', r2[0].meta.timestamp === now && r2[0].relevance > r2[1].relevance);

// 6. getContext：emotional高分优先
reset();
const memCtx = new MemoryService();
await memCtx.add('emotional', '低分事件', { score: 1 });
await memCtx.add('emotional', '高分事件：连续开播100天', { score: 100 });
await memCtx.add('emotional', '中分事件', { score: 50 });
for (let i = 0; i < 8; i++) await memCtx.add('short', '近期对话' + i);
await memCtx.add('long', '长期事实：主人养猫');
const ctx = await memCtx.getContext(10);
assert('getContext返回<=10条且非空', ctx.length <= 10 && ctx.length > 0);
const emoItems = ctx.filter((c) => c.type === 'emotional');
assert('emotional按score降序', emoItems.length === 3 && emoItems[0].content.includes('100天'));
assert('条目带type字段', ctx.every((c) => ['short', 'long', 'emotional'].includes(c.type)));

// 7. summarize：阈值不触发
const s1 = await memCtx.summarize();
assert('long未超阈值不压缩', s1.summarized === false);

// 8. summarize：灌45条long触发压缩（mock LLM路径）
for (let i = 0; i < 45; i++) await memCtx.add('long', '主人长期习惯记录' + i);
assert('灌入后long=46', memCtx.stats().long === 46);
const s2 = await memCtx.summarize();
assert('触发压缩 summarized=true', s2.summarized === true);
assert('压缩15条', s2.compressed === 15);
assert('压缩后long=32 (46-15+1)', memCtx.stats().long === 32);
assert('摘要条目在池顶', memCtx._store.long[0].meta.summarized === true && memCtx._store.long[0].meta.sourceCount === 15);
assert('摘要非空', typeof s2.summary === 'string' && s2.summary.length > 0);

// 9. 持久化：新实例读取同一localStorage
const memRe = new MemoryService();
assert('新实例读取持久化数据', memRe.stats().short === memCtx.stats().short && memRe._store.long[0].content === memCtx._store.long[0].content);

// ---------- 10. T4验收minor修复回归 ----------

// [T4-#1] search负数/NaN limit
reset();
const memMinor = new MemoryService();
await memMinor.add('short', '主人喜欢喝冰美式');
assert('search负数limit返回0条', (await memMinor.search('冰美式', -1)).length === 0);
assert('search NaN limit返回0条', (await memMinor.search('冰美式', NaN)).length === 0);
assert('search正常limit仍有效', (await memMinor.search('冰美式', 5)).length === 1);

// [T4-#2] getContext名额回填：long/emotional空时名额给short，总数尽量达到maxItems
reset();
const memFill = new MemoryService();
for (let i = 0; i < 20; i++) await memFill.add('short', '近期对话' + i);
const ctxFill = await memFill.getContext(10);
assert('long/emo空池时short回填至10条 (实际' + ctxFill.length + ')', ctxFill.length === 10);
assert('回填后全部为short', ctxFill.every((c) => c.type === 'short'));

// emotional与long都满时short空 → 名额回填给long/emo
reset();
const memFill2 = new MemoryService();
for (let i = 0; i < 10; i++) await memFill2.add('long', '长期事实' + i);
for (let i = 0; i < 10; i++) await memFill2.add('emotional', '情感事件' + i, { score: i });
const ctxFill2 = await memFill2.getContext(10);
assert('short空池时long/emo回填至10条 (实际' + ctxFill2.length + ')', ctxFill2.length === 10);

// getContext(0)与负数返回空数组
reset();
const memZero = new MemoryService();
await memZero.add('short', 'x');
assert('getContext(0)返回空数组', (await memZero.getContext(0)).length === 0);
assert('getContext(-5)返回空数组', (await memZero.getContext(-5)).length === 0);
assert('getContext(NaN)返回空数组', (await memZero.getContext(NaN)).length === 0);

// 全部池空 → 空数组
reset();
const memEmpty = new MemoryService();
assert('全部池空返回空数组', (await memEmpty.getContext(10)).length === 0);

// [T4-#4] _makeSummary失败判定：LLM返回空/过短/错误串 → 本地兜底
reset();
const fakeLlm = { chat: async () => '' }; // 空回复
const memSum = new MemoryService({ llm: fakeLlm });
for (let i = 0; i < 35; i++) await memSum.add('long', '长期记录' + i);
let rSum = await memSum.summarize();
assert('LLM空回复→本地兜底[摘要]前缀', rSum.summarized === true && rSum.summary.startsWith('[摘要]'));

reset();
const fakeLlm2 = { chat: async () => '好的。' }; // 过短回复(<10字)
const memSum2 = new MemoryService({ llm: fakeLlm2 });
for (let i = 0; i < 35; i++) await memSum2.add('long', '长期记录' + i);
rSum = await memSum2.summarize();
assert('LLM过短回复→本地兜底', rSum.summary.startsWith('[摘要]'));

reset();
const fakeLlm3 = { chat: async () => '（网络连接失败：请检查网络，以及 baseURL 是否正确可达）' }; // 错误串
const memSum3 = new MemoryService({ llm: fakeLlm3 });
for (let i = 0; i < 35; i++) await memSum3.add('long', '长期记录' + i);
rSum = await memSum3.summarize();
assert('LLM错误关键词串→本地兜底', rSum.summary.startsWith('[摘要]'));

reset();
const fakeLlm4 = { chat: async () => '主人近期养成了每天记录长期事项的习惯，涉及工作安排与生活偏好等多方面内容。' }; // 正常长回复
const memSum4 = new MemoryService({ llm: fakeLlm4 });
for (let i = 0; i < 35; i++) await memSum4.add('long', '长期记录' + i);
rSum = await memSum4.summarize();
assert('LLM正常回复→采用LLM摘要（非兜底）', rSum.summarized === true && !rSum.summary.startsWith('[摘要]') && rSum.summary.includes('主人'));

// [T4-#3] meta缺失容错（可选链）：无meta的条目不崩溃
reset();
const memNoMeta = new MemoryService();
memNoMeta._store.short.push({ id: 'x1', content: '主人喜欢喝冰美式' }); // 无meta字段
const rNoMeta = await memNoMeta.search('冰美式', 5);
assert('无meta条目search不崩溃且可命中', rNoMeta.length === 1);

console.log('ALL TESTS PASSED');
