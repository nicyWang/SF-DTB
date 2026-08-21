// ============================================================
// tray.js — 系统托盘（主进程）
// 菜单：暂停屏幕感知(✓状态) / 切换角色(子菜单带✓) / 显示/隐藏宠物 / 打开设置 / 退出
// 感知状态双向：托盘点击 → 渲染进程；渲染进程 IPC 'perception-status' → 托盘✓
// 角色状态双向：托盘子菜单 → 渲染进程；渲染进程 IPC 'set-active-character' → 托盘✓
// ============================================================
const { Tray, Menu, nativeImage, app, ipcMain } = require('electron');
const zlib = require('zlib');

// 托盘状态（模块内维护，供菜单渲染）
const state = {
  perceptionPaused: false,
  activeCharacter: 'handsome', // 当前活动角色（默认帅哥，向后兼容）
};

// 角色标签表：内置 + 运行时动态注册（角色工坊的用户自建角色）
const characterLabels = {
  handsome: '凌川（帅哥）',
  beauty: '苏晚（美女）',
};

// 注册/更新角色显示名（用户角色由设置面板在切换/同步时上报）
function registerCharacterLabel(id, label) {
  if (typeof id !== 'string' || !id) return;
  const clean = typeof label === 'string' && label.trim() ? label.trim().slice(0, 30) : null;
  if (clean) characterLabels[id] = clean;
  else if (!characterLabels[id]) characterLabels[id] = id; // 未知角色至少能显示id
}

// 生成一个16x16纯色圆点PNG作为临时托盘图标（后续换正式图标）
function createTrayIcon() {
  const size = 16;
  return nativeImage.createFromBuffer(makeSolidPng(size, 80, 140, 255, 255), { width: size, height: size });
}

// 极简PNG编码器：16x16圆形遮罩RGBA，zlib deflate压缩IDAT
function makeSolidPng(size, r, g, b, a) {
  const CRC_TABLE = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // 带圆角遮罩的原始像素（filter byte 0 + RGBA per pixel）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let off = 0;
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    raw[off++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // 圆形遮罩（托盘小图标显示为圆点更美观）
      const dx = x - half + 0.5, dy = y - half + 0.5;
      const inside = dx * dx + dy * dy <= half * half;
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
      raw[off++] = inside ? a : 0;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG签名
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

let tray = null;
let getMainWindow = null; // () => BrowserWindow|null
const callbacks = {};     // { onOpenSettings }

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: state.perceptionPaused ? '恢复屏幕感知' : '暂停屏幕感知',
      type: 'checkbox',
      checked: state.perceptionPaused,
      click(item) {
        setPerceptionPaused(item.checked, { broadcast: true });
      }
    },
    { type: 'separator' },
    {
      label: '切换角色',
      submenu: Object.entries(characterLabels).map(([id, label]) => ({
        label,
        type: 'checkbox',
        checked: state.activeCharacter === id,
        click() { switchCharacter(id); },
      })),
    },
    { type: 'separator' },
    {
      label: '显示/隐藏宠物',
      click() {
        const win = getMainWindow && getMainWindow();
        if (!win || win.isDestroyed()) return;
        if (win.isVisible()) win.hide();
        else win.show();
      }
    },
    {
      label: '打开设置',
      click() {
        if (callbacks.onOpenSettings) callbacks.onOpenSettings();
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click() {
        app.quit();
      }
    }
  ]);
}

// 切换角色：托盘子菜单或渲染进程 IPC 触发；同步更新菜单 + 广播给所有渲染进程
// label: 可选显示名（用户角色首次出现时动态注册进菜单）
function switchCharacter(characterId, label) {
  if (typeof characterId !== 'string' || !characterId) return;
  if (label || !characterLabels[characterId]) registerCharacterLabel(characterId, label);
  if (state.activeCharacter === characterId) return;
  state.activeCharacter = characterId;
  if (tray) tray.setContextMenu(buildMenu());
  // 通知所有 BrowserWindow（主窗口 + 设置窗口）
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('character-switch', { characterId });
    }
  }
}

// 渲染进程通知主进程：本地状态已切到 characterId（不开广播，避免回环）
function setActiveCharacter(characterId, label) {
  if (typeof characterId !== 'string' || !characterId) return;
  if (label || !characterLabels[characterId]) registerCharacterLabel(characterId, label);
  if (state.activeCharacter === characterId) return;
  state.activeCharacter = characterId;
  if (tray) tray.setContextMenu(buildMenu());
}

// 更新感知暂停状态；broadcast=true时通知渲染进程
function setPerceptionPaused(paused, { broadcast = false } = {}) {
  state.perceptionPaused = !!paused;
  if (tray) tray.setContextMenu(buildMenu());
  if (broadcast) {
    const win = getMainWindow && getMainWindow();
    if (win && !win.isDestroyed()) {
      // 渲染进程preload把此IPC桥接为PetEvents事件 'perception:paused'
      win.webContents.send('perception-toggle', { paused: state.perceptionPaused });
    }
  }
}

function initTray(getWindow, opts = {}) {
  getMainWindow = getWindow;
  Object.assign(callbacks, opts); // { onOpenSettings() }
  tray = new Tray(createTrayIcon());
  tray.setToolTip('桌面AI搭档');
  tray.setContextMenu(buildMenu());

  // 渲染进程 → 托盘：状态变化（双向同步）
  ipcMain.handle('perception-status', (event, paused) => {
    setPerceptionPaused(paused, { broadcast: false }); // 只更新菜单✓，不回发避免回环
    return state.perceptionPaused;
  });

  // 渲染进程 → 托盘：主动通知当前角色（不开广播，避免回环）；label 供用户角色动态注册
  ipcMain.on('set-active-character', (_event, characterId, label) => {
    setActiveCharacter(characterId, label);
  });

  // 渲染进程请求切换角色（开广播，等同于托盘子菜单点击）
  ipcMain.on('switch-character', (_event, characterId, label) => {
    switchCharacter(characterId, label);
  });

  return tray;
}

module.exports = { initTray, setPerceptionPaused, switchCharacter, setActiveCharacter };
