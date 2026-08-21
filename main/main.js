// 桌面AI搭档 - Electron主进程入口
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { initTray } = require('./tray');
const { initToolsIPC } = require('./tools');
const { initEdgeTTSIPC } = require('./edgetts');
const { initDoubaoIPC } = require('./doubao');
const { initAvatarIPC } = require('./avatar');

let mainWindow = null;
let settingsWindow = null;

// userData指向项目内data/目录（契约约定），避免写系统位置；嵌套环境下Chromium沙箱不可用
const userDataDir = path.join(__dirname, '..', 'data', 'electron');
fs.mkdirSync(userDataDir, { recursive: true });
app.setPath('userData', userDataDir);
// 用户自建角色图片目录（角色工坊）：data/characters/{id}/normal.png
const charactersDir = path.join(__dirname, '..', 'data', 'characters');
fs.mkdirSync(charactersDir, { recursive: true });
// FIXME(生产环境移除): --no-sandbox 仅因当前嵌套开发环境（容器/宿主沙箱）下Chromium沙箱
// 初始化失败（"sandbox initialization failed: Operation not permitted"）而启用。
// 打包发布前应删除此行并验证沙箱可用（macOS 直接可跑；Linux 打包需内核支持 user namespaces）。
app.commandLine.appendSwitch('no-sandbox');
// 字体光栅化崩溃规避：Chromium fontations（Rust 字体栈）已知上游 bug
// （googlefonts/fontations#1524：skrifa 解析特定字体时 SIGSEGV）。
// 崩溃栈伴随 SharedImageManager GPU 纹理错误 → 禁 GPU 合成走 CPU 路径 +
// 关闭 fontations 相关 feature（Chromium 120 已默认启用部分 Rust 字体路径）。
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-font-subpixel-positioning');
app.commandLine.appendSwitch('disable-lcd-text');
app.commandLine.appendSwitch('disable-features', 'Fontations,FontationsWebFontParsing,CanvasOopRasterization');

function createMainWindow() {
  // 全屏透明窗口：宠物可在整个桌面漫游（豆宝宝效果）
  // 点击穿透由渲染进程通过 windowAPI.setMouseIgnore 动态控制（宠物本体可交互，其余区域穿透）
  const { workArea } = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // ⚠️ 禁后台节流：透明置顶窗常无焦点，macOS 会 App Nap 冻结渲染进程 →
      // AudioContext 时钟停走 → 流式音频包积压 → 恢复瞬间集中爆发 = 语音叠加！
      backgroundThrottling: false
    }
  });
  // 初始整个窗口点击穿透；渲染进程检测到鼠标在宠物上时关闭穿透
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // 置顶到最高层级（覆盖所有工作区）
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // PET_SELFTEST=1 时带查询参数加载（渲染进程 ?selftest=1 自动跑集成自检，配合PET_AUTOQUIT_MS截图）
  // PET_STUDIO_TEST=1 强制带 ?debug=1 以便截图核对切换状态
  const mainQuery = process.env.PET_SELFTEST
    ? { selftest: '1', debug: '1' }
    : process.env.PET_STUDIO_TEST
      ? { debug: '1' }
      : process.env.PET_BALL === '1'
        ? { ball: '1' }
        : undefined;
  mainWindow.loadFile(
    path.join(__dirname, '..', 'src', 'index.html'),
    mainQuery ? { query: mainQuery } : undefined,
  );

  // macOS: 放到屏幕右上角（留出边距）
  if (process.platform === 'darwin') {
    const { workArea } = screen.getPrimaryDisplay();
    const bounds = mainWindow.getBounds();
    mainWindow.setPosition(
      workArea.x + workArea.width - bounds.width - 20,
      workArea.y + 20
    );
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 自检截图：PET_ROAM_TEST=1 时到点 capturePage 保存（WebGL GPU 截图，绕过 toDataURL）
  if (process.env.PET_ROAM_TEST === '1') {
    setTimeout(async () => {
      try {
        const img = await mainWindow.webContents.capturePage();
        const out = path.join(__dirname, '..', 'data', 'electron', 'roam-test.png');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, img.toPNG());
        console.log('[roam-test] screenshot:', out, 'size=' + img.getSize().width + 'x' + img.getSize().height);
      } catch (e) { console.error('[roam-test] capture failed:', e.message); }
      app.quit();
    }, parseInt(process.env.PET_AUTOQUIT_MS || '12000', 10));
  }

  return mainWindow;
}

// ---------- 设置窗口（单例，有边框非透明） ----------
function createSettingsWindow(opts = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 500,
    height: 600,
    frame: true,
    transparent: false,
    resizable: true,
    title: '桌面AI搭档 - 设置',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  settingsWindow.loadFile(
    path.join(__dirname, '..', 'src', 'settings.html'),
    opts.query ? { query: opts.query } : undefined
  );
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

// ---------- IPC: 打开设置（渲染进程/托盘均可触发） ----------
ipcMain.handle('open-settings', () => {
  createSettingsWindow();
  return true;
});

// ---------- IPC: 设置更新中继（设置窗口 → 宠物主窗口） ----------
ipcMain.on('settings-updated', (_e, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-updated', payload);
  }
});

// ---------- IPC: 窗口拖动 ----------
// 渲染进程通过 mousedown/mousemove 把 screenX/screenY 传过来，主进程移动窗口
ipcMain.on('window-move', (event, { screenX, screenY }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const [winX, winY] = win.getPosition();
  // 首次触发时记录基准（在渲染进程侧管理基准点更简单，这里直接用增量逻辑）
  if (!win.__dragState) {
    win.__dragState = { lastX: screenX, lastY: screenY, winX, winY };
  }
  const st = win.__dragState;
  const dx = screenX - st.lastX;
  const dy = screenY - st.lastY;
  st.lastX = screenX;
  st.lastY = screenY;
  st.winX += dx;
  st.winY += dy;
  const b = win.getBounds(); // 复用一次getBounds（宽度高度在拖动中不变）
  win.setBounds({ x: Math.round(st.winX), y: Math.round(st.winY), width: b.width, height: b.height });
});

ipcMain.on('window-move-end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.__dragState = null;
});

// ---------- IPC: 点击穿透 ----------
ipcMain.handle('set-ignore-cursor', (event, ignore) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
  return true;
});

// ---------- IPC: 屏幕截图（全屏，返回base64 PNG） ----------
// displayIndex: 可选，显示器序号（desktopCapturer sources列表下标），默认0=主屏
ipcMain.handle('capture-screen', async (_event, displayIndex = 0) => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1280, height: 1280 } // 缩小尺寸，节省token
  });
  if (!sources.length) return null;
  const idx = Number.isInteger(displayIndex) && displayIndex >= 0 && displayIndex < sources.length
    ? displayIndex : 0; // 越界/非法回退主屏
  const thumb = sources[idx].thumbnail;
  if (thumb.isEmpty()) return null;
  // toDataURL => "data:image/png;base64,xxxx"，去掉前缀返回纯base64
  const dataUrl = thumb.toDataURL();
  return dataUrl.replace(/^data:image\/\w+;base64,/, '');
});

// ---------- IPC: 退出 ----------
ipcMain.handle('app-quit', () => {
  app.quit();
});

// ---------- IPC: 角色工坊（用户角色图片文件存取） ----------
// 角色id白名单：字母数字下划线连字符，防路径穿越
const safeCharacterId = (id) =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

// 'save-character-image' (id, base64) → 保存 data/characters/{id}/normal.png
ipcMain.handle('save-character-image', (_e, id, base64) => {
  if (!safeCharacterId(id) || typeof base64 !== 'string' || !base64) {
    return { ok: false, error: '参数非法' };
  }
  try {
    const dir = path.join(charactersDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'normal.png'), Buffer.from(base64, 'base64'));
    const rel = path.relative(path.join(__dirname, '..'), path.join(dir, 'normal.png'));
    return { ok: true, path: rel.split(path.sep).join('/') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 'delete-character-dir' (id) → 删除 data/characters/{id}/
ipcMain.handle('delete-character-dir', (_e, id) => {
  if (!safeCharacterId(id)) return { ok: false, error: '参数非法' };
  try {
    fs.rmSync(path.join(charactersDir, id), { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 'read-character-image' (relPath) → 读用户角色图片返回base64（仅允许 characters 目录内）
ipcMain.handle('read-character-image', (_e, relPath) => {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('..') || path.isAbsolute(relPath)) {
    return null;
  }
  const abs = path.resolve(__dirname, '..', relPath);
  if (!abs.startsWith(charactersDir + path.sep)) return null;
  try {
    return fs.readFileSync(abs).toString('base64');
  } catch {
    return null;
  }
});

// DUIX诊断：极简页面验证+写文件
if (process.env.PET_DIAG === '1') {
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 600, height: 400,
      webPreferences: {
        nodeIntegration: true, contextIsolation: false, nodeIntegrationInWorker: true, webSecurity: false,
      }
    });
    win.loadFile(path.join(__dirname, '..', 'test-diag.html'));
    setTimeout(() => app.quit(), parseInt(process.env.PET_AUTOQUIT_MS || '8000', 10));
  });
  return;
}

// DUIX数字人宠物模式（正式版）：透明窗+nodeIntegration（electron-duix要求）
if (process.env.PET_DUIX_PET === '1') {
  // 不禁硬件加速（SwiftShader WebGL黑屏），改非透明窗
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 420, height: 720,
      transparent: false, frame: false, resizable: false, alwaysOnTop: true,
      backgroundColor: '#000000',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        nodeIntegrationInWorker: true,
        webSecurity: false,
      }
    });
    win.loadFile(path.join(__dirname, '..', 'pet-duix.html'), { query: { v: String(Date.now()) } });
    win.setIgnoreMouseEvents(false);
    // 窗口拖拽
    ipcMain.on('pet-move-window', (e, sx, sy) => {
      try { win.setPosition(sx - 210, sy - 100); } catch (err) { /* ignore */ }
    });
    const quitAt = parseInt(process.env.PET_AUTOQUIT_MS || '0', 10);
    if (quitAt > 0) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const fs = require('fs');
          fs.mkdirSync(path.join(__dirname, '..', 'data/electron'), { recursive: true });
          fs.writeFileSync(path.join(__dirname, '..', 'data/electron/duix-pet.png'), img.toPNG());
          console.log('[verify] duix-pet screenshot saved');
        } catch (e) { console.error('[verify] capture failed:', e.message); }
        app.quit();
      }, quitAt);
    }
  });
  return;
}

// DUIX数字人测试模式：electron-duix 需要 nodeIntegration + webSecurity:false
if (process.env.PET_DUIX_TEST === '1') {
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 500, height: 860, backgroundColor: '#111111',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        nodeIntegrationInWorker: true,
        webSecurity: false,
      }
    });
    win.loadFile(path.join(__dirname, '..', 'test-duix.html'));
    const quitAt = parseInt(process.env.PET_AUTOQUIT_MS || '0', 10);
    if (quitAt > 0) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const fs = require('fs');
          fs.mkdirSync(path.join(__dirname, '..', 'data/electron'), { recursive: true });
          fs.writeFileSync(path.join(__dirname, '..', 'data/electron/duix-test.png'), img.toPNG());
          console.log('[verify] duix-test screenshot saved');
        } catch (e) { console.error('[verify] capture failed:', e.message); }
        app.quit();
      }, quitAt);
    }
  });
  return;
}

// 临时视频演示模式：直接 file:// 加载 demo-v2.html（不依赖 HTTP server）
if (process.env.PET_VIDEO_DEMO === '1') {
  app.whenReady().then(() => {
    const win = new BrowserWindow({
      width: 900, height: 1100, backgroundColor: '#000000',
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
    });
    win.loadFile(path.join(__dirname, '..', 'demo-v2.html'));
    // PET_AUTOQUIT_MS=0 或未设 → 不退出，让用户自己看
    const quitAt = parseInt(process.env.PET_AUTOQUIT_MS || '0', 10);
    if (quitAt > 0) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const fs = require('fs');
          fs.mkdirSync(path.join(__dirname, '..', 'data/electron'), { recursive: true });
          fs.writeFileSync(path.join(__dirname, '..', 'data/electron/video-test.png'), img.toPNG());
          console.log('[verify] video-test screenshot saved');
        } catch (e) { console.error('[verify] capture failed:', e.message); }
        app.quit();
      }, quitAt);
    }
  });
  return;
}

app.whenReady().then(() => {
  // 麦克风权限：语音对话（getUserMedia/SpeechRecognition）需要 media 授权。
  // Electron 默认拒绝权限请求 → 必须显式放行，否则渲染进程收不到麦克风。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  createMainWindow();

  // 渲染进程崩溃自愈：Chromium 底层 bug（字体/GPU）偶发 SIGSEGV 时
  // 自动重建窗口，宠物"复活"而不是留下透明僵尸窗口
  app.on('render-process-gone', (_e, _webContents, details) => {
    console.error('[main] renderer 崩溃:', details?.reason, '| 正在重启窗口…');
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    } catch { /* ignore */ }
    mainWindow = null;
    // 崩溃往往是 GPU 状态污染，稍等片刻再重建
    setTimeout(() => {
      try { createMainWindow(); } catch (e) { console.error('[main] 重建失败:', e.message); }
    }, 800);
  });

  // 系统托盘（传入主窗口getter与打开设置回调）
  initToolsIPC(ipcMain, (msg) => console.log(msg)); // 小球Agent工具层
  initEdgeTTSIPC(ipcMain); // Edge TTS（甜美真人音色）
  initDoubaoIPC(ipcMain); // 豆包端到端实时语音（低延迟流式对话）
  initAvatarIPC(ipcMain); // 火山实时互动数字人（FlowAct-R1）
  initTray(() => mainWindow, {
    onOpenSettings: createSettingsWindow
  });

  // 全局快捷键：⌘⇧Space（CmdOrCtrl+Shift+Space）切换语音对话——免找左下角小按钮
  try {
    const { globalShortcut } = require('electron');
    const ret = globalShortcut.register('CommandOrControl+Shift+Space', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voice-toggle');
      }
    });
    if (!ret) console.warn('[main] 语音快捷键注册失败（可能被占用）');
    app.on('will-quit', () => globalShortcut.unregisterAll());
  } catch (e) { console.warn('[main] globalShortcut 不可用:', e.message); }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  // 验证钩子：PET_AUTOQUIT_MS=5000 npm start 可自动退出（用于无头验证）
  if (process.env.PET_AUTOQUIT_MS) {
    // PET_TEST_SETTINGS=1 时同时打开设置窗口验证渲染
    if (process.env.PET_TEST_SETTINGS) createSettingsWindow();
    // PET_STUDIO_TEST=1 时打开设置窗口并自动跑角色工坊mock流程（建角色→切换→截图）
    if (process.env.PET_STUDIO_TEST) createSettingsWindow({ query: { automock: '1' } });
    const ms = parseInt(process.env.PET_AUTOQUIT_MS, 10) || 5000;
    // 退出前抓取窗口画面存盘，验证渲染内容
    setTimeout(async () => {
      try {
        for (const [name, win] of [['window', mainWindow], ['settings', settingsWindow]]) {
          if (win && !win.isDestroyed()) {
            const img = await win.webContents.capturePage();
            if (!img.isEmpty()) {
              const out = path.join(userDataDir, `${name}-test.png`);
              fs.writeFileSync(out, img.toPNG());
              console.log(`[verify] ${name} screenshot saved: ${out} (${img.getSize().width}x${img.getSize().height})`);
            } else {
              console.log(`[verify] ${name} capturePage returned empty`);
            }
          }
        }
      } catch (e) {
        console.error('[verify] capture failed:', e.message);
      }
      app.quit();
    }, ms - 1500 > 0 ? ms - 1500 : ms);
    setTimeout(() => app.quit(), ms);
  }
});

// 有托盘常驻：窗口全部关闭不退出（退出走托盘菜单/IPC）
app.on('window-all-closed', () => {
  // 空实现：托盘持有生命周期
});
