// ============================================================
// digitalhuman.js — 数字人引擎抽象层（接口预留，不实现）
//
// 为下一阶段接入真 3D/视频数字人引擎预留的插槽：
//   - local：LiveTalking（本地 Wav2Lip/ER-NeRF 类实时口型驱动）
//   - cloud：硅基DUIX（云端 SDK 渲染推流）
//   - off  ：关闭（当前默认，仅用 sprite 立绘 + 程序化口型）
//
// 配置：localStorage 'pet-dh-config'
//   { mode: 'local' | 'cloud' | 'off', endpoint: string }
//
// 初始化时 index.html 读取配置，mode !== 'off' 打 TODO 日志。
// ============================================================

const DH_CONFIG_KEY = 'pet-dh-config';

const DEFAULT_DH_CONFIG = {
  mode: 'off',     // off=关闭 | local=LiveTalking 本地引擎 | cloud=云端引擎（硅基DUIX等）
  endpoint: '',    // local: 服务地址（如 http://127.0.0.1:8000）| cloud: SDK endpoint
};

const readConfig = (storage) => {
  try {
    const raw = storage && storage.getItem(DH_CONFIG_KEY);
    return raw ? { ...DEFAULT_DH_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_DH_CONFIG };
  } catch {
    return { ...DEFAULT_DH_CONFIG };
  }
};

/**
 * DigitalHumanEngine — 数字人引擎抽象基类
 *
 * 接口约定（未来实现 LiveTalkingEngine / CloudDHEngine 时落地）：
 *   await engine.connect(config)   建立连接/加载模型（local: HTTP/WS；cloud: SDK 鉴权）
 *   await engine.speak(text)       文本 → TTS 音频 → 实时口型帧数据（onFrame 回调吐帧）
 *   engine.onFrame(cb)             注册帧回调：cb({videoFrame|texture, timestamp})
 *   await engine.disconnect()      断开并释放资源
 */
class DigitalHumanEngine {
  /**
   * @param {object} [opts]
   *   opts.storage: 持久化对象（默认 localStorage，测试可注入）
   */
  constructor(opts = {}) {
    this.storage = opts.storage
      || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.config = readConfig(this.storage);
    this.connected = false;
    this._frameCallbacks = [];
  }

  /** 读取持久化配置（静态工具：初始化探测用） */
  static loadConfig(storage) {
    return readConfig(
      storage || (typeof localStorage !== 'undefined' ? localStorage : null),
    );
  }

  // ---------- 接口（抽象，子类实现） ----------

  /**
   * 连接数字人引擎
   * TODO(local): LiveTalking —— POST {endpoint}/humans 加载模型，
   *   WS {endpoint}/ws_stream 建立实时驱动通道，audio chunk 驱动口型。
   * TODO(cloud): 硅基DUIX —— 初始化 SDK、鉴权、拉起云端渲染实例。
   * @param {object} [_config] 覆盖构造时的配置
   */
  async connect(_config) { // eslint-disable-line no-unused-vars
    throw new Error('[DigitalHumanEngine] connect() 未实现（预留接口）');
  }

  /**
   * 实时驱动说话：文本/音频 → 口型帧（经 onFrame 回调输出）
   * TODO: 接入后 pet.js 的 voiceChat 将用 engine.speak 替换
   *   voice.speak + live2d.lipSpeak 的程序化口型组合。
   */
  async speak(_text) { // eslint-disable-line no-unused-vars
    throw new Error('[DigitalHumanEngine] speak() 未实现（预留接口）');
  }

  /** 注册帧回调：cb({ videoFrame?, texture?, timestamp }) */
  onFrame(cb) {
    if (typeof cb === 'function') this._frameCallbacks.push(cb);
  }

  /** 断开连接并释放资源 */
  async disconnect() {
    this.connected = false;
    this._frameCallbacks = [];
  }

  // ---------- 内部 ----------

  _emitFrame(payload) {
    for (const cb of this._frameCallbacks) {
      try { cb(payload); } catch (err) { console.error('[DigitalHumanEngine] onFrame 回调异常', err); }
    }
  }
}

export default DigitalHumanEngine;
export { DigitalHumanEngine, DH_CONFIG_KEY, DEFAULT_DH_CONFIG };
