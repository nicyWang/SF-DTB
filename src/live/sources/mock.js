/**
 * MockSource — 模拟弹幕源（开发/测试用）
 *
 * 两种工作模式：
 *  1. 随机模式（默认）：每 3~8 秒随机发一条 message；低概率触发 gift/enter/follow
 *  2. 剧本模式：传入 script 数组按序播放，用于测试特定场景
 *
 * 配置：
 *  {
 *    type: 'mock',
 *    interval?: [minMs, maxMs]        // 随机模式间隔范围，默认 [3000, 8000]
 *    script?: Array<{type, user?, text?, gift?, count?, delay?}>  // 剧本
 *    loop?: boolean                    // 剧本播完后是否循环（默认 false，播完停止）
 *    afterScript?: 'random'|'stop'     // 剧本播完后行为（loop=true 时忽略），默认 stop
 *  }
 *
 * emit 事件：
 *  'message' {user, text}
 *  'gift'    {user, gift, count}
 *  'enter'   {user}
 *  'follow'  {user}
 *  'status'  {connected, source:'mock', error?}
 */

import { EventEmitter } from '../danmaku.js';

// ---------------------------------------------------------------------------
// 内置数据池
// ---------------------------------------------------------------------------

/** 常见弹幕池（30+ 条：打招呼/夸主播/点歌/问问题/催更等） */
const DANMAKU_POOL = [
  // 打招呼
  '主播好呀~',
  '大家好，我是新来的',
  '晚上好！',
  '来了来了',
  '刚下播就赶过来了',
  'hi~ 打卡',
  // 夸主播
  '主播声音太好听了',
  '这也太好看了吧',
  '主播今天状态不错啊',
  '666666',
  '主播牛哇',
  '爱了爱了',
  '主播yyds',
  '这个必须点赞',
  '氛围感拉满',
  // 点歌/点内容
  '点歌《晴天》！',
  '能唱一首周杰伦的吗',
  '来首抒情歌吧',
  '点歌！随便来一首',
  '再来一个！',
  // 问问题
  '主播用的什么设备呀',
  '这是什么歌呀',
  '主播什么时候开播的',
  '今天播到几点',
  '怎么加粉丝团',
  '主播玩什么游戏',
  '有群吗？想进群',
  // 催更/互动
  '催更催更！',
  '每天就播这么点时间吗',
  '主播多播一会儿呗',
  '下次什么时候播',
  '蹲一个下次直播',
  // 闲聊
  '哈哈哈哈哈笑死',
  '前排围观',
  '路过~',
  '摸鱼中ing',
  '今天人好多啊',
];

/** 随机用户名池 */
const USER_POOL = [
  '快乐小鱼干', '深夜程序猿', '爱吃火锅的猫', '路过的风', '奶盖不加糖',
  '摸鱼达人007', '天台看月亮', '一只小笼包', '芝士就是力量', '半糖去冰',
  '电子羊驼', '柴犬头子', '凌晨四点的猫', '熊猫眼本人', '白开水不加冰',
  '银杏叶落了', '南方的雪', '柠檬精本精', '键盘侠克星', '薯片守护者',
  '月色真美', '云上漫步者', '贩卖日落', 'WiFi蹭蹭蹭', '打工人小张',
  '养生朋克', '秃头小宝贝', '西瓜最中间一口', '脆皮大学生', '数字生命',
];

/** 礼物池 */
const GIFT_POOL = [
  { gift: '小心心', count: [1, 10] },
  { gift: '棒棒糖', count: [1, 5] },
  { gift: '能量棒', count: [1, 3] },
  { gift: '鲜花', count: [1, 8] },
  { gift: '火箭', count: [1, 1] },
  { gift: '嘉年华', count: [1, 1] },
];

// 随机模式事件权重（总和 100）
const WEIGHTS = { message: 80, gift: 6, enter: 8, follow: 6 };

// ---------------------------------------------------------------------------
// MockSource
// ---------------------------------------------------------------------------

export class MockSource extends EventEmitter {
  constructor() {
    super();
    this.type = 'mock';
    this._timers = new Set();
    this._running = false;
    this._scriptIndex = 0;
  }

  /**
   * 启动模拟源。
   * @param {object} config 见文件头注释
   */
  async start(config = {}) {
    if (this._running) return;
    this._running = true;
    this._config = config;
    this.emit('status', { connected: true, source: 'mock' });

    if (Array.isArray(config.script) && config.script.length > 0) {
      this._playScript(config.script, config);
    } else {
      this._scheduleRandom();
    }
  }

  /** 停止并清理所有定时器 */
  stop() {
    this._running = false;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this.emit('status', { connected: false, source: 'mock' });
  }

  // ------------------------------------------------------------------
  // 随机模式
  // ------------------------------------------------------------------

  _scheduleRandom() {
    if (!this._running) return;
    const [min, max] = this._config.interval || [3000, 8000];
    const delay = min + Math.random() * (max - min);
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      this._fireRandomEvent();
      this._scheduleRandom();
    }, delay);
    this._timers.add(timer);
  }

  _fireRandomEvent() {
    const roll = Math.random() * 100;
    let acc = 0;
    for (const [type, weight] of Object.entries(WEIGHTS)) {
      acc += weight;
      if (roll < acc) {
        this._emitByType(type, {});
        return;
      }
    }
    this._emitByType('message', {});
  }

  // ------------------------------------------------------------------
  // 剧本模式
  // ------------------------------------------------------------------

  _playScript(script, config) {
    const step = () => {
      if (!this._running) return;
      if (this._scriptIndex >= script.length) {
        if (config.loop) {
          this._scriptIndex = 0;
        } else if (config.afterScript === 'random') {
          this._scheduleRandom();
          return;
        } else {
          this.emit('status', { connected: false, source: 'mock', note: 'script finished' });
          this._running = false;
          return;
        }
      }
      const item = script[this._scriptIndex++];
      const delay = typeof item.delay === 'number' ? item.delay : 1500;
      const timer = setTimeout(() => {
        this._timers.delete(timer);
        this._emitByType(item.type || 'message', item);
        step();
      }, delay);
      this._timers.add(timer);
    };
    step();
  }

  // ------------------------------------------------------------------
  // 工具
  // ------------------------------------------------------------------

  _emitByType(type, item) {
    const user = item.user || this._pick(USER_POOL);
    switch (type) {
      case 'message':
        this.emit('message', { user, text: item.text || this._pick(DANMAKU_POOL) });
        break;
      case 'gift': {
        const g = item.gift ? { gift: item.gift, count: item.count || 1 } : this._pick(GIFT_POOL);
        this.emit('gift', {
          user,
          gift: g.gift,
          count: typeof g.count === 'number' ? g.count : this._randInt(g.count[0], g.count[1]),
        });
        break;
      }
      case 'enter':
        this.emit('enter', { user });
        break;
      case 'follow':
        this.emit('follow', { user });
        break;
      default:
        // 未知类型按 message 处理，保证容错
        this.emit('message', { user, text: item.text || this._pick(DANMAKU_POOL) });
    }
  }

  _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  _randInt(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }
}

export default MockSource;
