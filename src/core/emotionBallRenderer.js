// Official Emotion Ball adapter: preserves the desktop-pet renderer contract.
const EMOTION_IDS = {
  normal: '02',
  happy: '10',
  bored: '12',
  sad: '12',
  excited: '13',
  sleepy: '00',
  angry: '21',
  surprised: '13',
  love: '14',
  talking: '16',
};
const VOICE_EMOTION_IDS = {
  listening: '02',
  thinking: '30',
  speaking: '16',
  idle: '02',
};

export class EmotionBallRenderer {
  constructor() {
    this.container = null;
    this.engine = null;
    this._currentEmotion = 'normal';
    this._hitCallbacks = [];
    this._draggable = false;
    this._mouse = null;
    this._onDragMove = (event) => {
      if (!this._dragging || !this.container) return;
      this.container.style.left = (event.clientX - this._dragOffsetX) + 'px';
      this.container.style.top = (event.clientY - this._dragOffsetY) + 'px';
      this.container.style.bottom = 'auto';
    };
    this._onDragEnd = () => {
      if (!this._dragging) return;
      this._dragging = false;
      if (this.container) this.container.style.cursor = 'grab';
      this.engine?.setActive(true);
    };
    this._onPointerMove = (event) => {
      if (!this.engine) return;
      const rect = this.container.getBoundingClientRect();
      const nx = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      const ny = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1;
      this.engine.setGaze(Math.max(-1, Math.min(1, nx)), Math.max(-1, Math.min(1, ny)));
    };
  }

  async init(stageEl) {
    if (!window.EmotionBall?.create) throw new Error('[EmotionBallRenderer] official engine missing');
    this.container = document.createElement('div');
    this.container.id = 'emotion-ball-root';
    Object.assign(this.container.style, {
      position: 'fixed',
      left: '70vw',
      bottom: '24px',
      width: '132px',
      height: '132px',
      zIndex: 1100,
    });
    stageEl.appendChild(this.container);
    this.engine = window.EmotionBall.create(this.container, {
      emotion: EMOTION_IDS.normal,
      shape: 'blob',
      idle: { standbyAfter: 60000, sleepAfter: 180000 },
      eyeScale: 1.5,
      label: '桌宠小球',
    });
    this.engine.on('error', (event) => console.warn('[EmotionBallRenderer]', event?.message));
    this._engine = this.engine;
    window.__emotionBall = this.engine;
    this.container.addEventListener('pointerdown', this._handlePointerDown.bind(this));
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    window.addEventListener('pointermove', this._onDragMove.bind(this));
    window.addEventListener('pointerup', this._onDragEnd);
    window.addEventListener('pointercancel', this._onDragEnd);
    return this;
  }

  async setCharacter() { return this; }
  setScale(scale = 1) {
    const size = Math.max(64, Math.min(240, 132 * Number(scale)));
    this.container.style.width = size + 'px';
    this.container.style.height = size + 'px';
  }
  setEmotion(emotion = 'normal') {
    const id = EMOTION_IDS[emotion] || EMOTION_IDS.normal;
    this._currentEmotion = emotion;
    return this.engine?.setEmotion(id) ?? false;
  }
  setVoicePhase(phase = 'idle') {
    const id = VOICE_EMOTION_IDS[phase];
    if (!id) return false;
    this._currentEmotion = phase;
    return this.engine?.setEmotion(id) ?? false;
  }
  playExpression(name) { return this.setEmotion(name); }
  playMotion() {
    this.engine?.bounce();
    return true;
  }
  lipSpeak(_text, durationMs = 1800) {
    // Preserve the emotion selected from the reply; official ID 16 only drives
    // a focused talking pose when no reply emotion is currently active.
    if (!this._replyEmotion) this.setEmotion('talking');
    clearTimeout(this._speechTimer);
    this._speechTimer = setTimeout(() => {
      this._replyEmotion = false;
      if (this._currentEmotion === 'talking') this.setEmotion('normal');
    }, Math.max(500, durationMs));
    return true;
  }
  speak(durationMs = 1800) { return this.lipSpeak('', durationMs); }
  onHit(callback) {
    if (typeof callback === 'function') this._hitCallbacks.push(callback);
  }
  setDraggable(value) {
    this._draggable = !!value;
    if (this.container) this.container.style.cursor = this._draggable ? 'grab' : 'default';
  }
  setFrozen(value) { this.engine?.setActive(!value); }
  isFrozen() { return this.engine?._active === false; }
  hitTest(clientX, clientY) {
    const rect = this.container.getBoundingClientRect();
    const inside = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    return inside ? ['body'] : [];
  }
  lookAt(x, y) { this._onPointerMove({ clientX: x, clientY: y }); }
  setMouseFollow() {}
  setFlipX() {}
  flipX() { return false; }
  getModelInfo() { return { id: 'emotion-ball', name: 'Emotion Ball', type: 'emotion-ball' }; }
  isDraggable() { return this._draggable; }
  isMouseFollowEnabled() { return true; }
  get _sprite() { return this.container; }
  get _root() {
    return {
      x: this.container ? this.container.getBoundingClientRect().left + this.container.offsetWidth / 2 : 0,
      y: this.container ? this.container.getBoundingClientRect().top + this.container.offsetHeight / 2 : 0,
    };
  }
  destroy() {
    clearTimeout(this._speechTimer);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointermove', this._onDragMove);
    window.removeEventListener('pointerup', this._onDragEnd);
    window.removeEventListener('pointercancel', this._onDragEnd);
    this.engine?.destroy();
    this.container?.remove();
    this.container = null;
    this.engine = null;
  }

  _handlePointerDown(event) {
    // 拖拽模式：按住小球移动（真实位移——容器跟随指针，松手定位）
    if (this._draggable && event.button === 0) {
      const rect = this.container.getBoundingClientRect();
      this._dragging = true;
      this._dragOffsetX = event.clientX - rect.left;
      this._dragOffsetY = event.clientY - rect.top;
      this.container.style.cursor = 'grabbing';
      this.engine?.setActive(false); // 拖动中暂停引擎动画
      event.preventDefault();
      return;
    }
    this.engine?.spin(1);
    for (const callback of this._hitCallbacks) {
      try { callback(['body'], event); } catch (error) { console.error(error); }
    }
  }


}

export default EmotionBallRenderer;
