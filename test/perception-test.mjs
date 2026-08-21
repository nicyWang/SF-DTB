// perception.js 自动化验证脚本（node 运行，stub screenAPI/llm/PetEvents/memory/storage/clock）
// 运行：node test/perception-test.mjs

// ---------- 测试基建 ----------
let pass = 0, fail = 0;
const assert = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.error('FAIL:', name, extra); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 可控时钟
let clockMs = new Date('2026-08-19T10:00:00').getTime();
const now = () => clockMs;

// stub事件总线
class Bus {
  constructor() { this.handlers = new Map(); this.emitted = []; }
  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, []);
    this.handlers.get(ev).push(fn);
  }
  emit(ev, ...args) {
    this.emitted.push({ ev, args });
    (this.handlers.get(ev) || []).forEach((f) => { try { f(...args); } catch (e) { console.error(e); } });
  }
  sceneChanges() { return this.emitted.filter((e) => e.ev === 'scene:change').map((e) => e.args[0]); }
}

// stub localStorage
const makeStorage = () => {
  const kv = new Map();
  return {
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => kv.set(k, String(v)),
    removeItem: (k) => kv.delete(k),
  };
};

// stub llm：可编程vision返回（队列或函数）+ 调用计数
const makeLLM = (reply) => {
  const llm = {
    config: { model: 'gpt-4o-mini' },
    visionCalls: 0,
    lastPrompt: null,
    async vision(b64, prompt) {
      this.visionCalls++;
      this.lastPrompt = prompt;
      return typeof reply === 'function' ? reply(this.visionCalls) : reply;
    },
  };
  return llm;
};

// stub memory
const makeMemory = () => {
  const records = [];
  return {
    records,
    async add(type, content, meta) { records.push({ type, content, meta }); return { id: 'x' }; },
  };
};

// stub screenAPI：返回PNG魔数开头的假base64
const makeScreen = () => ({ getScreenshot: async () => 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(100) });

const { default: PerceptionService } = await import('../src/core/perception.js');

const INT = 40;              // 测试用小间隔
const WAIT = INT + 60;       // 等一个tick的余量

// ---------- 1. 构造校验 ----------
let threw = false;
try { new PerceptionService({}); } catch { threw = true; }
assert('缺llm抛TypeError', threw);

// ---------- 2. start/stop 状态机 + interval循环 ----------
{
  const bus = new Bus();
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: '在写代码' }));
  const p = new PerceptionService({ llm, events: bus, screenAPI: makeScreen(), interval: INT, now });

  let st = p.getStatus();
  assert('初始未运行', st.enabled === false && st.running === false && st.paused === false);

  p.start();
  st = p.getStatus();
  assert('start后running', st.enabled === true && st.running === true);
  await sleep(INT * 3);
  st = p.getStatus();
  assert('tick后lastCheckAt/lastScene更新', st.lastCheckAt === clockMs && st.lastScene === 'work', JSON.stringify(st));
  assert('interval循环触发(>=3次vision)', llm.visionCalls >= 3, `实际${llm.visionCalls}`);
  assert('prompt要求返回JSON含scene', /JSON/.test(llm.lastPrompt) && /scene/.test(llm.lastPrompt));
  assert('tick时发送截图给vision', bus.sceneChanges().length === 1);

  p.stop();
  const callsAfterStop = llm.visionCalls;
  await sleep(INT * 3);
  assert('stop后循环停止', llm.visionCalls === callsAfterStop);
  st = p.getStatus();
  assert('stop后状态', st.enabled === false && st.running === false);
}

// ---------- 3. 场景变化emit + 同场景不重复 + 记忆节流 ----------
{
  const bus = new Bus();
  const mem = makeMemory();
  // 可变当前回复（比队列确定：一个WAIT窗口内可能跑多个tick）
  let cur = { scene: 'work', confidence: 0.9, detail: '在写代码' };
  const llm = makeLLM(() => JSON.stringify(cur));
  const p = new PerceptionService({ llm, memory: mem, events: bus, screenAPI: makeScreen(), interval: INT, now });
  p.start();
  await sleep(WAIT); // 若干tick全部work
  assert('首次场景emit work', bus.sceneChanges().length === 1 && bus.sceneChanges()[0].scene === 'work');
  assert('记忆写入long类型含场景中文', mem.records.length === 1 && mem.records[0].type === 'long' && mem.records[0].content.includes('工作'), mem.records[0]?.content);

  await sleep(WAIT); // work同场景持续
  assert('同场景不重复emit', bus.sceneChanges().length === 1);
  assert('同场景10分钟内不重复记录', mem.records.length === 1);

  cur = { scene: 'fun', confidence: 0.8, detail: '在看视频' };
  await sleep(WAIT); // fun → emit + 记忆
  const ch = bus.sceneChanges();
  assert('场景变化emit fun(含confidence/detail)', ch.length === 2 && ch[1].scene === 'fun' && ch[1].confidence === 0.8 && ch[1].detail === '在看视频', JSON.stringify(ch));
  assert('新场景记录一条', mem.records.length === 2 && mem.records[1].content.includes('娱乐'));

  clockMs += 5 * 60 * 1000;
  await sleep(WAIT); // fun持续（fake clock +5分钟）
  assert('fun持续5分钟不重复记录', mem.records.length === 2);
  clockMs += 6 * 60 * 1000;
  await sleep(WAIT); // fake clock累计11分钟 → 再记录
  assert('同场景超过10分钟再次记录', mem.records.length === 3 && mem.records[2].content.includes('娱乐'), `实际${mem.records.length}`);
  assert('记录与emit解耦(仍2次change)', bus.sceneChanges().length === 2);
  p.stop();
}

// ---------- 4. 暂停/恢复（perception:paused） ----------
{
  const bus = new Bus();
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const p = new PerceptionService({ llm, events: bus, screenAPI: makeScreen(), interval: INT, now });
  p.start();
  await sleep(WAIT);
  assert('暂停前有tick', llm.visionCalls >= 1);

  bus.emit('perception:paused', { paused: true });
  const st = p.getStatus();
  assert('paused状态(enabled仍true)', st.running === false && st.paused === true && st.enabled === true);
  const callsAtPause = llm.visionCalls;
  const changesAtPause = bus.sceneChanges().length;
  await sleep(INT * 3);
  assert('暂停后tick不发事件不调vision', llm.visionCalls === callsAtPause && bus.sceneChanges().length === changesAtPause);

  bus.emit('perception:paused', { paused: false });
  await sleep(WAIT);
  assert('resume后恢复循环', llm.visionCalls > callsAtPause);
  p.stop();
}

// ---------- 5. 深夜检测（优先于LLM，不调vision）+ 节流 ----------
{
  const bus = new Bus();
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const mem = makeMemory();
  clockMs = new Date('2026-08-19T02:30:00').getTime();
  const p = new PerceptionService({ llm, memory: mem, events: bus, screenAPI: makeScreen(), interval: INT, now });
  p.start();
  await sleep(WAIT);
  const ch = bus.sceneChanges();
  assert('深夜tick发late_night(confidence=1)', ch.length === 1 && ch[0].scene === 'late_night' && ch[0].confidence === 1 && ch[0].detail.includes('深夜'));
  assert('深夜优先不调llm.vision', llm.visionCalls === 0);
  assert('深夜也走记忆记录', mem.records.length === 1 && mem.records[0].content.includes('深夜'));
  clockMs += 5 * 60 * 1000;
  await sleep(WAIT);
  assert('深夜同场景10分钟内不重复记录', mem.records.length === 1);
  p.stop();
}

// ---------- 6. 深夜边界：5:00整走LLM，4:59算深夜 ----------
{
  const bus = new Bus();
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  clockMs = new Date('2026-08-19T05:00:00').getTime();
  const p = new PerceptionService({ llm, events: bus, screenAPI: makeScreen(), interval: INT, now });
  p.start();
  await sleep(WAIT);
  assert('5:00整走LLM场景非late_night', bus.sceneChanges()[0]?.scene === 'work' && llm.visionCalls >= 1);
  p.stop();

  const bus2 = new Bus();
  const llm2 = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  clockMs = new Date('2026-08-19T04:59:00').getTime();
  const p2 = new PerceptionService({ llm: llm2, events: bus2, screenAPI: makeScreen(), interval: INT, now });
  p2.start();
  await sleep(WAIT);
  assert('4:59仍判深夜', bus2.sceneChanges()[0]?.scene === 'late_night' && llm2.visionCalls === 0);
  p2.stop();
  clockMs = new Date('2026-08-19T10:00:00').getTime();
}

// ---------- 7. settings:updated 配置联动 ----------
{
  const bus = new Bus();
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const storage = makeStorage();
  const p = new PerceptionService({ llm, events: bus, screenAPI: makeScreen(), interval: INT, storage, now });

  storage.setItem('pet-perception-config', JSON.stringify({ enabled: true, interval: 90000 }));
  bus.emit('settings:updated', { scope: ['perception'] });
  assert('settings开启后running', p.getStatus().running === true);
  assert('interval已更新(下次tick生效)', p.opts.interval === 90000);

  storage.setItem('pet-perception-config', JSON.stringify({ enabled: false, interval: 90000 }));
  bus.emit('settings:updated', { scope: ['perception'] });
  assert('settings关闭后停止', p.getStatus().running === false && p.getStatus().enabled === false);

  // 非perception scope不响应
  storage.setItem('pet-perception-config', JSON.stringify({ enabled: true, interval: 90000 }));
  bus.emit('settings:updated', { scope: ['llm'] });
  assert('非perception scope忽略', p.getStatus().enabled === false);
  p.stop();
}

// ---------- 8. mock模式场景轮转（不调vision） ----------
{
  const bus = new Bus();
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  llm.config.model = 'mock';
  const p = new PerceptionService({ llm, events: bus, screenAPI: makeScreen(), interval: INT, now });
  p.start();
  await sleep(INT * 4 + 80);
  const scenes = bus.sceneChanges().map((c) => c.scene);
  const expect = ['work', 'fun', 'slack', 'rest'];
  assert('mock按序轮转(含回到work)', scenes.length >= 5 && scenes.every((s, i) => s === expect[i % 4]), JSON.stringify(scenes));
  assert('mock不调llm.vision', llm.visionCalls === 0);
  p.stop();
}

// ---------- 9. JSON解析容错 ----------
{
  const bus = new Bus();
  const llm = makeLLM(() => '这不是JSON，模型偶尔话痨');
  const p = new PerceptionService({ llm, events: bus, screenAPI: makeScreen(), interval: INT, now });
  p.start();
  await sleep(WAIT);
  const ch = bus.sceneChanges();
  assert('非JSON容错为unknown', ch.length === 1 && ch[0].scene === 'unknown' && ch[0].confidence === 0.2, JSON.stringify(ch));
  p.stop();

  const bus2 = new Bus();
  const llm2 = makeLLM(() => '好的，分析结果如下：\n```json\n{"scene":"fun","confidence":0.88,"detail":"在看B站"}\n```\n希望对你有帮助！');
  const p2 = new PerceptionService({ llm: llm2, events: bus2, screenAPI: makeScreen(), interval: INT, now });
  p2.start();
  await sleep(WAIT);
  const ch2 = bus2.sceneChanges();
  assert('markdown围栏包裹的JSON可解析', ch2.length === 1 && ch2[0].scene === 'fun' && ch2[0].confidence === 0.88 && ch2[0].detail === '在看B站', JSON.stringify(ch2));
  p2.stop();
}

// ---------- 10. llm.js vision mime探测 + 独立视觉模型回归 ----------
{
  const { default: LLMService } = await import('../src/core/llm.js');
  globalThis.localStorage = makeStorage();
  const svc = new LLMService({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'gpt-4o-mini' });
  // 新实现：vision 独立 fetch（visionModel > model），mock fetch 捕获请求体
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await svc.vision('iVBORw0KGgoPNGDATA', 'test');
  const url1 = captured[0].body.messages[0].content[1].image_url.url;
  assert('PNG魔数探测为image/png', url1.startsWith('data:image/png;base64,iVBOR'), url1);
  await svc.vision('/9j/4AAQJPEGDATA', 'test');
  const url2 = captured[1].body.messages[0].content[1].image_url.url;
  assert('非PNG魔数默认jpeg(向后兼容)', url2.startsWith('data:image/jpeg;base64,'), url2);
  await svc.vision('iVBORw0KGgoPNGDATA', 'test', 'webp');
  const url3 = captured[2].body.messages[0].content[1].image_url.url;
  assert('显式mime参数优先', url3.startsWith('data:image/webp;base64,'), url3);
  assert('未配visionModel用主model', captured[0].body.model === 'gpt-4o-mini', captured[0].body.model);
  svc.setConfig({ visionModel: 'glm-4v-flash' });
  await svc.vision('iVBORw0KGgoPNGDATA', 'test');
  assert('配置visionModel后生效', captured[3].body.model === 'glm-4v-flash', captured[3].body.model);
}

// ---------- 11. 场景理解引擎：observe + 窗口滑动 ----------
{
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const p = new PerceptionService({ llm, now });
  const t0 = clockMs;

  // 逐个喂入8次观察 → 窗口只保留最近6次
  for (let i = 0; i < 8; i++) p.observe('hash-' + i, t0 + i * 1000);
  assert('窗口滑动只保留最近6次', p._observations.length === 6 && p._observations[0].hash === 'hash-2' && p._observations[5].hash === 'hash-7', JSON.stringify(p._observations.map((o) => o.hash)));
  assert('窗口内changed标记正确', p._observations.every((o) => o.changed === true));
  p.stop();
}

// ---------- 12. 稳定判定：≥4次相同变化模式 → stable ----------
{
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const p = new PerceptionService({ llm, now });
  const t0 = clockMs;

  // 连续变化6次（每次hash不同，间隔30s，总跨度未超idle条件）→ stable
  for (let i = 0; i < 6; i++) p.observe('h-' + i, t0 + i * 30000);
  assert('6次连续变化→stable', p.getStableScene() === 'stable', p.getStableScene());

  // 6次完全无变化但跨度仅90s（≤2分钟）→ 不idle，但 changed全false ≥4 → stable
  const p2 = new PerceptionService({ llm, now });
  for (let i = 0; i < 6; i++) p2.observe('same', t0 + i * 15000);
  assert('短时间无变化→stable(非idle)', p2.getStableScene() === 'stable', p2.getStableScene());
  p.stop(); p2.stop();
}

// ---------- 13. idle判定：hash全等且超2分钟 ----------
{
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const p = new PerceptionService({ llm, now });
  const t0 = clockMs;

  // 6次相同hash，间隔30s，跨度150s > 120s → idle
  for (let i = 0; i < 6; i++) p.observe('frozen', t0 + i * 30000);
  assert('无变化超2分钟→idle', p.getStableScene() === 'idle', p.getStableScene());

  // 恰好120s边界（=2分钟，不严格大于）→ 非idle
  const p2 = new PerceptionService({ llm, now });
  for (let i = 0; i < 6; i++) p2.observe('frozen', t0 + i * 24000);
  assert('跨度恰好2分钟不算idle', p2.getStableScene() !== 'idle', p2.getStableScene());
  p.stop(); p2.stop();
}

// ---------- 14. 混合变化模式 → active ----------
{
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const p = new PerceptionService({ llm, now });
  const t0 = clockMs;

  // 变化模式 3变3不变（F,T,F,T,F,T）→ true/false 各3，无 ≥4 多数 → active
  const pattern = ['a', 'b', 'b', 'c', 'c', 'd'];
  pattern.forEach((h, i) => p.observe(h, t0 + i * 30000));
  assert('混合模式→active', p.getStableScene() === 'active', p.getStableScene());

  // 空窗口 → active
  const p2 = new PerceptionService({ llm, now });
  assert('空窗口→active', p2.getStableScene() === 'active');
  p.stop(); p2.stop();
}

// ---------- 15. DND判定 ----------
{
  const llm = makeLLM(() => JSON.stringify({ scene: 'work', confidence: 0.9, detail: 'x' }));
  const p = new PerceptionService({ llm, now });
  const t0 = clockMs;

  // 外部会议标签 → DND
  assert('外部标签meeting→DND', p.isDnd('meeting') === true);
  assert('外部标签video→DND', p.isDnd('video') === true);
  // 非DND标签
  assert('外部标签work→非DND', p.isDnd('work') === false);
  // 无hint、非idle → 非DND
  assert('无hint非idle→非DND', p.isDnd() === false);

  // 注入hint后 isDnd() 生效
  p.setSceneHint('meeting');
  assert('setSceneHint(meeting)后isDnd()', p.isDnd() === true);
  assert('getSceneHint可读', p.getSceneHint() === 'meeting');
  // 显式外部参数覆盖hint
  assert('显式参数覆盖hint', p.isDnd('work') === false);
  p.setSceneHint(null);
  assert('清除hint后非DND', p.isDnd() === false && p.getSceneHint() === null);

  // 引擎idle（挂机）→ DND
  const p2 = new PerceptionService({ llm, now });
  for (let i = 0; i < 6; i++) p2.observe('frozen', t0 + i * 30000);
  assert('引擎idle→DND', p2.isDnd() === true);
  p.stop(); p2.stop();
}

// ---------- 16. tick集成：截图自动喂observe + hint同步 ----------
{
  const bus = new Bus();
  let call = 0;
  // 每次vision返回不同截屏 → mock screenAPI 每次返回不同base64
  const screen = { getScreenshot: async () => 'iVBORw0KGgoAAAANSUhEUg' + String(call).padStart(4, '0') + 'A'.repeat(80) };
  const llm = makeLLM(() => { call++; return JSON.stringify({ scene: 'work', confidence: 0.9, detail: '写代码' }); });
  const p = new PerceptionService({ llm, events: bus, screenAPI: screen, interval: INT, now });
  p.start();
  await sleep(INT * 7 + 80); // 7+次tick
  assert('tick自动observe(窗口=6)', p._observations.length === 6, `实际${p._observations.length}`);
  assert('LLM场景同步为hint', p.getSceneHint() === 'work', p.getSceneHint());
  assert('持续变化截图→stable', p.getStableScene() === 'stable', p.getStableScene());
  p.stop();
}

// ---------- 汇总 ----------
console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
