// character-studio-test.mjs — 角色工坊三模块单测（node，无 Electron）
// 覆盖：
//  1. CharPromptBuilder：三风格模板/槽位填充/质量保障词/vision prompt/照片特征/滤镜映射表
//  2. CharacterManager：注册/删除/active/getDir/resolve（mock IPC）
//  3. ImageGenService：mock 模式 / 配置持久化 / fetch stub（错误友好提示、b64_json、url 下载）

// ---- localStorage stub（须在 import 前就位：模块顶层读取配置在实例化时，延迟无碍） ----
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

const { CharPromptBuilder, DEFAULT_PHOTO_FEATURES, EMOTION_FILTERS } = await import('../src/core/charprompt.js');
const { CharacterManager, REGISTRY_KEY, ACTIVE_KEY } = await import('../src/core/characters.js');
const { ImageGenService, STORAGE_KEY: IMG_KEY } = await import('../src/core/imagegen.js');

// ============================================================
// 1. CharPromptBuilder
// ============================================================
console.log('--- 1. CharPromptBuilder ---');
reset();
const pb = new CharPromptBuilder();

// 1.1 三风格模板 + 默认表单（写实+男+23-27+商务精英）
const pReal = pb.buildFromForm({});
assert('写实模板锚定词', pReal.includes('写实人像摄影风立绘'), pReal.slice(0, 20));
assert('默认性别男', pReal.includes('男'));
assert('默认年龄23-27岁', pReal.includes('23-27岁'));
assert('默认面部气质（男性前两个）', pReal.includes('帅气硬朗') && pReal.includes('剑眉星目'));
assert('默认发型', pReal.includes('黑色短发干净利落'));
assert('默认服装（商务精英首选）', pReal.includes('修身西装+白衬衫'));
assert('默认气质完整句', pReal.includes('成熟魅力型：气质优雅自信'));

const pAnime = pb.buildFromForm({ style: 'anime', gender: 'female' });
assert('动漫模板锚定词', pAnime.includes('高质量动漫立绘') && pAnime.includes('精致日系动画风格'));
assert('女性槽位', pAnime.includes('女') && pAnime.includes('精致面容') && pAnime.includes('长直发黑亮'));

const pGame = pb.buildFromForm({ style: 'game' });
assert('游戏CG模板锚定词', pGame.includes('游戏角色立绘CG') && pGame.includes('次世代游戏CG水准'));
assert('非法风格回退写实', pb.buildFromForm({ style: 'xxx' }).includes('写实人像摄影风立绘'));

// 1.2 质量保障词（所有模板固定包含）
for (const style of ['realistic', 'anime', 'game']) {
  const p = pb.buildFromForm({ style });
  assert(`${style} 含质量保障词`, p.includes('人物居中') && p.includes('浅灰色纯色') && p.includes('高质量'));
}
assert('写实含构图80%约束', pReal.includes('80%以上'));

// 1.3 槽位填充：数组face拼接、自由文本透传、extra追加
const pCustom = pb.buildFromForm({
  style: 'anime', gender: 'male', ageBand: '28-35',
  face: ['温润儒雅', '深邃眼眸', '高挺鼻梁'],
  hair: '微卷短发时尚感', clothing: '卫衣+牛仔裤', temperament: 'gentle',
  extra: '戴金丝眼镜',
});
assert('face数组拼接（顿号）', pCustom.includes('温润儒雅、深邃眼眸、高挺鼻梁'));
assert('ageBand映射成熟感', pCustom.includes('28-35岁成熟感'));
assert('气质键映射完整句', pCustom.includes('温柔治愈型：气质温柔'));
assert('extra追加', pCustom.endsWith('戴金丝眼镜'));

// 1.4 vision prompt
const vp = pb.buildVisionPrompt();
for (const k of ['gender', 'age_band', 'face', 'hair', 'clothing', 'temperament']) {
  assert(`vision prompt 含字段 ${k}`, vp.includes(k));
}
assert('vision prompt 要求只回JSON', vp.includes('只回JSON'));

// 1.5 照片特征 → 转绘 prompt
const pPhoto = pb.buildFromPhotoFeatures(
  { gender: '女', age_band: '18-22', face: '明眸善睐、笑容治愈', hair: '大波浪卷发妩媚', clothing: '白色连衣裙', temperament: '阳光活力型' },
  'anime',
);
assert('照片特征填入模板', pPhoto.includes('高质量动漫立绘') && pPhoto.includes('明眸善睐、笑容治愈') && pPhoto.includes('白色连衣裙'));
assert('照片转绘追加参考句', pPhoto.includes('参考照片人物的面部特征和气质，保持人物辨识度'));

// 1.6 parseVisionFeatures
const parsed = CharPromptBuilder.parseVisionFeatures(
  '好的，以下是分析结果：\n```json\n{"gender":"男","age_band":"23-27","face":"剑眉星目","hair":"黑色短发","clothing":"西装","temperament":"成熟"}\n```',
);
assert('vision回复JSON解析（容忍代码围栏）', parsed && parsed.gender === '男' && parsed.face === '剑眉星目');
assert('垃圾回复解析返回null', CharPromptBuilder.parseVisionFeatures('[mock] 我看了一眼屏幕') === null);
assert('空JSON解析返回null', CharPromptBuilder.parseVisionFeatures('{}') === null);

// 1.7 表情滤镜映射表完整性（skill 第五节）
const filters = pb.getEmotionFilters();
for (const emo of ['normal', 'happy', 'excited', 'sad', 'sleepy', 'bored']) {
  assert(`滤镜表含 ${emo}`, !!filters[emo]);
}
assert('happy 滤镜参数', filters.happy.brightness === 0.08 && filters.happy.saturation === 0.10 && filters.happy.scale === 1.02);
assert('excited 滤镜含摇摆', filters.excited.scale === 1.05 && !!filters.excited.sway);
assert('sad 滤镜参数', filters.sad.brightness === -0.08 && filters.sad.saturation === -0.25 && !!filters.sad.offsetYRatio);
assert('sleepy 滤镜呼吸加深', !!filters.sleepy.breathMul);
assert('bored 滤镜参数', filters.bored.brightness === -0.04 && filters.bored.saturation === -0.12);
assert('getEmotionFilters 返回副本', filters !== EMOTION_FILTERS && filters.happy !== EMOTION_FILTERS.happy);

// 1.8 表单选项（settings UI 数据源）
const opt = pb.getFormOptions();
assert('表单选项：3风格', opt.styles.length === 3 && opt.styles.some((s) => s.value === 'realistic'));
assert('表单选项：男女面部词库', opt.faces.male.length >= 6 && opt.faces.female.length >= 6);
assert('表单选项：服装分组', opt.clothings.length === 5 && opt.clothings.some((c) => c.group === '商务精英'));

// ============================================================
// 2. CharacterManager（mock IPC）
// ============================================================
console.log('\n--- 2. CharacterManager ---');
reset();
const ipcCalls = { save: [], delete: [], read: [] };
const mockIPC = {
  saveImage: async (id, b64) => { ipcCalls.save.push({ id, b64 }); return { ok: true, path: `data/characters/${id}/normal.png` }; },
  deleteDir: async (id) => { ipcCalls.delete.push(id); return { ok: true }; },
  readImage: async (p) => { ipcCalls.read.push(p); return 'aGVsbG8gd29ybGQ='; },
};
const mgr = new CharacterManager({ ipc: mockIPC });

// 2.1 初始：仅内置两角色
assert('初始列表=内置2角色', mgr.list().length === 2 && mgr.list().every((c) => c.source === 'builtin'));
assert('默认active=handsome', mgr.getActive() === 'handsome');
assert('非法active回退', (kv.set(ACTIVE_KEY, 'nonexistent'), mgr.getActive() === 'handsome'));

// 2.2 创建用户角色
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const created = await mgr.create('小明', 'data:image/png;base64,' + PNG_B64, { source: 'photo', style: 'realistic', model: 'mock' });
assert('创建成功', created.ok && !!created.character);
assert('用户角色id为uc_前缀', /^uc_[a-z0-9]+$/i.test(created.character.id), created.character.id);
assert('IPC收到保存请求（data URL前缀已剥离）', ipcCalls.save.length === 1 && ipcCalls.save[0].b64 === PNG_B64);
assert('注册表持久化', JSON.parse(kv.get(REGISTRY_KEY)).length === 1);
assert('列表含新角色', mgr.list().length === 3 && mgr.list().some((c) => c.id === created.character.id && c.source === 'photo'));
assert('getDir用户角色', mgr.getDir(created.character.id) === 'data/characters/' + created.character.id);

// 2.3 active 管理
assert('setActive/getActive', mgr.setActive(created.character.id) === created.character.id && mgr.getActive() === created.character.id);
assert('setActive未知id不变', mgr.setActive('ghost') === created.character.id);

// 2.4 resolve（sprite 加载用）
const r1 = await mgr.resolve('handsome');
assert('resolve内置=帧模式', r1.mode === 'frames' && r1.dir === 'assets/characters/handsome');
const r2 = await mgr.resolve(created.character.id);
assert('resolve用户=单图模式+base64', r2.mode === 'single' && r2.imageBase64 === 'aGVsbG8gd29ybGQ=');
assert('resolve读取走IPC路径', ipcCalls.read.some((p) => p.includes('normal.png')));
assert('resolve未知=null', (await mgr.resolve('nope')) === null);

// 2.5 删除
const delBuiltin = await mgr.remove('handsome');
assert('内置不可删', !delBuiltin.ok);
const del = await mgr.remove(created.character.id);
assert('删除用户角色成功', del.ok && ipcCalls.delete.includes(created.character.id));
assert('删除后列表还原2个', mgr.list().length === 2);
assert('删除活动角色→active回退handsome', mgr.getActive() === 'handsome');

// 2.6 参数校验
assert('空名创建失败', !(await mgr.create('', PNG_B64)).ok);
assert('无IPC环境创建失败', !(await new CharacterManager({ ipc: null }).create('x', PNG_B64)).ok);

// ============================================================
// 3. ImageGenService
// ============================================================
console.log('\n--- 3. ImageGenService ---');
reset();
const realFetch = globalThis.fetch;

// 3.1 mock 模式（node 无 canvas → 1x1 PNG 兜底）
const mockSvc = new ImageGenService({ model: 'mock' });
const mockRes = await mockSvc.generate('测试提示词');
assert('mock生图成功', mockRes.ok === true && !!mockRes.imageBase64 && mockRes.mock === true);

// 3.2 配置持久化
const cfgSvc = new ImageGenService();
cfgSvc.setConfig({ baseURL: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'img-model-x' });
assert('配置落盘', JSON.parse(kv.get(IMG_KEY)).model === 'img-model-x');
assert('新实例读取配置', new ImageGenService().getConfig().baseURL === 'https://api.example.com/v1');

// 3.3 未配置（非mock）
reset();
const unconfigured = new ImageGenService();
const rUn = await unconfigured.generate('x');
assert('未配置返回友好错误', rUn.ok === false && /未配置/.test(rUn.error));

// 3.4 HTTP 401 错误（stub fetch）
let fetchLog = [];
globalThis.fetch = async (url, init) => {
  fetchLog.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
  return { ok: false, status: 401, text: async () => 'unauthorized' };
};
const svc401 = new ImageGenService({ baseURL: 'https://api.example.com/v1', apiKey: 'bad', model: 'm' });
const r401 = await svc401.generate('测试');
assert('401→友好错误（鉴权失败）', r401.ok === false && /鉴权失败/.test(r401.error));
assert('请求体OpenAI格式', fetchLog[0].body.model === 'm' && fetchLog[0].body.n === 1 && fetchLog[0].body.size === '1024x1536' && fetchLog[0].body.prompt === '测试');
assert('请求打到 /images/generations', fetchLog[0].url.endsWith('/images/generations'));

// 3.5 网络错误
globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
const rNet = await svc401.generate('测试');
assert('网络错误→友好提示', rNet.ok === false && /网络连接失败/.test(rNet.error));

// 3.6 b64_json 响应
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ data: [{ b64_json: PNG_B64 }] }),
});
const rB64 = await svc401.generate('测试');
assert('b64_json解析成功', rB64.ok === true && rB64.imageBase64 === PNG_B64);

// 3.7 url 响应（二次 fetch 下载）
globalThis.fetch = async (url) => {
  if (url.startsWith('https://cdn')) {
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode('hello-image').buffer };
  }
  return { ok: true, json: async () => ({ data: [{ url: 'https://cdn.example.com/img.png' }] }) };
};
const rUrl = await svc401.generate('测试');
assert('url响应→下载转base64', rUrl.ok === true && rUrl.imageBase64 === Buffer.from('hello-image').toString('base64'));

// 3.8 异常响应格式
globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{}] }) });
const rBad = await svc401.generate('测试');
assert('异常格式→友好错误', rBad.ok === false && /格式异常/.test(rBad.error));

// 3.9 空prompt
globalThis.fetch = realFetch;
const rEmpty = await svc401.generate('  ');
assert('空prompt→错误', rEmpty.ok === false && /提示词为空/.test(rEmpty.error));

console.log('\n✅ ALL CHARACTER-STUDIO TESTS PASSED');
process.exit(0);
