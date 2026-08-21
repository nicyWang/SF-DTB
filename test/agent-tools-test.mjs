// test/agent-tools-test.mjs — Agent工具层单测（node直测逻辑，IPC层mock）
// 运行：node test/agent-tools-test.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  isValidAppName,
  resolveAllowedDir,
  createReminderManager,
  initToolsIPC,
} = require('../main/tools.js');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
}

const HOME = os.homedir();

console.log('== 1. open-app 应用名白名单 ==');
await test('合法：Safari / Netease Music / Notes2', () => {
  assert.ok(isValidAppName('Safari'));
  assert.ok(isValidAppName('Netease Music'));
  assert.ok(isValidAppName('Notes2'));
});
await test('非法：注入符号 ; | & ` $ ( ) 与路径 ../ 等', () => {
  for (const bad of ['Safari; rm -rf /', 'a && b', 'x`y`', '$(cmd)', '../etc', 'a|b', 'a&b', 'a;b']) {
    assert.ok(!isValidAppName(bad), `应拒绝: ${bad}`);
  }
});
await test('非法：空/非字符串/超长', () => {
  assert.ok(!isValidAppName(''));
  assert.ok(!isValidAppName('   '));
  assert.ok(!isValidAppName(null));
  assert.ok(!isValidAppName(123));
  assert.ok(!isValidAppName('x'.repeat(101)));
});
await test('中文应用名被拒（白名单仅ASCII，防不可见字符绕过）', () => {
  assert.ok(!isValidAppName('微信'));
});

console.log('== 2. list-dir 路径白名单 ==');
await test('合法：~/Desktop 及其子目录、~开头简写、绝对路径', () => {
  assert.equal(resolveAllowedDir('~/Desktop'), path.join(HOME, 'Desktop'));
  assert.equal(resolveAllowedDir(path.join(HOME, 'Documents')), path.join(HOME, 'Documents'));
  const sub = resolveAllowedDir('~/Downloads/a/b');
  assert.ok(sub.startsWith(path.join(HOME, 'Downloads') + path.sep));
});
await test('合法：~/WorkBuddy 与其子目录', () => {
  assert.equal(resolveAllowedDir('~/WorkBuddy'), path.join(HOME, 'WorkBuddy'));
  assert.ok(resolveAllowedDir(path.join(HOME, 'WorkBuddy/x')).startsWith(path.join(HOME, 'WorkBuddy')));
});
await test('拒绝：主目录本身 / 私密目录（Library、.ssh）', () => {
  assert.throws(() => resolveAllowedDir('~'));
  assert.throws(() => resolveAllowedDir('~/Library'));
  assert.throws(() => resolveAllowedDir('~/Library/Preferences'));
  assert.throws(() => resolveAllowedDir(path.join(HOME, '.ssh')));
});
await test('拒绝：系统敏感路径（/etc /private/tmp）', () => {
  assert.throws(() => resolveAllowedDir('/etc'));
  assert.throws(() => resolveAllowedDir('/private/tmp'));
});
await test('拒绝：路径穿越（~/Desktop/../../Library）', () => {
  assert.throws(() => resolveAllowedDir('~/Desktop/../../Library'));
});
await test('拒绝：前缀伪造（~/DesktopSecret 不在白名单）', () => {
  assert.throws(() => resolveAllowedDir('~/DesktopSecret'));
});

console.log('== 3. reminder 句柄管理 ==');
await test('set 返回id，has=true，到点触发回调并出表', async () => {
  const fired = [];
  const rm = createReminderManager((text) => fired.push(text));
  const id = rm.set(0.01, '喝水'); // 0.6s
  assert.ok(typeof id === 'string' && id);
  assert.ok(rm.has(id));
  assert.equal(rm.size, 1);
  await new Promise(r => setTimeout(r, 900));
  assert.deepEqual(fired, ['喝水']);
  assert.ok(!rm.has(id));
  assert.equal(rm.size, 0);
});
await test('cancel 已设提醒：has=false 不再触发', async () => {
  const fired = [];
  const rm = createReminderManager((text) => fired.push(text));
  const id = rm.set(0.05, '不应触发');
  assert.ok(rm.cancel(id));
  assert.ok(!rm.has(id));
  assert.ok(!rm.cancel(id)); // 二次取消失败
  await new Promise(r => setTimeout(r, 800));
  assert.equal(fired.length, 0);
});
await test('cancel 不存在的id返回false', () => {
  const rm = createReminderManager(() => {});
  assert.ok(!rm.cancel('nope'));
});
await test('minutes 非法：0/负数/NaN/超大/字符串', () => {
  const rm = createReminderManager(() => {});
  for (const bad of [0, -1, NaN, Infinity, 'abc', 999999]) {
    assert.throws(() => rm.set(bad, 'x'), undefined, `应拒绝 minutes=${bad}`);
  }
});
await test('text 非法：空/非字符串', () => {
  const rm = createReminderManager(() => {});
  assert.throws(() => rm.set(1, ''));
  assert.throws(() => rm.set(1, '   '));
});
await test('cancelAll 清空所有句柄', async () => {
  const fired = [];
  const rm = createReminderManager((t) => fired.push(t));
  rm.set(0.05, 'a'); rm.set(0.05, 'b');
  assert.equal(rm.size, 2);
  rm.cancelAll();
  assert.equal(rm.size, 0);
  await new Promise(r => setTimeout(r, 800));
  assert.equal(fired.length, 0);
});

console.log('== 4. IPC 层（mock ipcMain/tool-invoke 分发） ==');
// mock ipcMain.handle(channel, fn)：捕获handler供直调
function mockIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (ch, fn) => handlers.set(ch, fn),
  };
}
const logs = [];
const ipc = mockIpcMain();
initToolsIPC(ipc, (m) => logs.push(m));
const invoke = (name, args) => ipc.handlers.get('tool-invoke')(null, name, args);

await test('未知工具 → {ok:false}', async () => {
  const r = await invoke('no-such-tool', {});
  assert.ok(!r.ok);
});
await test('open-app：注入名被拒（ok:false）', async () => {
  const r = await invoke('open-app', { appName: 'Safari; rm -rf /' });
  assert.ok(!r.ok);
  assert.ok(/appName 非法/.test(r.error));
});
await test('open-app：合法名执行成功（ok:true，Safari存在的机器）', async () => {
  const r = await invoke('open-app', { appName: 'Finder' });
  assert.ok(r.ok, JSON.stringify(r));
});
await test('open-app：不存在的应用 → ok:false 且 error 有信息', async () => {
  const r = await invoke('open-app', { appName: 'DefinitelyNotAnApp12345' });
  assert.ok(!r.ok);
  assert.ok(r.error && r.error.length > 0);
});
await test('list-dir：越权路径被拒', async () => {
  const r = await invoke('list-dir', { dirPath: '/etc' });
  assert.ok(!r.ok);
  assert.ok(/路径越界/.test(r.error));
});
await test('list-dir：白名单内目录返回 items 数组', async () => {
  // 在系统临时位置无法伪造白名单目录，直接列真实 ~/Desktop（存在性由系统保证）
  const r = await invoke('list-dir', { dirPath: '~/Desktop' });
  assert.ok(r.ok, JSON.stringify(r));
  const parsed = JSON.parse(r.result);
  assert.ok(Array.isArray(parsed.items));
  assert.ok(parsed.count <= 50);
  for (const it of parsed.items.slice(0, 5)) {
    assert.ok(['dir', 'file', 'link'].includes(it.type));
    assert.ok(typeof it.name === 'string');
  }
});
await test('list-dir：超过50项时 truncated 标记（用tmp目录+伪造HOME不可行，此处验证50上限字段存在）', async () => {
  const r = await invoke('list-dir', { dirPath: '~/Documents' });
  assert.ok(r.ok);
  const parsed = JSON.parse(r.result);
  assert.ok(typeof parsed.truncated === 'boolean');
  assert.ok(parsed.items.length <= 50);
});
await test('set-reminder：设置成功返回id（走真实manager，到点前取消）', async () => {
  const r = await invoke('set-reminder', { minutes: 5, text: '测试提醒' });
  assert.ok(r.ok, JSON.stringify(r));
  const parsed = JSON.parse(r.result);
  assert.ok(parsed.id);
  // 清理：取消
  const c = await invoke('cancel-reminder', { id: parsed.id });
  assert.ok(c.ok);
});
await test('set-reminder：非法minutes被拒', async () => {
  const r = await invoke('set-reminder', { minutes: 0, text: 'x' });
  assert.ok(!r.ok);
});
await test('cancel-reminder：不存在的id → ok:false', async () => {
  const r = await invoke('cancel-reminder', { id: 'ghost' });
  assert.ok(!r.ok);
});
await test('IPC 日志记录调用', async () => {
  await invoke('open-app', { appName: 'Finder' });
  assert.ok(logs.some(l => l.includes('open-app')));
});

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
