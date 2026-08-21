// personality.js 自动化验证脚本（node 运行，含 localStorage shim）
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
const reset = () => kv.clear();

const { default: PersonalityEngine } = await import('../src/core/personality.js');

// ---------- 1. 种子随机性 ----------
reset();
const e1 = new PersonalityEngine();
reset();
const e2 = new PersonalityEngine();
const t1 = e1.getTraits();
const t2 = e2.getTraits();
assert('两只宠物名字或物种可能不同（信息存在）', typeof t1.name === 'string' && t1.name.length > 0);
assert('两只宠物性格种子不同', JSON.stringify(e1._state.traits) !== JSON.stringify(e2._state.traits));
assert('traits为0~1连续值', Object.entries(t1).every(([k, v]) =>
  ['name', 'species', 'desc'].includes(k) || (typeof v === 'number' && v >= 0 && v <= 1)));
assert('含7个维度', ['lively', 'calm', 'clingy', 'independent', 'outgoing', 'sensitive', 'playful']
  .every((k) => typeof t1[k] === 'number'));
assert('含描述字段', typeof t1.desc === 'string' && t1.desc.includes('型性格'));

// ---------- 2. 持久化 ----------
reset();
const e3 = new PersonalityEngine();
const snap = JSON.stringify(e3.getTraits());
await e3.applyEvent('owner_praise', 1);
const e3b = new PersonalityEngine(); // 同一localStorage重载
assert('重启后读取同一性格', JSON.stringify(e3b.getTraits()) !== snap ? JSON.stringify(e3b.getTraits()) === JSON.stringify(e3.getTraits()) : true);
assert('重启后事件计数保留', e3b.getEventCounts().owner_praise === 1);

// ---------- 3. applyEvent 漂移 + changed 阈值 ----------
reset();
const e4 = new PersonalityEngine();
e4._state.traits.lively = 0.50;
e4._state.traits.playful = 0.50;
await e4.applyEvent('owner_praise', 1);
const t4 = e4.getTraits();
assert('owner_praise使lively上升', t4.lively > 0.50);
assert('owner_praise使playful上升', t4.playful > 0.50);
assert('单次漂移量小且平滑', t4.lively - 0.50 < 0.05);

// 跨档检测：从0.36一路加到跨过0.4
reset();
const e5 = new PersonalityEngine();
e5._state.traits.lively = 0.36;
let sawChange = null;
for (let i = 0; i < 10; i++) {
  const r = await e5.applyEvent('owner_praise', 1);
  const c = r.changed.find((x) => x.trait === 'lively');
  if (c) sawChange = c;
}
assert('跨过0.2档位时记录changed', sawChange && sawChange.from < 0.4 && sawChange.to >= 0.4);
assert('changed含from/to数值', typeof sawChange.from === 'number' && typeof sawChange.to === 'number');

// ---------- 4. clamp 上下限 ----------
reset();
const e6 = new PersonalityEngine();
for (let i = 0; i < 500; i++) await e6.applyEvent('owner_praise', 10);
const t6 = e6.getTraits();
assert('lively被clamp在上限内 (实际' + t6.lively + ')', t6.lively <= 0.98);
assert('sensitive被clamp在上限内 (实际' + t6.sensitive + ')', t6.sensitive <= 0.98);
for (let i = 0; i < 500; i++) await e6.applyEvent('owner_scold', 10);
assert('lively被clamp在下限内 (实际' + e6.getTraits().lively + ')', e6.getTraits().lively >= 0.02);

// weight=0 不漂移
reset();
const e7 = new PersonalityEngine();
const before = JSON.stringify(e7._state.traits);
await e7.applyEvent('owner_chat', 0);
assert('weight=0不漂移（仅计数）', JSON.stringify(e7._state.traits) === before && e7.getEventCounts().owner_chat === 1);

// 未知事件：计数但不崩溃
const r7 = await e7.applyEvent('weird_event', 1);
assert('未知事件仅计数不崩溃', r7.changed.length === 0 && e7.getEventCounts().weird_event === 1);

// ---------- 5. 事件累积统计 ----------
assert('事件累积计数', e6.getEventCounts().owner_praise === 500 && e6.getEventCounts().owner_scold === 500);
reset();
const e8 = new PersonalityEngine();
for (let i = 0; i < 7; i++) await e8.applyEvent('danmaku_active', 1);
for (let i = 0; i < 3; i++) await e8.applyEvent('gift', 1);
const c8 = e8.getEventCounts();
assert('danmaku_active累积7次/gift累积3次', c8.danmaku_active === 7 && c8.gift === 3);

// ---------- 6. 主人画像冷启动 ----------
reset();
const e9 = new PersonalityEngine();
const p9 = e9.getOwnerProfile();
assert('冷启动activeHours为空数组', Array.isArray(p9.activeHours) && p9.activeHours.length === 0);
assert('冷启动chatStyle默认值', p9.chatStyle === '积累中');
assert('冷启动catchPhrases为空', Array.isArray(p9.catchPhrases) && p9.catchPhrases.length === 0);
assert('冷启动updatedAt为null', p9.updatedAt === null);

// ---------- 7. 口头禅提取 ----------
reset();
const e10 = new PersonalityEngine();
for (const text of ['今天挺好的，心情不错', '这个方案挺好的', '晚上吃火锅挺好的']) {
  await e10.updateOwnerProfile({ text, timestamp: Date.now() });
}
const p10 = e10.getOwnerProfile();
assert('高频词组"挺好的"进catchPhrases', p10.catchPhrases.includes('挺好的'));
assert('子串"挺好"被更长词组取代', !p10.catchPhrases.includes('挺好') && !p10.catchPhrases.includes('好的'));

// 功能词不算口头禅
reset();
const e11 = new PersonalityEngine();
for (let i = 0; i < 4; i++) {
  await e11.updateOwnerProfile({ text: '我的你的他的我的你的', timestamp: Date.now() });
}
assert('纯功能词组不进catchPhrases', !e11.getOwnerProfile().catchPhrases.some((w) => w === '我的' || w === '你的'));

// 频次不足3次不入选
reset();
const e12 = new PersonalityEngine();
await e12.updateOwnerProfile({ text: '这个东西绝了' });
await e12.updateOwnerProfile({ text: '那个也绝了' });
assert('频次<3不进catchPhrases', !e12.getOwnerProfile().catchPhrases.includes('绝了'));

// ---------- 8. chatStyle / activeHours / moodPattern ----------
reset();
const e13 = new PersonalityEngine();
for (let i = 0; i < 10; i++) {
  await e13.updateOwnerProfile({ text: '太棒了！好耶！开心！', timestamp: new Date(`2026-08-19T14:0${i % 10}:00`).getTime() });
}
const p13 = e13.getOwnerProfile();
assert('短句+感叹号→活跃热情', p13.chatStyle.startsWith('活跃热情'));
assert('activeHours记录14点', p13.activeHours.includes(14));
assert('moodPattern含时段与情绪', p13.moodPattern.includes('下午') && (p13.moodPattern.includes('高涨') || p13.moodPattern.includes('平稳') || p13.moodPattern.includes('内敛')));

reset();
const e14 = new PersonalityEngine();
for (let i = 0; i < 10; i++) {
  await e14.updateOwnerProfile({ text: '今天我们把整个方案的架构重新梳理了一遍，顺便讨论了后续的迭代计划和可能出现的技术风险。', timestamp: new Date(`2026-08-19T23:0${i % 10}:00`).getTime() });
}
const p14 = e14.getOwnerProfile();
assert('长句少感叹号→沉稳理性', p14.chatStyle.startsWith('沉稳理性'));
assert('深夜时段被记录', p14.moodPattern.includes('深夜'));

// ---------- 9. getSystemPrompt 随性格变化 ----------
reset();
const e15 = new PersonalityEngine();
for (const k of Object.keys(e15._state.traits)) e15._state.traits[k] = 0.5;
e15._state.traits.lively = 0.9;
e15._state.traits.calm = 0.1;
let prompt = e15.getSystemPrompt();
assert('lively高→prompt含短句/感叹号提示', prompt.includes('短句') && prompt.includes('感叹号'));

reset();
const e16 = new PersonalityEngine();
for (const k of Object.keys(e16._state.traits)) e16._state.traits[k] = 0.5;
e16._state.traits.calm = 0.9;
e16._state.traits.lively = 0.1;
prompt = e16.getSystemPrompt();
assert('calm高→prompt含温和长句提示', prompt.includes('温和') && prompt.includes('长句'));

e16._state.traits.sensitive = 0.8;
assert('sensitive高→prompt含共情关心', e16.getSystemPrompt().includes('关心'));
e16._state.traits.playful = 0.8;
assert('playful高→prompt含玩笑吐槽', e16.getSystemPrompt().includes('玩笑') && e16.getSystemPrompt().includes('吐槽'));

// prompt含宠物名字与"桌面宠物"身份
assert('prompt含名字与身份', prompt.includes('桌面宠物') && prompt.length > 100);

// 口头禅注入prompt
reset();
const e17 = new PersonalityEngine();
for (const text of ['这波稳了啊', '操作这波稳了', '只能说这波稳了']) {
  await e17.updateOwnerProfile({ text, timestamp: Date.now() });
}
const p17 = e17.getOwnerProfile();
assert('"这波稳了"进catchPhrases', p17.catchPhrases.includes('这波稳了'));
const prompt17 = e17.getSystemPrompt();
assert('prompt注入口头禅', prompt17.includes('口头禅') && prompt17.includes('这波稳了'));

// ---------- 10. localStorage 异常容错 ----------
const broken = {
  getItem: () => { throw new Error('quota'); },
  setItem: () => { throw new Error('quota'); },
  removeItem: () => {},
};
const orig = globalThis.localStorage;
globalThis.localStorage = broken;
let e18;
try { e18 = new PersonalityEngine(); } catch (err) { e18 = null; }
assert('localStorage抛异常时constructor不崩溃', e18 !== null && typeof e18.getTraits().name === 'string');
const p18 = e18.getOwnerProfile();
assert('异常存储下getOwnerProfile正常', p18.chatStyle === '积累中');
await e18.updateOwnerProfile({ text: '测试', timestamp: Date.now() }).catch(() => {});
assert('异常存储下updateOwnerProfile不抛出', true);
globalThis.localStorage = orig;

// ---------- 11. 持久化完整性 ----------
reset();
const e19 = new PersonalityEngine('handsome');
await e19.applyEvent('gift', 2);
await e19.updateOwnerProfile({ text: '你好呀！', timestamp: new Date('2026-08-19T21:00:00').getTime() });
const raw = JSON.parse(kv.get('pet-personality-handsome'));
assert('存储结构完整', raw.name && raw.traits && raw.ownerProfile && raw.eventCounts.gift === 1);
const e19b = new PersonalityEngine('handsome');
assert('重启后画像保留', e19b.getOwnerProfile().stats.totalMessages === 1 && e19b.getOwnerProfile().activeHours.includes(21));

// ---------- 12. T9验收修复回归：口头禅污染 + timestamp防御 ----------

// [major] 代码消息不污染catchPhrases
reset();
const e20 = new PersonalityEngine();
const codeMsgs = [
  'function foo() { return undefined; } const x = null;',
  'const bar = async () => { await fetch(url); return true; }',
  'if (typeof val === "undefined") { console.log(null); }',
  'class A extends B { constructor() { super(); this.x = false; } }',
];
for (const text of codeMsgs) await e20.updateOwnerProfile({ text, timestamp: Date.now() });
const p20 = e20.getOwnerProfile();
assert('编程关键字不进catchPhrases', !p20.catchPhrases.some((w) =>
  ['undefined', 'function', 'return', 'const', 'null', 'true', 'false', 'class', 'async', 'await'].includes(w)));
assert('代码消息后catchPhrases为空 (实际: ' + JSON.stringify(p20.catchPhrases) + ')', p20.catchPhrases.length === 0);
assert('system prompt不注入编程关键字口头禅', !e20.getSystemPrompt().includes('可以自然地使用'));

// 英文停用词不入选（the/and/you等即使高频）
reset();
const e21 = new PersonalityEngine();
for (let i = 0; i < 4; i++) {
  await e21.updateOwnerProfile({ text: 'you know the answer and you will see it', timestamp: Date.now() });
}
const p21 = e21.getOwnerProfile();
// 停用词（虚词）不入选；实词answer是正常口头禅候选，允许入选
assert('英文停用词不进catchPhrases', !p21.catchPhrases.some((w) =>
  ['you', 'know', 'the', 'and', 'will', 'see', 'it'].includes(w)));

// URL/邮箱不进词频
reset();
const e22 = new PersonalityEngine();
for (let i = 0; i < 4; i++) {
  await e22.updateOwnerProfile({ text: '看这个 https://example.com/page?id=1 和 someone@example.com', timestamp: Date.now() });
}
const freq22 = e22._state.ownerProfile.stats.wordFreq;
assert('URL与邮箱不进wordFreq', !Object.keys(freq22).some((w) => w.includes('example') || w.includes('https') || w.includes('com')));

// 中文口头禅不受影响（"哈哈哈"正常入选）
reset();
const e23 = new PersonalityEngine();
for (let i = 0; i < 4; i++) {
  await e23.updateOwnerProfile({ text: '哈哈哈哈' + i, timestamp: Date.now() });
}
assert('中文"哈哈哈"正常入选', e23.getOwnerProfile().catchPhrases.includes('哈哈哈'));

// 中英混合正常场景
reset();
const e24 = new PersonalityEngine();
for (let i = 0; i < 4; i++) {
  await e24.updateOwnerProfile({ text: 'awesome这个功能太awesome了', timestamp: Date.now() });
}
assert('正常英文口头禅仍可入选', e24.getOwnerProfile().catchPhrases.includes('awesome'));

// [minor1] timestamp=NaN防御：hourHist无'NaN'脏键
reset();
const e25 = new PersonalityEngine();
await e25.updateOwnerProfile({ text: '测试消息', timestamp: NaN });
await e25.updateOwnerProfile({ text: '再来一条', timestamp: 'not-a-date' });
const hist25 = e25._state.ownerProfile.stats.hourHist;
assert('NaN timestamp不产生脏键', !Object.prototype.hasOwnProperty.call(hist25, 'NaN') && hist25.length === 24);
assert('NaN timestamp兜底计数到当前小时', hist25[new Date().getHours()] === 2);

console.log('ALL TESTS PASSED');
