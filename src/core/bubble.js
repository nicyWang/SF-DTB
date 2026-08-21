// ============================================================
// bubble.js — 宠物头顶气泡对话 UI（DOM 实现）
// 契约见 CONTRACT.md：showText / streamAppend 流式 / duration 后淡出
// 快速对话时自动打断上一个气泡
// ============================================================

const STYLE_ID = 'pet-bubble-style';

/** 默认停留时长：max(3s, 字数 × 0.15s) */
function defaultDuration(text) {
  return Math.max(3000, String(text || '').length * 150);
}

class BubbleUI {
  /**
   * @param {HTMLElement} [parent] 挂载容器，默认 document.body
   */
  constructor(parent) {
    BubbleUI._ensureStyles();
    this.parent = parent || document.body;
    this.el = document.createElement('div');
    this.el.className = 'pet-bubble';
    this.el.style.display = 'none';
    this.parent.appendChild(this.el);

    this.text = '';
    this._hideTimer = null;
  }

  // ---------- 对外接口 ----------

  /**
   * 显示一段完整文本
   * @param {string} text
   * @param {number} [duration] 停留毫秒数；缺省 max(3s, 字数×0.15s)
   */
  /** 跟随模式：气泡锚定到动态目标头顶（小球桌宠用） */
  followTarget(fn) {
    this._followFn = fn;
    if (this._followTimer) return;
    this._followTimer = setInterval(() => {
      if (!this._followFn) return;
      if (this.el.style.display === 'none' || this.el.style.opacity === '0') return;
      try {
        const p = this._followFn();
        if (!p) return;
        const w = this.el.offsetWidth, h = this.el.offsetHeight;
        let x = p.x - w / 2;
        let y = p.y - h;
        x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
        y = Math.max(8, y);
        this.el.style.left = x + 'px';
        this.el.style.top = y + 'px';
        this.el.style.transform = 'none';
      } catch (e) { /* 目标已销毁 */ }
    }, 50);
  }

  showText(text, duration) {
    this._interrupt();
    this.text = String(text ?? '');
    this.el.textContent = this.text;
    this._scheduleHide(typeof duration === 'number' ? duration : defaultDuration(this.text));
  }

  /**
   * 显示提示文本（灰色斜体，用于语音识别中间结果/系统提示，
   * 与宠物正式回复的白色气泡区分）
   * @param {string} text
   * @param {number} [duration] 停留毫秒数；缺省 max(3s, 字数×0.15s)
   */
  showHint(text, duration) {
    this.el.classList.add('hint');
    this.showText(text, duration);
  }

  /**
   * 流式追加文本（打字机效果：LLM chunk 到达即追加）
   * 流式期间不淡出，由 streamEnd() 结束后调度
   */
  streamAppend(chunk) {
    this._interrupt();
    this.text += String(chunk ?? '');
    this.el.textContent = this.text;
  }

  /** 流式结束：按文本长度调度淡出 */
  streamEnd(duration) {
    this._scheduleHide(typeof duration === 'number' ? duration : defaultDuration(this.text));
  }

  /** 立即隐藏 */
  hide() {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    this.el.style.opacity = '0';
    setTimeout(() => {
      if (this.el.style.opacity === '0') this.el.style.display = 'none';
    }, 380);
  }

  // ---------- 内部 ----------

  /** 打断上一个气泡：取消淡出计时并立即以全透明度显示 */
  _interrupt() {
    if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
    this.el.style.display = 'block';
    // 强制 reflow 让 opacity 过渡从头开始
    void this.el.offsetWidth;
    this.el.style.opacity = '1';
  }

  _scheduleHide(ms) {
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hide(), Math.max(500, ms));
  }

  static _ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .pet-bubble {
        position: absolute;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        max-width: 280px;
        padding: 9px 13px;
        background: rgba(255, 255, 255, 0.96);
        color: #333;
        font-size: 13px;
        line-height: 1.55;
        border-radius: 14px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
        word-break: break-word;
        white-space: pre-wrap;
        z-index: 1000;
        pointer-events: none; /* 不挡点击 */
        transition: opacity 0.35s ease;
        font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
        user-select: none;
        -webkit-user-select: none;
      }
      .pet-bubble::after {
        content: '';
        position: absolute;
        bottom: -8px;
        left: 50%;
        transform: translateX(-50%);
        border: 8px solid transparent;
        border-top-color: rgba(255, 255, 255, 0.96);
        border-bottom: none;
      }
      /* 提示态：灰色斜体（语音识别中间结果/系统提示） */
      .pet-bubble.hint {
        color: #8a94a6;
        font-style: italic;
        background: rgba(255, 255, 255, 0.88);
      }
      .pet-bubble.hint::after {
        border-top-color: rgba(255, 255, 255, 0.88);
      }
    `;
    document.head.appendChild(style);
  }
}

export default BubbleUI;
export { BubbleUI };
