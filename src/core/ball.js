// ball.js — 程序化小球桌宠渲染器（零素材依赖：PIXI Graphics绘制）
// 表情系统：normal(待机)/happy(开心)/sad(委屈)/talking(说话嘴部开合)
// 复用现有架构：透明窗+点击穿透+漫游状态机+拖拽重力（由sprite.js同款逻辑驱动）

export class BallRenderer {
  /**
   * @param {object} opts
   * @param {PIXI.Application} opts.app PIXI应用
   * @param {PIXI.Container} opts.container 舞台容器
   */
  constructor(opts = {}) {
    this.app = opts.app;
    this.container = opts.container || (this.app && this.app.stage);
    if (!this.app || !this.container) throw new Error('[BallRenderer] 缺少 PIXI app/container');

    // ===== 状态 =====
    this._destroyed = false;
    this._currentEmotion = 'normal';
    this._dragging = false;
    this._draggable = true;
    this._hitCallbacks = [];
    this._speaking = false;
    this._speakEnd = 0;
    this._tapPulseUntil = 0;
    this._motionUntil = 0;
    this._motionKind = null;
    this._motionPhase = 0;

    // 漫游（与sprite.js同款状态机字段，供主循环复用）
    this._roam = { enabled: true, state: 'stand', targetX: 0, speed: 130,
      standUntil: Date.now() + 4000, bouncePhase: 0, bounce: 0, rot: 0, vy: 0 };
    this._roamPlaced = false;
    this._groundY = 0;
    this._hovering = false;
    this._baseX = 0; this._baseY = 0;
    this._baseScale = 1;
    this._userScale = 1;
    this._flipped = false;
    this._followX = 0; this._followY = 0; this._followRot = 0;
    this._mouse = null; this._mouseAt = 0;
    this._mouseFollow = true;
    this._followIdleMs = 1500;
    this._breathPhase = 0;
    this._blinkEnd = 0; this._nextBlinkAt = Date.now() + 3000 + Math.random() * 3000;
    this._hearts = [];
    this._pose = {
      bodyColor: 0,
      bodyColorTarget: 0xf3f0ea,
      bodyX: 0,
      bodyY: 0,
      rotate: 0,
      scaleX: 1,
      scaleY: 1,
    };

    // ===== 绘制 =====
    this._root = new PIXI.Container();          // 根（位置/缩放）
    this._body = new PIXI.Graphics();           // 球体
    this._face = new PIXI.Container();          // 五官容器（表情切换整体重画）
    this._root.addChild(this._body);
    this._root.addChild(this._face);
    this.container.addChild(this._root);

    // 阴影（脚下椭圆，增强"落地感"）
    this._shadow = new PIXI.Graphics();
    this.container.addChildAt(this._shadow, 0);

    this._radius = 60; // 逻辑半径（px，实际按scale）
    this._drawBody();
    this._drawFace();

    // 交互
    this._root.interactive = true;
    this._root.cursor = 'pointer';
    this._root.on('pointertap', (e) => this._handleTap(e));
    this._root.on('pointerdown', (e) => this._onGrab(e));

    // 主循环：setInterval自驱动（PIXI shared ticker在本项目环境下2帧后死亡——raf被杀，
    // ticker.start()无法复活。脱离PIXI ticker，30fps interval + 手动render，稳定可控）
    this._tickErrCount = 0;
    this._lastTickAt = 0;
    this._tickTimer = setInterval(() => {
      if (this._destroyed) { clearInterval(this._tickTimer); return; }
      try {
        const now = performance.now();
        const dms = Math.min(100, this._lastTickAt ? now - this._lastTickAt : 33);
        this._lastTickAt = now;
        this._tick(dms);
        this.app.render(); // 手动渲染（CanvasRenderer模式开销低）
      } catch (e) {
        this._tickErrCount++;
        if (this._tickErrCount < 3) console.error('[BallRenderer] tick异常(已吞)', e);
      }
    }, 33);

    // 全局鼠标（拖拽+hover穿透）
    this._onDomMove = (ev) => {
      this._mouse = { x: ev.clientX, y: ev.clientY };
      this._mouseAt = Date.now();
      if (this._dragging && this._dragStart) {
        const dx = ev.clientX - this._dragStart.clientX;
        const dy = ev.clientY - this._dragStart.clientY;
        this._baseX = this._dragStart.spriteX + dx;
        this._baseY = this._dragStart.spriteY + dy;
      }
      // 关键：全屏穿透窗口的hover检测——鼠标在小球包围盒内→取消穿透（可点/可拖），离开→恢复穿透
      // UI让权：鼠标在底部操作坞（mic/输入条）上时，由 index.html 的 dock 穿透管理接管，
      // ball.js 不得恢复穿透（否则会盖掉 UI 控件的交互）
      if (!this._destroyed && this._root) {
        const r = (this._radiusScaled || 60) * 1.15; // 略放大的命中区
        const bx = this._root.x, by = this._root.y;
        const inside = ev.clientX >= bx - r && ev.clientX <= bx + r
          && ev.clientY >= by - r && ev.clientY <= by + r;
        const uiPinned = typeof window.__uiPinned === 'function' && window.__uiPinned();
        if (inside !== this._hovering || uiPinned) {
          this._hovering = inside;
          if (!uiPinned) {
            try {
              if (window.windowAPI && window.windowAPI.setIgnoreCursor) {
                window.windowAPI.setIgnoreCursor(!inside);
              }
            } catch (e) { /* 浏览器测试模式 */ }
          }
        }
      }
    };
    this._onDomUp = () => {
      if (!this._dragging) return;
      this._dragging = false; this._dragStart = null;
      if (this._roam && this._baseY < this._groundY - 6) {
        this._roam.state = 'fall'; this._roam.vy = 0;
      } else if (this._roam) {
        this._baseY = this._groundY;
        this._roam.state = 'stand';
        this._roam.standUntil = Date.now() + 3000 + Math.random() * 6000;
      }
    };
    window.addEventListener('mousemove', this._onDomMove);
    window.addEventListener('mouseup', this._onDomUp);

    // 尺寸/位置（等容器布局后
    setTimeout(() => this._fitToContainer(), 0);
    this._onResize = () => this._fitToContainer();
    window.addEventListener('resize', this._onResize);
  }

  // ============ 绘制 ============

  _drawBody() {
    const r = this._radius;
    this._body.clear();
    // 参考站的陶瓷质感：米白主体 + 左上柔光 + 边缘收深
    const color = this._pose.bodyColor;
    const lighter = this._blendColor(color, 0xffffff, 0.24);
    const darker = this._blendColor(color, 0x000000, 0.14);
    this._body.beginFill(lighter, 0.86);
    this._body.drawCircle(-r * 0.08, -r * 0.12, r * 0.92);
    this._body.endFill();
    this._body.beginFill(color, 0.94);
    this._body.drawCircle(0, 0, r);
    this._body.endFill();
    this._body.beginFill(darker, 0.2);
    this._body.drawCircle(0, r * 0.08, r * 0.94);
    this._body.endFill();
  }

  _blendColor(from, to, amount) {
    const r = ((from >> 16) & 255) * (1 - amount) + ((to >> 16) & 255) * amount;
    const g = ((from >> 8) & 255) * (1 - amount) + ((to >> 8) & 255) * amount;
    const b = (from & 255) * (1 - amount) + (to & 255) * amount;
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }

  _drawFace() {
    this._face.removeChildren();
    const r = this._radius;
    const emo = this._currentEmotion;
    const g = new PIXI.Graphics();

    // 眼睛（眨眼时高度压缩）
    let eyeH = r * 0.24;
    let eyeY = -r * 0.16;
    const eyeLX = -r * 0.34, eyeRX = r * 0.31;
    const eyeColor = 0x1a1a1a;

    if (emo === 'love') {
      // 喜爱：爱心眼
      const drawHeart = (cx, cy, hr) => {
        g.beginFill(0xff5e8e, 1);
        g.arc(cx - hr * 0.35, cy - hr * 0.05, hr * 0.36, 0, Math.PI * 2);
        g.arc(cx + hr * 0.35, cy - hr * 0.05, hr * 0.36, 0, Math.PI * 2);
        g.endFill();
        g.beginFill(0xff5e8e, 1);
        g.moveTo(cx - hr * 0.66, cy + hr * 0.08);
        g.lineTo(cx, cy + hr * 0.95);
        g.lineTo(cx + hr * 0.66, cy + hr * 0.08);
        g.closePath();
        g.endFill();
      };
      drawHeart(eyeLX, eyeY - r * 0.05, r * 0.3);
      drawHeart(eyeRX, eyeY - r * 0.05, r * 0.3);
    } else if (emo === 'angry') {
      // 生气：>< 怒眼+怒眉+红晕
      g.lineStyle(r * 0.08, eyeColor, 1);
      g.moveTo(eyeLX - r * 0.14, eyeY - r * 0.1); g.lineTo(eyeLX + r * 0.14, eyeY + r * 0.08);
      g.moveTo(eyeLX + r * 0.14, eyeY - r * 0.1); g.lineTo(eyeLX - r * 0.14, eyeY + r * 0.08);
      g.moveTo(eyeRX - r * 0.14, eyeY - r * 0.1); g.lineTo(eyeRX + r * 0.14, eyeY + r * 0.08);
      g.moveTo(eyeRX + r * 0.14, eyeY - r * 0.1); g.lineTo(eyeRX - r * 0.14, eyeY + r * 0.08);
      g.lineStyle(r * 0.09, eyeColor, 1);
      g.moveTo(eyeLX - r * 0.18, eyeY - r * 0.28); g.lineTo(eyeLX + r * 0.12, eyeY - r * 0.16);
      g.moveTo(eyeRX + r * 0.18, eyeY - r * 0.28); g.lineTo(eyeRX - r * 0.12, eyeY - r * 0.16);
      g.beginFill(0xff4444, 0.35);
      g.drawEllipse(-r * 0.58, r * 0.14, r * 0.15, r * 0.1);
      g.drawEllipse(r * 0.58, r * 0.14, r * 0.15, r * 0.1);
      g.endFill();
    } else if (emo === 'surprised') {
      // 惊讶：O O 圆睁眼
      g.beginFill(eyeColor, 1);
      g.drawCircle(eyeLX, eyeY, r * 0.15);
      g.drawCircle(eyeRX, eyeY, r * 0.15);
      g.endFill();
      g.beginFill(0xffffff, 0.9);
      g.drawCircle(eyeLX - r * 0.04, eyeY - r * 0.05, r * 0.05);
      g.drawCircle(eyeRX - r * 0.04, eyeY - r * 0.05, r * 0.05);
      g.endFill();
    } else if (emo === 'sleepy') {
      // 睡觉：闭眼横线+Zzz
      g.lineStyle(r * 0.07, eyeColor, 1);
      g.moveTo(eyeLX - r * 0.15, eyeY); g.lineTo(eyeLX + r * 0.15, eyeY);
      g.moveTo(eyeRX - r * 0.15, eyeY); g.lineTo(eyeRX + r * 0.15, eyeY);
    } else if (emo === 'happy') {
      // 开心：^ ^ 弯眼
      g.lineStyle(r * 0.07, eyeColor, 1);
      g.arc(eyeLX, eyeY, r * 0.16, Math.PI, 0);
      g.arc(eyeRX, eyeY, r * 0.16, Math.PI, 0);
    } else if (emo === 'sad') {
      // 委屈：> < 下垂眼
      g.lineStyle(r * 0.07, eyeColor, 1);
      g.arc(eyeLX, eyeY + r * 0.08, r * 0.16, 0, Math.PI);
      g.arc(eyeRX, eyeY + r * 0.08, r * 0.16, 0, Math.PI);
      eyeY += r * 0.06;
    } else {
      // 普通/说话：圆点眼
      g.beginFill(eyeColor, 1);
      g.drawEllipse(eyeLX, eyeY, r * 0.095, eyeH);
      g.drawEllipse(eyeRX, eyeY, r * 0.088, eyeH * 1.03);
      g.endFill();
      // 眼睛高光
      g.beginFill(0xffffff, 0.9);
      g.drawCircle(eyeLX - r * 0.035, eyeY - r * 0.085, r * 0.032);
      g.drawCircle(eyeRX - r * 0.03, eyeY - r * 0.085, r * 0.03);
      g.endFill();
    }

    // 腮红（开心时更红）
    if (emo === 'happy' || emo === 'normal') {
      g.beginFill(0xf4d3d0, emo === 'happy' ? 0.72 : 0.45);
      g.drawEllipse(-r * 0.5, r * 0.18, r * 0.15, r * 0.075);
      g.drawEllipse(r * 0.5, r * 0.18, r * 0.15, r * 0.075);
      g.endFill();
    }

    // 嘴（说话时开合动画由_tick实时改）
    const mouthY = r * 0.28;
    const ink = 0x1a1a1a;
    g.lineStyle(r * 0.055, ink, 1);
    if (emo === 'happy' || emo === 'love') {
      g.arc(0, mouthY - r * 0.1, r * 0.18, 0.16 * Math.PI, 0.84 * Math.PI);
    } else if (emo === 'sad') {
      g.arc(0, mouthY + r * 0.18, r * 0.17, 1.16 * Math.PI, 1.84 * Math.PI);
    } else if (emo === 'angry') {
      g.moveTo(-r * 0.2, mouthY);
      g.quadraticCurveTo(-r * 0.1, mouthY - r * 0.09, 0, mouthY);
      g.quadraticCurveTo(r * 0.1, mouthY + r * 0.09, r * 0.2, mouthY);
    } else if (emo === 'surprised') {
      g.beginFill(ink, 0.92);
      g.drawEllipse(0, mouthY, r * 0.1, r * 0.13);
      g.endFill();
    } else if (emo === 'sleepy') {
      g.moveTo(-r * 0.11, mouthY);
      g.lineTo(r * 0.11, mouthY);
    } else {
      // normal/talking：微笑（说话时_tick叠加开合椭圆）
      g.arc(0, mouthY - r * 0.04, r * 0.13, 0.22 * Math.PI, 0.78 * Math.PI);
    }
    this._face.addChild(g);
    if (emo === 'sleepy') {
      const zt = new PIXI.Text('z', { fontFamily: 'Space Grotesk, Arial', fontSize: r * 0.38, fontWeight: 'bold', fill: 0xa8a296 });
      zt.x = r * 0.5; zt.y = -r * 0.95; zt.alpha = 0.85;
      this._face.addChild(zt);
      const zt2 = new PIXI.Text('z', { fontFamily: 'Space Grotesk, Arial', fontSize: r * 0.3, fontWeight: 'bold', fill: 0xa8a296 });
      zt2.x = r * 0.88; zt2.y = -r * 1.3; zt2.alpha = 0.6;
      this._face.addChild(zt2);
    }
    this._mouthG = g;
    this._mouthY = mouthY;
  }

  // 说话时实时画开合嘴（覆盖在表情嘴上）
  // 关键：复用同一个Graphics只clear重画——每帧destroy+新建会让PIXI纹理池崩坏
  //       （"Cannot read properties of null (reading 'refCount')"导致ticker主循环死亡）
  _drawTalkingMouth(openAmount) {
    if (!this._mouthG) return;
    const r = this._radius;
    if (!this._talkMouth) {
      this._talkMouth = new PIXI.Graphics();
      this._face.addChild(this._talkMouth);
    }
    const g = this._talkMouth;
    g.clear();
    if (openAmount <= 0.05) return;
    g.beginFill(0x1a1a1a, 0.92);
    g.drawEllipse(0, this._mouthY + r * 0.07, r * 0.11 + openAmount * r * 0.045, r * 0.04 + openAmount * r * 0.12);
    g.endFill();
  }

  // ============ 布局 ============

  _fitToContainer() {
    if (this._destroyed || !this.container) return;
    const w = this.container.clientWidth || window.innerWidth || 1200;
    const h = this.container.clientHeight || window.innerHeight || 800;
    // 小球尺寸：屏幕高的14%（比立绘更小更Q）
    const targetR = Math.min(h * 0.075, 64);
    this._baseScale = targetR / this._radius;
    this._radiusScaled = targetR;
    this._groundY = h - targetR - 20;
    if (!this._roamPlaced) {
      this._roamPlaced = true;
      this._baseX = w * 0.7;
      this._baseY = this._groundY;
    } else if (this._roam.state !== 'fall') {
      this._baseY = this._groundY;
    }
    // 阴影位置
    this._shadow.clear();
    this._shadow.beginFill(0x736b5f, 0.16);
    this._shadow.drawEllipse(this._baseX, this._groundY + this._radiusScaled * 0.9, this._radiusScaled * 0.72, this._radiusScaled * 0.13);
    this._shadow.endFill();
  }

  // ============ 主循环 ============

  _tick(dms) {
    if (this._destroyed || !this._root) return;
    const now = Date.now();
    dms = dms || 33;

    this._roamTick(dms);
    this._updateMouseFollow(now);

    this._updatePose(dms);

    // 呼吸
    this._breathPhase += dms / 4000;
    if (this._breathPhase > 1) this._breathPhase -= 1;
    const breath = 1 + Math.sin(this._breathPhase * Math.PI * 2) * 0.02;

    // 眨眼（普通/说话表情时）
    if (now >= this._nextBlinkAt) {
      this._blinkEnd = now + 150;
      this._nextBlinkAt = now + 3000 + Math.random() * 3000;
    }
    let blinkS = 1;
    if (this._blinkEnd > now) {
      const t = 1 - (this._blinkEnd - now) / 150;
      blinkS = t < 0.5 ? 1 - t * 2 * 0.92 : 1 - (1 - t) * 2 * 0.92;
    }

    // 轻拍脉冲
    let tapS = 1;
    if (now < this._tapPulseUntil) {
      tapS = 1 + Math.sin((this._tapPulseUntil - now) / 600 * Math.PI) * 0.08;
    }

    // 具名动作：小球弹跳，替代原 Live2D TapBody 观感
    let motionBounce = 0;
    if (now < this._motionUntil && this._motionKind === 'tap' && !this._frozen) {
      this._motionPhase += dms / 260;
      motionBounce = Math.abs(Math.sin(Math.min(1, this._motionPhase) * Math.PI)) * 18;
    } else if (this._motionKind) {
      this._motionKind = null;
      this._motionPhase = 0;
    }

    // 说话嘴部开合
    if (this._speaking && now < this._speakEnd) {
      const t = (now / 130) % 1;
      this._drawTalkingMouth(0.3 + 0.7 * Math.abs(Math.sin(t * Math.PI * 2)));
    } else {
      if (this._speaking) this._speaking = false;
      this._drawTalkingMouth(0);
    }

    // 应用变换
    const s = this._baseScale * this._userScale * tapS;
    this._root.scale.set(s * this._pose.scaleX, s * this._pose.scaleY);
    this._root.x = this._baseX + this._followX;
    this._root.y = this._baseY + this._pose.bodyY + this._followY - (this._roam.bounce || 0) - motionBounce;
    this._root.rotation = this._pose.rotate + (this._roam.rot || 0) + this._followRot;
    // 眨眼压缩五官
    if (blinkS < 1) this._face.scale.y = blinkS;
    else this._face.scale.y = 1;

    // 阴影跟随（跳起时阴影变小）
    const air = (this._roam.bounce || 0) + Math.max(0, this._groundY - this._baseY);
    const shScale = Math.max(0.5, 1 - air / 300);
    this._shadow.scale.set(shScale, shScale);
    this._shadow.x = this._baseX - this._baseX; // 保持x在球正下方（x已画在绝对坐标）
    this._shadow.x = 0; this._shadow.y = 0;
    // 重画阴影位置（简单起见）
    this._shadow.clear();
    this._shadow.beginFill(0x736b5f, 0.14 * shScale);
    this._shadow.drawEllipse(this._baseX, this._groundY + this._radiusScaled * 0.92, this._radiusScaled * 0.72 * shScale, this._radiusScaled * 0.12 * shScale);
    this._shadow.endFill();

    this._updateHearts(dms);
  }

  _roamTick(deltaMS) {
    // 冻结中（说话/播报）：完全暂停漫游与弹跳，保证气泡可读
    if (this._frozen) { this._roam.bounce = 0; this._roam.rot = 0; return; }
    if (!this._roam.enabled || this._dragging) { this._roam.bounce = 0; this._roam.rot = 0; return; }
    const now = Date.now();
    const w = (this.container && this.container.clientWidth) || window.innerWidth || 1200;
    const r = this._radiusScaled || 60;
    const minX = r + 16, maxX = w - r - 16;
    const rr = this._roam;
    if (rr.state === 'stand') {
      if (now >= rr.standUntil) {
        rr.targetX = minX + Math.random() * Math.max(50, (maxX - minX));
        if (Math.abs(rr.targetX - this._baseX) < 100)
          rr.targetX = this._baseX + (Math.random() < 0.5 ? -1 : 1) * (150 + Math.random() * 250);
        rr.targetX = Math.max(minX, Math.min(maxX, rr.targetX));
        rr.state = 'walk'; rr.bouncePhase = 0;
      }
    } else if (rr.state === 'walk') {
      const dir = rr.targetX > this._baseX ? 1 : -1;
      const step = rr.speed * deltaMS / 1000;
      if (Math.abs(rr.targetX - this._baseX) <= step) {
        this._baseX = rr.targetX;
        rr.state = 'stand';
        rr.standUntil = now + 4000 + Math.random() * 9000;
        rr.bounce = 0; rr.rot = 0;
      } else {
        this._baseX += dir * step;
        rr.bouncePhase += deltaMS / 95;
        rr.bounce = Math.abs(Math.sin(rr.bouncePhase)) * 11;
        rr.rot = Math.sin(rr.bouncePhase) * 0.06; // 小球滚动感更强
      }
    } else if (rr.state === 'fall') {
      rr.vy += 2200 * deltaMS / 1000;
      this._baseY += rr.vy * deltaMS / 1000;
      if (this._baseY >= this._groundY) {
        this._baseY = this._groundY;
        rr.state = 'stand';
        rr.standUntil = now + 2500 + Math.random() * 5000;
        rr.vy = 0; rr.bounce = 0; rr.rot = 0;
      }
    }
  }

  _updatePose(deltaMS) {
    const t = 1 - Math.exp(-deltaMS / 90);
    const p = this._pose;
    if (Math.abs(p.bodyColorTarget - p.bodyColor) < 1) p.bodyColor = p.bodyColorTarget;
    else p.bodyColor += (p.bodyColorTarget - p.bodyColor) * t;
    const emotion = this._currentEmotion;
    const active = !this._frozen && !this._dragging;
    const breathing = 1 + Math.sin(this._breathPhase) * this._emotionBreath(emotion);
    let bodyY = 0;
    let rotate = 0;
    if (active) {
      const nowSec = now => now / 1000;
      void nowSec;
      const now = Date.now();
      if (emotion === 'happy' || emotion === 'excited' || emotion === 'love') {
        bodyY = Math.sin(now / 260) * this._radiusScaled * 0.035;
      } else if (emotion === 'sad' || emotion === 'sleepy') {
        bodyY = this._radiusScaled * 0.045;
        rotate = -0.055;
      } else if (emotion === 'angry') {
        rotate = Math.sin(now / 100) * 0.012;
      } else if (emotion === 'surprised') {
        bodyY = -this._radiusScaled * 0.035;
      }
    }
    p.bodyY += (bodyY - p.bodyY) * t;
    p.rotate += (rotate - p.rotate) * t;
    p.scaleY += (breathing - p.scaleY) * t;
    p.scaleX += (1 - p.scaleX) * t;
    this._drawBody();
  }

  _emotionBreath(emotion) {
    return ({ normal: 0.012, talking: 0.011, happy: 0.017, excited: 0.018, love: 0.017, sad: 0.007, sleepy: 0.018, angry: 0.004, surprised: 0.006 }[emotion] || 0.01);
  }

  _updateMouseFollow(now) {
    const LERP = 0.1;
    let tx = 0, ty = 0, tr = 0;
    // 冻结中不跟随鼠标（完全静止，气泡稳定）
    const active = !this._frozen && this._mouseFollow && !this._dragging && this._mouse && (now - this._mouseAt) < this._followIdleMs;
    if (active) {
      const w = window.innerWidth || 1200, h = window.innerHeight || 800;
      const dx = this._mouse.x - this._baseX, dy = this._mouse.y - this._baseY;
      const nx = Math.max(-1, Math.min(1, dx / (w / 2)));
      tx = dx * 0.02; ty = dy * 0.015; tr = nx * 0.03;
    }
    this._followX += (tx - this._followX) * LERP;
    this._followY += (ty - this._followY) * LERP;
    this._followRot += (tr - this._followRot) * LERP;
  }

  // ============ 爱心粒子 ============

  _spawnHearts(count) {
    if (!this._heartTex) {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ff5e8e';
      ctx.beginPath();
      ctx.arc(10, 11, 7, 0, Math.PI * 2); ctx.arc(22, 11, 7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(3.5, 14); ctx.lineTo(16, 29); ctx.lineTo(28.5, 14); ctx.closePath(); ctx.fill();
      this._heartTex = PIXI.Texture.from(c);
    }
    const baseY = this._baseY - (this._radiusScaled || 60) - 10;
    for (let i = 0; i < (count || 4); i++) {
      const sp = new PIXI.Sprite(this._heartTex);
      sp.anchor.set(0.5);
      sp.scale.set(0.55 + Math.random() * 0.45);
      sp.x = this._baseX + (Math.random() - 0.5) * 50;
      sp.y = baseY + Math.random() * 16;
      sp.alpha = 0.95;
      this.container.addChild(sp);
      this._hearts.push({ sp, born: Date.now(), life: 1400 + Math.random() * 600,
        vy: -(38 + Math.random() * 30), swayAmp: 14 + Math.random() * 12,
        swayFreq: 2 + Math.random() * 2, x0: sp.x });
    }
  }

  _updateHearts(deltaMS) {
    if (!this._hearts.length) return;
    const now = Date.now();
    for (let i = this._hearts.length - 1; i >= 0; i--) {
      const h = this._hearts[i];
      const t = (now - h.born) / h.life;
      if (t >= 1) {
        if (h.sp.parent) h.sp.parent.removeChild(h.sp);
        h.sp.destroy(); this._hearts.splice(i, 1); continue;
      }
      const dt = deltaMS / 1000;
      h.sp.y += h.vy * dt;
      h.sp.x = h.x0 + Math.sin((now / 1000) * h.swayFreq * Math.PI * 2 + i) * h.swayAmp;
      h.sp.alpha = 0.95 * (1 - t);
      h.sp.rotation = Math.sin((now / 1000) * h.swayFreq + i) * 0.25;
    }
  }

  // ============ 交互 ============

  _handleTap(e) {
    if (this._dragging) return;
    for (const cb of this._hitCallbacks) { try { cb(['body'], e); } catch (err) { console.error(err); } }
    this._tapPulseUntil = Date.now() + 600;
    // 点击表情联动
    if (this._currentEmotion === 'normal') {
      this.setEmotion('happy');
      clearTimeout(this._tapEmoTimer);
      this._tapEmoTimer = setTimeout(() => {
        if (this._currentEmotion === 'happy') this.setEmotion('normal');
      }, 2200);
    }
    this._spawnHearts(4);
  }

  _onGrab(e) {
    if (!this._draggable || this._destroyed) return;
    const oe = e.data && e.data.originalEvent ? e.data.originalEvent : e;
    this._dragging = true;
    this._dragStart = {
      clientX: oe.clientX != null ? oe.clientX : (e.client && e.client.x),
      clientY: oe.clientY != null ? oe.clientY : (e.client && e.client.y),
      spriteX: this._baseX, spriteY: this._baseY,
    };
  }

  // ============ 公开API（对齐SpriteRenderer契约）=============

  setEmotion(emotion) {
    if (this._destroyed) return false;
    const aliases = { bored: 'sleepy' };
    const target = aliases[emotion] || emotion;
    if (!['normal', 'happy', 'sad', 'talking', 'excited', 'sleepy', 'angry', 'surprised', 'love'].includes(target)) return false;
    this._currentEmotion = target;
    this._pose.bodyColorTarget = ({
      normal: 0xf3f0ea,
      talking: 0xf3f0ea,
      happy: 0xf6efe4,
      excited: 0xf7ecd9,
      love: 0xf4d3d0,
      sad: 0xedeae3,
      sleepy: 0xeeebe4,
      angry: 0xe4574a,
      surprised: 0xf5efe6,
    }[target] || 0xf3f0ea);
    this._drawFace();
    return true;
  }

  playMotion(motion, n) {
    // 兼容 PetController 的 Live2D motion group 参数：Idle/TapBody 均转小球动效
    const kind = String(motion || '').toLowerCase();
    this._motionKind = kind === 'tapbody' ? 'tap' : 'idle';
    this._motionUntil = Date.now() + (this._motionKind === 'tap' ? 900 : 300);
    this._motionPhase = 0;
    this._tapPulseUntil = Date.now() + (this._motionKind === 'tap' ? 600 : 0);
    return true;
  }

  speak(durationMs) {
    this._speaking = true;
    this._speakEnd = Date.now() + (durationMs || 3000);
  }

  onHit(cb) { if (typeof cb === 'function') this._hitCallbacks.push(cb); }
  setDraggable(v) { this._draggable = !!v; }
  setMouseFollow(v) { this._mouseFollow = !!v; }
  /**
   * 冻结/解冻移动（说话或 TTS 播报期间静止，气泡可读）
   * @param {boolean} v true=冻结漫游+鼠标跟随（呼吸/眨眼/口型保留）
   */
  setFrozen(v) {
    this._frozen = !!v;
    if (this._frozen) {
      // 立即清零所有位移残留：bounce/rot + 鼠标跟随偏移（否则 followY 的 LERP
      // 残值每帧×0.9 收敛，冻结中仍会漂移 10-20px，气泡跟着晃）
      this._roam.bounce = 0;
      this._roam.rot = 0;
      this._followX = 0;
      this._followY = 0;
      this._followRot = 0;
    }
  }
  isFrozen() { return !!this._frozen; }

  // SpriteRenderer 兼容接口（index.html 无需改动调用方式）
  async init(stageEl) {
    this._stageEl = stageEl;
    return this;
  }
  async setCharacter() { /* 小球无角色概念，no-op */ return this; }
  setScale(v) {
    const scale = Number(v);
    this._userScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    this._fitToContainer();
  }
  /** PetController契约：说话嘴部驱动（durationMs内嘴部开合） */
  lipSpeak(text, durationMs) {
    // 按文本长度估算时长（与SpriteRenderer同规则：字数×160ms）
    const dur = durationMs != null ? durationMs : Math.max(1200, (text ? text.length : 8) * 160);
    this.speak(dur);
    // 说话时切talking表情，说完回normal
    if (this._currentEmotion !== 'talking') {
      this.setEmotion('talking');
      clearTimeout(this._speakEmoTimer);
      this._speakEmoTimer = setTimeout(() => {
        if (this._currentEmotion === 'talking') this.setEmotion('normal');
      }, dur + 300);
    }
    return true;
  }
  isDraggable() { return !!this._draggable; }
  isMouseFollowEnabled() { return !!this._mouseFollow; }
  lookAt(x, y) { // 视差朝向目标（复用mouse follow目标）
    if (x != null && y != null) { this._mouse = { x, y }; this._mouseAt = Date.now(); }
  }
  setFlipX(v) { this._flipped = !!v; }
  flipX() { return this._flipped; }
  playExpression(name) { return this.setEmotion(name); }
  getModelInfo() { return { id: 'ball', name: '小球', type: 'ball' }; }

  /** SpriteRenderer契约：坐标命中检测（双击聊天依赖此方法） */
  hitTest(clientX, clientY) {
    if (this._destroyed || !this._root) return [];
    const r = (this._radiusScaled || 60) * 1.15;
    const bx = this._root.x, by = this._root.y;
    const inside = clientX >= bx - r && clientX <= bx + r && clientY >= by - r && clientY <= by + r;
    return inside ? ['body'] : [];
  }

  get roam() { return this._roam; }
  get _sprite() { return this._root; } // 兼容外部对 _sprite 的访问

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._tickTimer) clearInterval(this._tickTimer);
    window.removeEventListener('mousemove', this._onDomMove);
    window.removeEventListener('mouseup', this._onDomUp);
    window.removeEventListener('resize', this._onResize);
    for (const h of this._hearts) { if (h.sp.parent) h.sp.parent.removeChild(h.sp); h.sp.destroy(); }
    this._hearts = [];
    this._root.destroy({ children: true });
    this._shadow.destroy();
  }
}
