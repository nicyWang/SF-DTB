// 桌面AI搭档 - preload脚本：contextBridge暴露渲染进程API
const { contextBridge, ipcRenderer } = require('electron');

// ---- 简易EventEmitter实现（避免依赖Node内置events模块） ----
class SimpleEventEmitter {
  constructor() {
    this._listeners = new Map();
  }
  on(event, fn) {
    if (typeof fn !== 'function') return this;
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }
  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
    return this;
  }
  removeListener(event, fn) { return this.off(event, fn); }
  once(event, fn) {
    const wrap = (...args) => { this.off(event, wrap); fn(...args); };
    return this.on(event, wrap);
  }
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (set) for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error(`[PetEvents] listener error on "${event}":`, e); }
    }
    return true;
  }
  listenerCount(event) {
    return this._listeners.has(event) ? this._listeners.get(event).size : 0;
  }
}

// 全局事件总线实例（契约：window.PetEvents）
const petEvents = new SimpleEventEmitter();

// ---- 暴露到渲染进程 ----
// 注意1：contextBridge 只暴露对象的自有属性，不代理原型方法 ——
//        直接 expose 类实例会丢失 on/off/emit，必须包装成扁平函数对象。
// 注意2：包装函数不能返回 emitter 实例（含 Map，不可结构化克隆），
//        返回值仅限可克隆的基本值。
contextBridge.exposeInMainWorld('PetEvents', {
  on: (event, fn) => { petEvents.on(event, fn); },
  off: (event, fn) => { petEvents.off(event, fn); },
  once: (event, fn) => { petEvents.once(event, fn); },
  removeListener: (event, fn) => { petEvents.removeListener(event, fn); },
  emit: (event, ...args) => petEvents.emit(event, ...args),
  listenerCount: (event) => petEvents.listenerCount(event),
});

// 主进程 → 渲染进程：托盘"暂停/恢复屏幕感知"桥接为全局事件 'perception:paused'
ipcRenderer.on('perception-toggle', (_e, { paused } = {}) => {
  petEvents.emit('perception:paused', { paused });
});

// 主进程 → 渲染进程：托盘/设置触发的角色切换桥接为 PetEvents 'character:switch'
ipcRenderer.on('character-switch', (_e, { characterId } = {}) => {
  petEvents.emit('character:switch', { characterId });
});

// 主进程 → 渲染进程：设置窗口保存后中继的 'settings:updated'
ipcRenderer.on('settings-updated', (_e, payload) => {
  petEvents.emit('settings:updated', payload || {});
});

// 主进程 → 渲染进程：全局快捷键 ⌘⇧Space 触发语音对话开关
ipcRenderer.on('voice-toggle', () => {
  petEvents.emit('voice:toggle');
});

contextBridge.exposeInMainWorld('windowAPI', {
  // 打开开发者控制台（右键菜单入口）
  openDevtools() { try { ipcRenderer.send('pet-open-devtools'); } catch (e) {} },
  // 拖动窗口：渲染进程在mousedown/mousemove中调用，传event.screenX/screenY
  moveWindow(screenX, screenY) {
    ipcRenderer.send('window-move', { screenX, screenY });
  },
  moveWindowEnd() {
    ipcRenderer.send('window-move-end');
  },
  // 点击穿透：true=鼠标事件穿透窗口，false=恢复交互
  async setIgnoreCursor(ignore) {
    return await ipcRenderer.invoke('set-ignore-cursor', ignore);
  },
  quit() {
    ipcRenderer.invoke('app-quit');
  },
  // 小球Agent工具调用：name=工具名, args=参数对象 → {ok, result|error}
  async invokeTool(name, args) {
    return await ipcRenderer.invoke('tool-invoke', name, args || {});
  },
  // 打开设置窗口（单例，托盘/渲染进程均可触发）
  async openSettings() {
    return await ipcRenderer.invoke('open-settings');
  },
  // 感知暂停状态同步到托盘菜单（双向同步的渲染→托盘方向）
  async setPerceptionPaused(paused) {
    return await ipcRenderer.invoke('perception-status', paused);
  },
  // 设置窗口保存后通知主进程 → 宠物主窗口（PetEvents 'settings:updated'）
  notifySettingsUpdated(scope) {
    ipcRenderer.send('settings-updated', { scope: scope || [] });
  },
  // 角色切换：渲染进程（设置面板/初始化）→ 主进程 → 广播 'character-switch' 给所有窗口
  // syncOnly=true 时只同步托盘菜单 ✓（不开广播），用于初始化阶段避免回环
  // label: 可选角色显示名（用户自建角色传名字，供托盘菜单动态注册）
  switchCharacter(characterId, syncOnly = false, label = null) {
    if (syncOnly) {
      ipcRenderer.send('set-active-character', characterId, label);
    } else {
      ipcRenderer.send('switch-character', characterId, label);
    }
  },
});

// 角色工坊：用户角色图片文件 IPC（data/characters/{id}/normal.png）
contextBridge.exposeInMainWorld('characterAPI', {
  // (id, base64) → {ok, path} 保存角色主图
  async saveImage(id, base64) {
    return await ipcRenderer.invoke('save-character-image', id, base64);
  },
  // (id) → {ok} 删除角色图片目录
  async deleteDir(id) {
    return await ipcRenderer.invoke('delete-character-dir', id);
  },
  // (relPath) → 纯base64 | null 读取用户角色图片
  async readImage(relPath) {
    return await ipcRenderer.invoke('read-character-image', relPath);
  },
});

contextBridge.exposeInMainWorld('screenAPI', {
  // 截取全屏，返回纯base64 PNG（无data:前缀）
  // displayIndex: 可选显示器序号（默认0=主屏，越界回退主屏）
  async getScreenshot(displayIndex) {
    return await ipcRenderer.invoke('capture-screen', displayIndex);
  }
});

// 豆包端到端实时语音：主进程 WS 网关的渲染进程接口
// ⚠️ 监听器单例管理：contextBridge 代理会改变 fn 引用，removeListener(fn)
// 永远匹配不到 → 每轮开关泄漏 1 个监听器 → 音频 N 倍投递（语音叠加真凶）。
// 用模块级闭包持有 handler，on 时先移除旧的，保证任意时刻至多 1 个。
let __dbEvHandler = null;
let __dbAuHandler = null;
contextBridge.exposeInMainWorld('doubaoAPI', {
  // (cfg) → {ok} | {ok:false, error} 建连+开会话
  async start(cfg) {
    return await ipcRenderer.invoke('doubao-start', cfg);
  },
  async stop() {
    return await ipcRenderer.invoke('doubao-stop');
  },
  // 麦克风 PCM16k（ArrayBuffer）
  sendAudio(buf) {
    ipcRenderer.send('doubao-audio-in', buf);
  },
  // 豆包代播文本（工具结果门面统一：豆包音色直接TTS）
  say(text) { ipcRenderer.send('doubao-say', text); },
  // 服务端事件（user-speech-start/user-text/tts-start/reply-text/...）
  onEvent(fn) {
    if (__dbEvHandler) ipcRenderer.removeListener('doubao-event', __dbEvHandler);
    __dbEvHandler = fn;
    ipcRenderer.on('doubao-event', fn);
  },
  offEvent() {
    if (__dbEvHandler) { ipcRenderer.removeListener('doubao-event', __dbEvHandler); __dbEvHandler = null; }
  },
  // 服务端音频（PCM 24k Buffer→Uint8Array）—— 同款单例管理
  onAudio(fn) {
    if (__dbAuHandler) ipcRenderer.removeListener('doubao-audio', __dbAuHandler);
    __dbAuHandler = fn;
    ipcRenderer.on('doubao-audio', fn);
  },
  offAudio() {
    if (__dbAuHandler) { ipcRenderer.removeListener('doubao-audio', __dbAuHandler); __dbAuHandler = null; }
  }
});

// Edge TTS：微软神经网络语音（免费、甜美真人音色）
contextBridge.exposeInMainWorld('ttsAPI', {
  // {text, voice, rate, pitch} → {ok, audioBase64} | {ok:false, error}
  async synth(payload) {
    return await ipcRenderer.invoke('edge-tts-synth', payload || {});
  },
  // 合成 + 主进程 afplay 播放（绕开 renderer audio 解码问题）→ {ok, played, interrupted, estMs}
  async play(payload) {
    return await ipcRenderer.invoke('edge-tts-play', payload || {});
  },
  // 停止当前播放（语音打断：用户插嘴 → 立即闭嘴）
  async stop() {
    return await ipcRenderer.invoke('edge-tts-stop');
  },
  // 可用音色列表
  async voices() {
    return await ipcRenderer.invoke('edge-tts-voices');
  },
});

// 火山实时数字人（FlowAct-R1）：主进程网关接口（单例 handler，防 contextBridge 引用泄漏）
let __avEvHandler = null;
contextBridge.exposeInMainWorld('avatarAPI', {
  async start(cfg) {
    return await ipcRenderer.invoke('avatar-start', cfg);
  },
  async stop() {
    return await ipcRenderer.invoke('avatar-stop');
  },
  sendAudio(buf) { ipcRenderer.send('avatar-audio-in', buf); },
  sendAudioEnd() { ipcRenderer.send('avatar-audio-end'); },
  onEvent(fn) {
    if (__avEvHandler) ipcRenderer.removeListener('avatar-event', __avEvHandler);
    __avEvHandler = fn;
    ipcRenderer.on('avatar-event', fn);
  },
  offEvent() {
    if (__avEvHandler) { ipcRenderer.removeListener('avatar-event', __avEvHandler); __avEvHandler = null; }
  },
});
