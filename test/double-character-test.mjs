// double-character-test.mjs — 双角色独立性格/记忆验证（仿 test/personality-test.mjs 风格）
// 验证：
//  1. 两个 PersonalityEngine 实例（不同 characterId）性格种子独立
//  2. 两个 MemoryService 实例（不同 characterId）记忆独立
//  3. 旧 key 首次访问迁移到默认角色
//  4. 切回旧角色时记忆/性格不会回写到另一角色

const kv = new Map();
globalThis.localStorage = {
  getItem: (k) => (kv.has(k) ? kv.get(k) : null),
  setItem: (k, v) => kv.set(k, String(v)),
  removeItem: (k) => kv.delete(k),
};

const assert = (name, cond, detail) => {
  if (!cond) { console.error('FAIL:', name, detail || ''); process.exit(1); }
  console.log('PASS:', name, detail ? `(${detail})` : '');
};
const reset = () => kv.clear();

const { default: PersonalityEngine, LEGACY_STORAGE_KEY } = await import('../src/core/personality.js');
const { default: MemoryService } = await import('../src/core/memory.js');
const { default: LLMService } = await import('../src/core/llm.js');

// ============================================================
// 1. PersonalityEngine 独立性格种子
// ============================================================
console.log('--- 1. 双角色独立性格 ---');
reset();
const p1 = new PersonalityEngine('handsome');
const p2 = new PersonalityEngine('beauty');
const t1 = p1.getTraits();
const t2 = p2.getTraits();
assert('帅哥角色有名字/物种', typeof t1.name === 'string' && t1.name.length > 0);
assert('美女角色有名字/物种', typeof t2.name === 'string' && t2.name.length > 0);
assert('双角色性格种子不同（信息熵）', JSON.stringify(t1) !== JSON.stringify(t2));
assert('双角色使用不同 localStorage key',
  kv.has('pet-personality-handsome') && kv.has('pet-personality-beauty'),
  `keys: ${[...kv.keys()].filter(k => k.includes('personality')).join(', ')}`);

// 应用事件：只影响对应角色
const before1 = { ...p1.getTraits() };
const before2 = { ...p2.getTraits() };
await p1.applyEvent('owner_praise', 5); // 大权重漂移
const t1After = p1.getTraits();
const t2After = p2.getTraits();
assert('帅哥性格 lively 上升（受 praise 影响）', t1After.lively > before1.lively);
assert('美女性格完全不变', JSON.stringify(t2After) === JSON.stringify(before2),
  `美女前后一致: ${JSON.stringify(t2After) === JSON.stringify(before2)}`);

// eventCounts 独立
assert('帅哥 eventCounts.praise=1', p1.getEventCounts().owner_praise === 1);
assert('美女 eventCounts 空', Object.keys(p2.getEventCounts()).length === 0);

// ============================================================
// 2. MemoryService 独立存储
// ============================================================
console.log('\n--- 2. 双角色独立记忆 ---');
reset();
const llm = new LLMService({ model: 'mock' });
const m1 = new MemoryService({ llm, characterId: 'handsome' });
const m2 = new MemoryService({ llm, characterId: 'beauty' });

await m1.add('short', '帅哥的专属记忆A');
await m1.add('long', '帅哥喜欢喝美式咖啡', { source: 'user' });
await m1.add('emotional', '帅哥收到大礼物', { score: 10 });

await m2.add('short', '美女的专属记忆B');
await m2.add('emotional', '美女的礼物小确幸', { score: 5 });

const s1 = m1.stats();
const s2 = m2.stats();
assert('帅哥记忆条数正确', s1.short === 1 && s1.long === 1 && s1.emotional === 1,
  `S${s1.short}/L${s1.long}/E${s1.emotional}`);
assert('美女记忆条数正确', s2.short === 1 && s2.long === 0 && s2.emotional === 1,
  `S${s2.short}/L${s2.long}/E${s2.emotional}`);

// 用 characterId 重新加载，验证持久化
const m1Reloaded = new MemoryService({ llm, characterId: 'handsome' });
const m2Reloaded = new MemoryService({ llm, characterId: 'beauty' });
const sr1 = m1Reloaded.stats();
const sr2 = m2Reloaded.stats();
assert('帅哥重载记忆仍为 1/1/1', sr1.short === 1 && sr1.long === 1 && sr1.emotional === 1);
assert('美女重载记忆仍为 1/0/1', sr2.short === 1 && sr2.long === 0 && sr2.emotional === 1);

// 跨角色检索：帅哥查"咖啡"应只命中自己
const searchHandsome = await m1.search('咖啡');
const searchBeauty = await m2.search('咖啡');
assert('帅哥检索"咖啡"命中', searchHandsome.length > 0);
assert('美女检索"咖啡"无命中（隔离）', searchBeauty.length === 0);

// 跨角色检索"礼物"
const searchGiftH = await m1.search('礼物');
const searchGiftB = await m2.search('礼物');
assert('帅哥检索"礼物"有命中', searchGiftH.length > 0);
assert('美女检索"礼物"有命中（自己的礼物记忆）', searchGiftB.length > 0);

// ============================================================
// 3. 旧 key 迁移到默认角色
// ============================================================
console.log('\n--- 3. 旧 key 迁移 ---');
reset();
// 模拟老用户：有旧 key，无新 key
kv.set(LEGACY_STORAGE_KEY, JSON.stringify({
  seed: 'legacy-seed-xyz',
  name: '老宠物',
  species: '旧仓鼠',
  desc: '天生的活泼型',
  traits: { lively: 0.5, calm: 0.5, clingy: 0.5, independent: 0.5, outgoing: 0.5, sensitive: 0.5, playful: 0.5 },
  eventCounts: { owner_praise: 7 },
  ownerProfile: { activeHours: [], chatStyle: '积累中', catchPhrases: [], moodPattern: '数据积累中', updatedAt: null,
    stats: { totalMessages: 0, hourHist: new Array(24).fill(0), totalChars: 0, sentences: 0, exclaims: 0, questions: 0, wordFreq: {}, sceneCounts: {} } },
  createdAt: Date.now() - 100000,
  updatedAt: Date.now() - 100000,
}));

// 加载默认角色（handsome）应触发迁移
const pMigrated = new PersonalityEngine('handsome');
assert('旧 key 迁移后 load 老宠物姓名', pMigrated.getTraits().name === '老宠物',
  `name=${pMigrated.getTraits().name}`);
assert('旧 key 迁移后 eventCounts 保留', pMigrated.getEventCounts().owner_praise === 7,
  `praise=${pMigrated.getEventCounts().owner_praise}`);
assert('旧 key 迁移后旧 key 已清除', !kv.has(LEGACY_STORAGE_KEY));
assert('旧 key 迁移后新 key 存在', kv.has('pet-personality-handsome'));

// 迁移后美女角色应为全新种子（不应继承旧数据）
const pFresh = new PersonalityEngine('beauty');
assert('美女角色不应被旧数据污染', pFresh.getTraits().name !== '老宠物');

// 反复加载默认角色不应再触发迁移
const oldHasLegacy = kv.has(LEGACY_STORAGE_KEY);
const pMigrated2 = new PersonalityEngine('handsome');
assert('反复加载默认角色无副作用',
  JSON.stringify(pMigrated2.getTraits()) === JSON.stringify(pMigrated.getTraits()));

// ============================================================
// 4. 跨角色写入互不影响
// ============================================================
console.log('\n--- 4. 跨角色写入隔离 ---');
reset();
const m3 = new MemoryService({ llm, characterId: 'handsome' });
const m4 = new MemoryService({ llm, characterId: 'beauty' });
await m3.add('short', '帅哥记忆1');
await m3.add('short', '帅哥记忆2');
await m4.add('short', '美女记忆1');
// 帅哥加记忆不影响美女
const s3 = m3.stats();
const s4 = m4.stats();
assert('帅哥有 2 条', s3.short === 2);
assert('美女有 1 条', s4.short === 1);
// 清空帅哥记忆不影响美女
await m3.add('short', '帅哥第三条触发裁剪'); // 短期 50 才裁剪，这里不裁
// 通过多次写入测 FIFO 裁剪
for (let i = 0; i < 60; i++) await m3.add('short', '帅哥批量' + i);
const s3After = m3.stats();
assert('帅哥裁剪至 50', s3After.short === 50);
const s4After = m4.stats();
assert('美女裁剪不受影响（仍 1 条）', s4After.short === 1);

// ============================================================
// 5. characterId 标识正确
// ============================================================
console.log('\n--- 5. characterId 标识 ---');
reset();
const p5 = new PersonalityEngine('handsome');
const p6 = new PersonalityEngine('beauty');
assert('帅哥实例 characterId=handsome', p5.characterId === 'handsome');
assert('美女实例 characterId=beauty', p6.characterId === 'beauty');
assert('帅哥 STORAGE_KEY 正确', p5.STORAGE_KEY === 'pet-personality-handsome');
assert('美女 STORAGE_KEY 正确', p6.STORAGE_KEY === 'pet-personality-beauty');

const m5 = new MemoryService({ llm, characterId: 'handsome' });
const m6 = new MemoryService({ llm, characterId: 'beauty' });
assert('帅哥 memory STORAGE_KEY 正确', m5.STORAGE_KEY === 'pet-memory-handsome');
assert('美女 memory STORAGE_KEY 正确', m6.STORAGE_KEY === 'pet-memory-beauty');

console.log('\n✅ ALL DOUBLE-CHARACTER TESTS PASSED');
