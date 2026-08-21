/**
 * DouyinSource — 抖音直播弹幕源
 *
 * == 实现策略 ==
 * 抖音网页版弹幕协议（wss://webcast*-ws-web-*.douyin.com/webcast/im/push/v2/）
 * 存在两大浏览器端不可逾越的障碍：
 *   1. 签名（signature）依赖抖音的 Acrawler 算法（sign.js，混淆 JS），
 *      且获取 ttwid / room_id 需要带特定 Cookie 请求 live.douyin.com —— 渲染进程
 *      受 CORS 限制无法完成这些 HTTP 请求。
 *   2. 消息体为 Protobuf 二进制 + gzip，虽可在前端解析，但连接建立已被 1 阻断。
 *
 * 因此采用「主进程桥接（bridge）」模式：
 *   - 渲染进程（本文件）只负责：调用 bridge 与主进程通信、把主进程回推的
 *     结构化事件转成统一的 EventEmitter 事件。
 *   - Electron 主进程负责：获取 ttwid/room_id、计算签名、建立 WebSocket、
 *     心跳/ACK、protobuf 解析（协议要点见同目录 douyin-protocol.md，
 *     主进程实现于集成阶段完成）。
 *
 * == Bridge 接口约定 ==
 * bridge 是一个 async 函数：async (action, payload) => any
 *   action: 'connect'    payload: {roomUrl}   → {ok:true, roomId} | 抛错/返回 {ok:false, error}
 *   action: 'disconnect' payload: {}           → {ok:true}
 *   action: 'onEvent'    payload: (event)=>{}  → 注册事件回调（主进程持续调用）
 *        event: {kind:'message'|'gift'|'enter'|'follow'|'notice',
 *                user?, text?, gift?, count?, raw?}
 *
 * preload 侧典型暴露方式（集成阶段实现）：
 *   contextBridge.exposeInMainWorld('douyinBridge', (action, payload) =>
 *     ipcRenderer.invoke('douyin-bridge', action, payload));
 * 注意：若 onEvent 回调需要跨 contextBridge 传函数，preload 需额外用
 * ipcRenderer.on('douyin-event', ...) 转发（contextBridge 不能直接传函数回调时）。
 *
 * == 降级 ==
 * 无 bridge / bridge 未实现 / 连接失败时：start() 抛出
 *   Error('douyin source requires main-process bridge: ...')
 * 由 danmaku.js 统一捕获并自动 fallback 到 mock 源。
 */

import { EventEmitter } from '../danmaku.js';

export class DouyinSource extends EventEmitter {
  constructor() {
    super();
    this.type = 'douyin';
    /** @type {Function|null} 主进程桥接函数 */
    this._bridge = null;
    /** @type {Function|null} 注册到 bridge 的事件回调 */
    this._eventHandler = null;
    this._running = false;
  }

  /** 注入 bridge（由 DanmakuService.setBridge 转发而来） */
  setBridge(fn) {
    // bridge 变更时若在运行，需先断开旧连接
    if (this._running && this._bridge) {
      this._callBridge('disconnect', {}).catch(() => {});
    }
    this._bridge = typeof fn === 'function' ? fn : null;
  }

  /**
   * 连接抖音直播间。
   * @param {object} config {type:'douyin', roomUrl}
   */
  async start(config = {}) {
    if (this._running) return;

    const roomUrl = config.roomUrl || '';
    if (!roomUrl || !/live\.douyin\.com/i.test(roomUrl)) {
      throw new Error('douyin source: invalid roomUrl, expect https://live.douyin.com/<roomId>');
    }
    if (!this._bridge) {
      // 核心降级路径：无主进程桥接，纯浏览器无法实现（签名+CORS），见文件头说明
      throw new Error('douyin source requires main-process bridge (signature & CORS, see douyin-protocol.md)');
    }

    // 注册事件回调：主进程把解析好的结构化事件推回来
    this._eventHandler = (event) => this._handleBridgeEvent(event);
    try {
      await this._callBridge('onEvent', this._eventHandler);
    } catch (err) {
      throw new Error(`douyin source requires main-process bridge: onEvent failed (${err.message})`);
    }

    // 发起连接
    let result;
    try {
      result = await this._callBridge('connect', { roomUrl });
    } catch (err) {
      throw new Error(`douyin bridge connect failed: ${err.message}`);
    }
    if (!result || result.ok === false) {
      const reason = (result && result.error) || 'bridge returned no ok';
      throw new Error(`douyin bridge connect failed: ${reason}`);
    }

    this._running = true;
    this.emit('status', {
      connected: true,
      source: 'douyin',
      roomId: result.roomId,
      note: result.implemented === false ? 'bridge connected (protocol stub)' : undefined,
    });
  }

  /** 断开连接 */
  async stop() {
    if (this._eventHandler) {
      try {
        await this._callBridge('offEvent', this._eventHandler);
      } catch { /* 主进程侧清理失败不影响本地停止 */ }
      this._eventHandler = null;
    }
    if (this._running && this._bridge) {
      try {
        await this._callBridge('disconnect', {});
      } catch { /* 忽略 */ }
    }
    this._running = false;
    this.emit('status', { connected: false, source: 'douyin' });
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  async _callBridge(action, payload) {
    return this._bridge(action, payload);
  }

  /** 把主进程回推的结构化事件分发为统一事件 */
  _handleBridgeEvent(event) {
    if (!event || !event.kind) return;
    switch (event.kind) {
      case 'message':
        this.emit('message', { user: event.user, text: event.text });
        break;
      case 'gift':
        this.emit('gift', {
          user: event.user,
          gift: event.gift || '未知礼物',
          count: event.count || 1,
        });
        break;
      case 'enter':
        this.emit('enter', { user: event.user });
        break;
      case 'follow':
        this.emit('follow', { user: event.user });
        break;
      case 'notice':
        // 房间状态类通知（下播、断线等）——归入 status
        this.emit('status', {
          connected: event.connected !== false,
          source: 'douyin',
          note: event.text,
        });
        break;
      default:
        // 未知事件类型：带 raw 透传到 status，便于调试与扩展
        this.emit('status', { connected: true, source: 'douyin', note: `unknown kind: ${event.kind}`, raw: event.raw });
    }
  }
}

export default DouyinSource;
