// main/tools.js — 小球Agent工具层（主进程执行，Node权限）
// 安全原则：路径限制用户目录 / shell白名单 / 破坏性命令禁止
const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// ---------- 安全校验 ----------
function safePath(p) {
  const abs = path.resolve(String(p || ''));
  const allowed = [HOME, '/tmp', '/Applications'];
  if (!allowed.some(root => abs === root || abs.startsWith(root + path.sep))) {
    throw new Error(`路径越界（仅允许用户目录/tmp）: ${abs}`);
  }
  return abs;
}

const SHELL_ALLOW = /^(ls|cat|head|tail|mkdir|cp|mv|touch|open|say|df|du|date|whoami|pwd|echo|wc|find|grep|which|file|stat|uptime|sw_vers|pmset|networksetup -getairportnetwork|screencapture)\b/;
const SHELL_DENY = /\b(rm|sudo|curl|wget|chmod|chown|kill|killall|osascript -e 'do shell script.*admin|mkfs|dd)\b/;

function execShell(cmd, timeoutMs = 15000) {
  const c = String(cmd || '').trim();
  if (!c) throw new Error('空命令');
  if (SHELL_DENY.test(c)) throw new Error(`命令被安全策略拒绝: ${c.slice(0, 60)}`);
  if (!SHELL_ALLOW.test(c)) throw new Error(`命令不在白名单: ${c.split(' ')[0]}（可让主人到设置开启更多）`);
  return new Promise((resolve) => {
    exec(c, { timeout: timeoutMs, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').toString().slice(0, 4000), stderr: (stderr || '').toString().slice(0, 1000), error: err ? String(err.message).slice(0, 200) : null });
    });
  });
}

function appleScript(script) {
  const s = String(script || '');
  if (!s) throw new Error('空脚本');
  if (SHELL_DENY.test(s)) throw new Error('AppleScript含禁止命令');
  return new Promise((resolve) => {
    execFile('osascript', ['-e', s], { timeout: 20000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').toString().slice(0, 4000), stderr: (stderr || '').toString().slice(0, 1000), error: err ? String(err.message).slice(0, 300) : null });
    });
  });
}

// ---------- 工具注册表 ----------
const TOOLS = {
  list_dir: async ({ dir = HOME }) => {
    const abs = safePath(dir);
    const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 200);
    return items.map(i => (i.isDirectory() ? '[目录] ' : '[文件] ') + i.name).join('\n') || '（空目录）';
  },
  read_file: async ({ file }) => {
    const abs = safePath(file);
    const st = fs.statSync(abs);
    if (st.size > 100 * 1024) return '（文件太大，只读前100KB）\n' + fs.readFileSync(abs, 'utf8').slice(0, 100 * 1024);
    return fs.readFileSync(abs, 'utf8');
  },
  write_file: async ({ file, content = '' }) => {
    const abs = safePath(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content), 'utf8');
    return `已写入 ${abs}（${String(content).length}字符）`;
  },
  move_file: async ({ src, dst }) => {
    const a = safePath(src), b = safePath(dst);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return `已移动: ${a} → ${b}`;
  },
  open_app: async ({ name }) => {
    return execShell(`open -a "${String(name).replace(/["`$]/g, '')}"`);
  },
  open_url: async ({ url }) => {
    const u = String(url || '');
    if (!/^https?:\/\//.test(u)) throw new Error('仅支持 http/https 链接');
    return execShell(`open "${u.replace(/["`$]/g, '')}"`);
  },
  run_applescript: async ({ script }) => appleScript(script),
  shell: async ({ cmd }) => execShell(cmd),
  screenshot: async () => {
    const out = path.join('/tmp', `pet-shot-${Date.now()}.png`);
    const r = await new Promise((resolve) => exec(`screencapture -x "${out}"`, { timeout: 10000 }, (err) => resolve(!err)));
    return r ? `截图已保存: ${out}` : '截图失败（可能需要屏幕录制权限）';
  },
  system_info: async () => {
    return `用户: ${os.userInfo().username}\n系统: ${os.type()} ${os.release()}\n内存: ${Math.round(os.totalmem() / 1e9)}GB 可用${Math.round(os.freemem() / 1e9)}GB\n时间: ${new Date().toLocaleString('zh-CN')}`;
  },
};

// GLM/OpenAI function-calling 工具定义（给LLM看的说明书）
const TOOL_SPECS = [
  { type: 'function', function: { name: 'list_dir', description: '列出目录内容（默认桌面/用户目录）', parameters: { type: 'object', properties: { dir: { type: 'string', description: '目录绝对路径，如 /Users/mac/Desktop' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: '读取文本文件内容', parameters: { type: 'object', properties: { file: { type: 'string', description: '文件绝对路径' } }, required: ['file'] } } },
  { type: 'function', function: { name: 'write_file', description: '写文件（新建/覆盖）', parameters: { type: 'object', properties: { file: { type: 'string', description: '目标路径' }, content: { type: 'string', description: '写入内容' } }, required: ['file', 'content'] } } },
  { type: 'function', function: { name: 'move_file', description: '移动/重命名文件或目录（可用来整理桌面）', parameters: { type: 'object', properties: { src: { type: 'string' }, dst: { type: 'string' } }, required: ['src', 'dst'] } } },
  { type: 'function', function: { name: 'open_app', description: '打开macOS应用，如 WeChat/Safari/Netease Music', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'open_url', description: '用默认浏览器打开网址', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'run_applescript', description: '执行AppleScript自动化macOS（控制窗口/通知/应用消息等）', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'shell', description: '执行白名单shell命令（ls/cat/mkdir/cp/mv/open/say等）', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } } },
  { type: 'function', function: { name: 'screenshot', description: '截取全屏保存到/tmp（需要屏幕录制权限）', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'system_info', description: '获取系统信息（用户/内存/时间）', parameters: { type: 'object', properties: {}, required: [] } } },
];

// IPC入口
function initToolsIPC(ipcMain, getLogger) {
  ipcMain.handle('tool-invoke', async (_e, name, args) => {
    const log = getLogger || (() => {});
    const fn = TOOLS[name];
    if (!fn) return { ok: false, error: `未知工具: ${name}` };
    const t0 = Date.now();
    try {
      const result = await fn(args || {});
      log(`[tools] ${name} ✓ ${Date.now() - t0}ms`);
      return { ok: true, result: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (err) {
      log(`[tools] ${name} ✗ ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });
}

module.exports = { initToolsIPC, TOOL_SPECS };