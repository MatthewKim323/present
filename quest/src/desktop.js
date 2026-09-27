// Desktop mode: HUD composited over the webcam feed. Same panels as XR.
import { drawMemoryToast, drawAgentActivity, anyRunning } from './panels.js';
import { drawPersonCardPlus as drawPersonCard, deltasAnimating, DesktopDev } from './devpanels.js';
import { DesktopVision } from './visionfx.js';
import { DesktopSwarm } from './swarmviz.js';
import { DesktopBrain } from './brainpanel.js';
import { DesktopMemory } from './memorypanel.js';
import { ANIM_HZ, due, safe, frameBegin, frameEnd } from './perf.js';

export class DesktopHud {
  constructor({ canvas, video, hud, onPinch }) {
    this.canvas = canvas;
    this.video = video;
    this.hud = hud;
    this.onPinch = onPinch;
    this.ctx = canvas.getContext('2d');
    this.cache = new Map();
    this.hits = [];
    this.running = false;
    this.dev = new DesktopDev(hud);
    this.vfx = new DesktopVision(hud); // perception overlay (visionfx.js)
    this.swarm = new DesktopSwarm(hud);
    this.brain = new DesktopBrain(hud); // GBRAIN live feed
    this.mem = new DesktopMemory(hud, this.dev); // Memorable stack under the QM SWARM panel
    window.addEventListener('resize', () => this._resize());
    // Click a card (or a person box) = pinch on that track.
    window.addEventListener('click', (e) => {
      if (!this.running || e.target.closest('#ui') || e.target.closest('#dev-preview')) return;
      if (this.dev.click(e.clientX, e.clientY)) return;
      const hit = this.hits.find((h) => e.clientX >= h.x && e.clientX <= h.x + h.w && e.clientY >= h.y && e.clientY <= h.y + h.h);
      if (hit) this.onPinch(hit.track);
    });
    this._resize();
  }

  _resize() {
    const d = devicePixelRatio || 1;
    this.canvas.width = innerWidth * d;
    this.canvas.height = innerHeight * d;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  start() {
    if (this.running) return;
    this.running = true;
    // schedule first, then draw: an exception in one frame must not stop the loop
    const loop = () => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const t0 = frameBegin();
      safe('desktop draw', () => this.draw());
      frameEnd(t0);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; this.ctx.clearRect(0, 0, innerWidth, innerHeight); }

  // Where the video actually sits on screen (object-fit: contain).
  _videoRect() {
    const vw = this.video.videoWidth || 4, vh = this.video.videoHeight || 3;
    const s = Math.min(innerWidth / vw, innerHeight / vh);
    const w = vw * s, h = vh * s;
    return { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2, w, h };
  }

  // animate: re-raster even when msg is unchanged, capped at ANIM_HZ
  _raster(k, msg, fn, animate = false) {
    const c = this.cache.get(k);
    if (c && c.msg === msg && (!animate || !due(c, ANIM_HZ))) return c.canvas;
    const canvas = fn(msg);
    if (this.cache.size > 64) this.cache.clear();
    this.cache.set(k, { msg, canvas, _drawT: performance.now() });
    return canvas;
  }

  draw() {
    const { ctx, hud } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const vr = this._videoRect();
    this.hits = [];
    const placed = new Map();

    // Faint person boxes so you can see what perception is tracking.
    for (const [id] of hud.tracks) {
      const b = hud.bboxFor(id);
      if (!b) continue;
      const x = vr.x + b[0] * vr.w, y = vr.y + b[1] * vr.h, w = b[2] * vr.w, h = b[3] * vr.h;
      ctx.strokeStyle = 'rgba(124,240,197,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      this.hits.push({ track: id, x, y, w, h });
    }

    let freeY = 80;
    for (const [id, msg] of hud.cards) {
      const c = this._raster('card:' + id, msg, drawPersonCard, deltasAnimating(msg));
      const w = c.width / 2, h = c.height / 2;
      const b = hud.bboxFor(id);
      let x, y;
      if (b) {
        x = vr.x + (b[0] + b[2]) * vr.w + 12;
        y = vr.y + b[1] * vr.h;
        if (x + w > innerWidth - 8) x = vr.x + b[0] * vr.w - w - 12;
      } else {
        x = innerWidth - w - 24; y = freeY; freeY += h + 10;
      }
      ctx.drawImage(c, x, y, w, h);
      placed.set(id, { x, y, w, h });
      this.hits.push({ track: id, x, y, w, h });
    }

    for (const [id, msg] of hud.activity) {
      // Re-raster while any worker is running so the dots pulse.
      const c = this._raster('act:' + id, msg, drawAgentActivity, anyRunning(msg));
      const w = c.width / 2, h = c.height / 2;
      const p = placed.get(id);
      let x, y;
      if (p) { x = p.x; y = p.y + p.h + 8; }
      else { x = innerWidth - w - 24; y = freeY; freeY += h + 10; }
      ctx.drawImage(c, x, y, w, h);
      this.hits.push({ track: id, x, y, w, h });
    }

    safe('desktop swarm', () => this.swarm.draw(ctx, vr));
    safe('desktop dev', () => this.dev.draw(ctx, placed, vr));
    safe('desktop brain', () => this.brain.draw(ctx, placed, vr));
    safe('desktop memory', () => this.mem.draw(ctx));
    safe('desktop vision', () => this.vfx.draw(ctx, placed, vr, this.hits));

    let ty = innerHeight - 56;
    for (const t of hud.liveToasts().reverse()) {
      const c = this._raster('toast:' + t.t, t, drawMemoryToast);
      const w = c.width / 2, h = c.height / 2;
      ctx.globalAlpha = t.age < 0.08 ? t.age / 0.08 : t.age > 0.85 ? (1 - t.age) / 0.15 : 1;
      ctx.drawImage(c, (innerWidth - w) / 2, ty, w, h);
      ctx.globalAlpha = 1;
      ty -= h + 8;
    }
  }
}
