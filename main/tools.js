// main/tools.js — 小球Agent工具层（主进程执行，Node权限）
// 安全原则：路径限制用户目录 / shell白名单 / 破坏性命令禁止
const { execFile, exec } = require('child_process');
const IS_WIN = process.platform === 'win32'; // 双平台适配：Windows 分发
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

const SHELL_ALLOW_DARWIN = /^(ls|cat|head|tail|mkdir|cp|mv|touch|open|say|df|du|date|whoami|pwd|echo|wc|find|grep|which|file|stat|uptime|sw_vers|pmset|networksetup -getairportnetwork|screencapture)\b/;
const SHELL_ALLOW_WIN = /^(dir|type|mkdir|copy|move|echo|whoami|date|time|cd|ver|systeminfo|tasklist|findstr|tree|start)\b/i;
const SHELL_ALLOW = IS_WIN ? SHELL_ALLOW_WIN : SHELL_ALLOW_DARWIN;
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


// ── 双平台自动化执行层 ──
// macOS: AppleScript (osascript)；Windows: PowerShell（SendKeys/光标）
function appleScript(script) {
  if (IS_WIN) return runPowerShell(scriptToPowerShell(script));
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 20000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve(err ? `执行失败: ${String(stderr || err.message).slice(0, 200)}` : String(stdout).trim());
    });
  });
}

// Windows PowerShell 执行（-EncodedCommand 防 quoting 地狱）
function runPowerShell(psScript) {
  return new Promise((resolve) => {
    const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { timeout: 20000, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve(err ? `执行失败: ${String(stderr || err.message).slice(0, 200)}` : String(stdout).trim());
    });
  });
}

// AppleScript 常用模式 → PowerShell 等价翻译（type-text/click-at 用）
function scriptToPowerShell(script) {
  const s = String(script);
  // keystroke "xxx"
  let m = s.match(/keystroke "((?:[^"\\]|\\.)*)"/);
  if (m) {
    let text = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    // SendKeys 转义：{}+^%~()[] 特殊字符
    const esc = text.replace(/([+^%~()\[\]])/g, '{$1}');
    return `$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys('${esc.replace(/'/g, "''")}')`;
  }
  // click at {x, y}
  m = s.match(/click at \{(\d+),\s*(\d+)\}/);
  if (m) {
    const [, x, y] = m;
    return `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Clicker {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); // LEFTDOWN
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); // LEFTUP
  }
}
'@
[Clicker]::Click(${x}, ${y})`;
  }
  return `$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys('')`; // 未识别模式：空操作
}


// ---------- Agent工具（连字符版）安全校验 ----------
// open-app 应用名白名单：仅字母/数字/空格，防shell注入（配合execFile免shell更稳）
function isValidAppName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  // 允许中文（\p{Script=Han}）应用名：execFile 参数级隔离不经 shell，中文无注入面
  return n.length >= 1 && n.length <= 100 && /^[\p{L}\p{N} .\-\u4e00-\u9fff]+$/u.test(n);
}

// list-dir 路径白名单：仅允许主目录下这4个前缀，防越权读全盘
const LIST_DIR_ROOTS = ['Desktop', 'Documents', 'Downloads', 'WorkBuddy']
  .map(d => path.join(HOME, d));

function resolveAllowedDir(p) {
  let raw = String(p || '');
  if (raw === '~') raw = HOME;
  else if (raw.startsWith('~/')) raw = path.join(HOME, raw.slice(2)); // 支持 ~/Desktop 写法
  else if (raw.startsWith('~')) throw new Error(`不支持的路径写法（仅 ~ 或 ~/xxx）: ${raw}`);
  const abs = path.resolve(raw);
  const hit = LIST_DIR_ROOTS.some(root => abs === root || abs.startsWith(root + path.sep));
  if (!hit) {
    throw new Error(`路径越界（仅允许 ~/Desktop ~/Documents ~/Downloads ~/WorkBuddy）: ${abs}`);
  }
  return abs;
}

// ---------- reminder 句柄管理（内存级定时器，可取消） ----------
function createReminderManager(sendFn) {
  const timers = new Map(); // id -> Timeout
  let seq = 0;
  const fire = (id, text) => {
    timers.delete(id); // 触发即出表
    try { (sendFn || (() => {}))(text, id); } catch { /* 通知失败不致命 */ }
  };
  return {
    // minutes: 分钟数（>0，≤30天防setTimeout溢出）；text: 提醒文案 → 返回可取消的id
    set(minutes, text) {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m <= 0 || m > 30 * 24 * 60) {
        throw new Error(`minutes 非法（需 0 < minutes ≤ 43200）: ${minutes}`);
      }
      const t = String(text || '').trim().slice(0, 500);
      if (!t) throw new Error('text 不能为空');
      const id = `r${++seq}_${Date.now().toString(36)}`;
      const timer = setTimeout(() => fire(id, t), Math.round(m * 60 * 1000));
      timers.set(id, timer);
      return id;
    },
    cancel(id) {
      const timer = timers.get(id);
      if (!timer) return false;
      clearTimeout(timer);
      timers.delete(id);
      return true;
    },
    cancelAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    has: (id) => timers.has(id),
    get size() { return timers.size; },
  };
}

// 默认通知通道：到点经主窗口 webContents 广播 'agent-reminder'
function sendReminderToRenderer(text, id) {
  try {
    const { BrowserWindow } = require('electron'); // 延迟require：纯node单测下不炸
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (win) win.webContents.send('agent-reminder', { text, id });
  } catch { /* 非Electron环境（单测）静默 */ }
}
const reminderManager = createReminderManager(sendReminderToRenderer);

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
    const n = String(name || '').replace(/["`$]/g, '');
    if (IS_WIN) {
      // Windows：start 命令（cmd 内建）；常用中文名映射
      const WIN_APP = { '微信': 'WeChat', '酷狗': 'kugou', '网易云音乐': 'cloudmusic', 'qq音乐': 'QQMusic', '浏览器': 'msedge', '备忘录': 'notepad', '计算器': 'calc', '记事本': 'notepad', '终端': 'wt' };
      const target = WIN_APP[n.toLowerCase()] || WIN_APP[n] || n;
      return execShell(`start "" "${target}"`);
    }
    return execShell(`open -a "${n}"`);
  },
  open_url: async ({ url }) => {
    const u = String(url || '');
    if (!/^https?:\/\//.test(u)) throw new Error('仅支持 http/https 链接');
    const safe = u.replace(/["`$]/g, '');
    if (IS_WIN) return execShell(`start "" "${safe}"`);
    return execShell(`open "${safe}"`);
  },
  run_applescript: async ({ script }) => appleScript(script),
  shell: async ({ cmd }) => execShell(cmd),
  screenshot: async () => {
    const os = require('os');
    const out = path.join(os.tmpdir(), `pet-shot-${Date.now()}.png`);
    let r = false;
    if (IS_WIN) {
      // PowerShell 截屏（System.Drawing CopyFromScreen）
      const ps = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size); $bmp.Save('${out.replace(/\\/g, '\\\\')}'); $g.Dispose(); $bmp.Dispose()`;
      r = await runPowerShell(ps).then(t => !String(t).startsWith('执行失败'));
    } else {
      r = await new Promise((resolve) => exec(`screencapture -x "${out}"`, { timeout: 10000 }, (err) => resolve(!err)));
    }
    return r ? `截图已保存: ${out}` : '截图失败（macOS需屏幕录制权限/Windows可能失败）';
  },
  system_info: async () => {
    return `用户: ${os.userInfo().username}\n系统: ${os.type()} ${os.release()}\n内存: ${Math.round(os.totalmem() / 1e9)}GB 可用${Math.round(os.freemem() / 1e9)}GB\n时间: ${new Date().toLocaleString('zh-CN')}`;
  },

  // ---------- Agent工具（连字符版，独立IPC级校验） ----------
  // open-app: { appName } → macOS open -a（execFile不经shell，参数级隔离）
  'open-app': async ({ appName }) => {
    if (!isValidAppName(appName)) {
      throw new Error(`appName 非法（仅允许字母/数字/空格）: ${String(appName).slice(0, 60)}`);
    }
    let name = String(appName).trim();
    // 打开失败 → 模糊匹配：扫 /Applications 与 ~/Applications 找相似名
    // （解决"酷狗"真名是 KugouMusic、"微信"是 WeChat 这类中英/简称对不上）
    const tryOpen = (n) => new Promise((resolve) => {
      if (IS_WIN) {
        execFile('cmd.exe', ['/c', 'start', '', n], { timeout: 15000 }, (err, _so, se) => resolve(err ? String(se || err.message) : null));
        return;
      }
      execFile('open', ['-a', n], { timeout: 15000 }, (err, _so, se) => resolve(err ? String(se || err.message) : null));
    });
    let err = await tryOpen(name);
    if (!err) return { ok: true };
    const fuzzy = fuzzyFindApp(name);
    if (fuzzy) {
      err = await tryOpen(fuzzy);
      if (!err) return { ok: true, matched: fuzzy };
      name = fuzzy;
    }
    throw new Error(`没找到应用"${appName}"${fuzzy ? `（模糊匹配${name}也失败）` : ''}: ${err.slice(0, 120)}`);
  },
  // list-dir: { dirPath } → 目录列表（最多50项，含类型标记），路径白名单见 resolveAllowedDir
  'list-dir': async ({ dirPath }) => {
    const abs = resolveAllowedDir(dirPath);
    const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 50);
    const list = items.map(i => ({ name: i.name, type: i.isDirectory() ? 'dir' : i.isSymbolicLink() ? 'link' : 'file' }));
    return { dir: abs, count: list.length, truncated: items.length === 50, items: list };
  },
  // set-reminder: { minutes, text } → 内存定时器，到点 webContents.send('agent-reminder',{text})
  'set-reminder': async ({ minutes, text }) => {
    const id = reminderManager.set(minutes, text);
    return { ok: true, id, message: `已设置 ${minutes} 分钟后提醒：${String(text).slice(0, 50)}` };
  },
  // cancel-reminder: { id } → 取消指定提醒（set-reminder句柄的配套）
  'cancel-reminder': async ({ id }) => {
    const ok = reminderManager.cancel(String(id || ''));
    if (!ok) throw new Error(`提醒不存在或已触发: ${id}`);
    return { ok: true, message: `已取消提醒 ${id}` };
  },
  // type-text: { text, x?, y? } → 在指定坐标点击后键盘输入文本（Accessibility 事件）
  // 用途：主人说"在输入框里输入xx"——配合屏幕指挥的坐标，或直接打给当前焦点控件
  'type-text': async ({ text, x, y }) => {
    const t = String(text || '').slice(0, 500);
    if (!t) throw new Error('text 不能为空');
    const validCoord = (v) => typeof v === 'number' && v >= 0 && v <= 10000;
    const clickPart = (validCoord(x) && validCoord(y))
      ? `tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}
`
      : '';
    const esc = t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `${clickPart}tell application "System Events" to keystroke "${esc}"`;
    return await appleScript(script);
  },
  // click-at: { x, y } → 点击屏幕坐标（配合视觉定位的目标）
  'click-at': async ({ x, y }) => {
    const validCoord = (v) => typeof v === 'number' && v >= 0 && v <= 10000;
    if (!validCoord(x) || !validCoord(y)) throw new Error('x/y 需为 0-10000 的数字');
    return await appleScript(`tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}`);
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
  { type: 'function', function: { name: 'open-app', description: '打开macOS应用（如 Safari、WeChat），仅允许字母数字空格名称', parameters: { type: 'object', properties: { appName: { type: 'string', description: '应用名，如 "Safari"' } }, required: ['appName'] } } },
  { type: 'function', function: { name: 'list-dir', description: '列目录（最多50项含类型），仅允许 ~/Desktop ~/Documents ~/Downloads ~/WorkBuddy', parameters: { type: 'object', properties: { dirPath: { type: 'string', description: '目录路径，如 "~/Desktop"' } }, required: ['dirPath'] } } },
  { type: 'function', function: { name: 'set-reminder', description: '设置定时提醒（到点弹给主人）', parameters: { type: 'object', properties: { minutes: { type: 'number', description: '分钟数（0<x≤43200）' }, text: { type: 'string', description: '提醒内容' } }, required: ['minutes', 'text'] } } },
  { type: 'function', function: { name: 'cancel-reminder', description: '取消一个已设置的提醒', parameters: { type: 'object', properties: { id: { type: 'string', description: 'set-reminder返回的id' } } }, required: ['id'] } },
  { type: 'function', function: { name: 'type-text', description: '在屏幕指定坐标点击后键盘输入文本（macOS Accessibility）。用于"在输入框里输入xx"类指令；x/y 可选（不给则在当前焦点处输入）', parameters: { type: 'object', properties: { text: { type: 'string', description: '要输入的文本' }, x: { type: 'number', description: '目标输入框屏幕X坐标（视觉分析提供）' }, y: { type: 'number', description: '目标输入框屏幕Y坐标' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'click-at', description: '点击屏幕坐标（配合屏幕分析的目标位置执行点击，如关弹窗/按按钮）', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } },
];

// IPC入口

/** 应用名模糊匹配：中英/简称 → macOS 真实应用名
 * 词典覆盖常见中文名；目录扫描兜底相似度匹配 */
const APP_ALIAS = {
  '酷狗': 'KugouMusic', 'kugou': 'KugouMusic', '酷我': 'KuwoMusic', 'kuwo': 'KuwoMusic',
  '网易云': 'NeteaseMusic', '网易云音乐': 'NeteaseMusic', 'netease': 'NeteaseMusic',
  'qq音乐': 'QQMusic', 'QQ音乐': 'QQMusic', 'qqmusic': 'QQMusic',
  '微信': 'WeChat', 'wechat': 'WeChat', 'weixin': 'WeChat',
  '访达': 'Finder', 'finder': 'Finder', '备忘录': 'Notes', 'notes': 'Notes',
  '日历': 'Calendar', 'calendar': 'Calendar', '计算器': 'Calculator', 'calculator': 'Calculator',
  '浏览器': 'Safari', 'safari': 'Safari', '音乐': 'Music', '终端': 'Terminal', 'terminal': 'Terminal',
  '邮件': 'Mail', '地图': 'Maps', '照片': 'Photos', '设置': 'System Settings',
};
function fuzzyFindApp(name) {
  const n = String(name).trim();
  // 1) 别名词典
  const lower = n.toLowerCase();
  for (const [k, v] of Object.entries(APP_ALIAS)) {
    if (lower === k.toLowerCase() || lower === v.toLowerCase()) return v;
  }
  // 1.5) 别名包含匹配：'酷狗音乐'→含'酷狗'、'网易云音乐'→含'网易云'
  for (const [k, v] of Object.entries(APP_ALIAS)) {
    if (k.length >= 2 && lower.includes(k.toLowerCase())) return v;
  }
  // 2) 目录扫描：包含匹配（KuGou → KugouMusic）
  try {
    const dirs = IS_WIN
      ? [path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs')]
      : ['/Applications', require('os').homedir() + '/Applications'];
    for (const dir of dirs) {
      const apps = fs.readdirSync(dir).filter(a => a.endsWith('.app') || (IS_WIN && a.endsWith('.lnk')));
      for (const a of apps) {
        const base = a.replace(/\.(app|lnk)$/, '');
        if (base.toLowerCase().includes(lower) || lower.includes(base.toLowerCase().split(' ')[0])) return base;
      }
    }
  } catch { /* ignore */ }
  return null;
}

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

module.exports = { initToolsIPC, TOOL_SPECS, isValidAppName, resolveAllowedDir, createReminderManager };