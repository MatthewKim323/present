// Live captions: the last couple of transcribed lines (world service `caption` messages), shown low in view.
// Transient by design: nothing is stored, lines fade after a few seconds.
import * as THREE from 'three';

const KEEP = 2;
const TTL = 7000;
const W = 900, H = 120, S = 2;

export function applyCaption(hud, msg) {
  if (msg.kind !== 'caption') return false;
  const text = String(msg.text || '').trim();
  if (!text) return true;
  hud.captions = (hud.captions || []).concat({ who: String(msg.who || '').toUpperCase(), text, t: performance.now() }).slice(-KEEP);
  hud.captionsRev = (hud.captionsRev || 0) + 1;
  return true;
}

function live(hud) {
  const now = performance.now();
  return (hud.captions || []).filter((c) => now - c.t < TTL);
}

function paint(ctx, lines, w, clear = true) {
  if (clear) ctx.clearRect(0, 0, w, H);
  if (!lines.length) return;
  ctx.fillStyle = 'rgba(8,10,14,0.62)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 24 + lines.length * 40, 14);
  ctx.fill();
  let y = 44;
  for (const c of lines) {
    const age = (performance.now() - c.t) / TTL;
    ctx.globalAlpha = age > 0.75 ? Math.max(0, (1 - age) * 4) : 1;
    ctx.font = '600 20px ui-sans-serif, -apple-system, system-ui, sans-serif';
    ctx.fillStyle = c.who === 'YOU' || c.who === 'STEPHEN' ? '#ffb86b' : '#7cf0c5';
    const tag = c.who ? `${c.who}  ` : '';
    ctx.fillText(tag, 18, y);
    const tw = ctx.measureText(tag).width;
    ctx.font = '400 22px ui-sans-serif, -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#e8ecf0';
    let s = c.text;
    while (s.length > 1 && ctx.measureText(s).width > w - tw - 36) s = '…' + s.slice(2);
    ctx.fillText(s, 18 + tw, y);
    ctx.globalAlpha = 1;
    y += 40;
  }
}

export class XrCaptions {
  constructor(scene, hud) {
    this.hud = hud;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W * S; this.canvas.height = H * S;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(S, S);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62 * H / W), mat);
    this.mesh.renderOrder = 999;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._rev = -1; this._n = -1;
    this._off = new THREE.Vector3();
  }

  frame(head, headQ) {
    const lines = live(this.hud);
    this.mesh.visible = lines.length > 0;
    if (!this.mesh.visible) return;
    // head-locked, low in view, eased so it doesn't jitter with small head moves
    this._off.set(0, -0.3, -0.95).applyQuaternion(headQ).add(head);
    this.mesh.position.lerp(this._off, 0.25);
    this.mesh.quaternion.slerp(headQ, 0.25);
    const fading = lines.some((c) => performance.now() - c.t > TTL * 0.75);
    if (this._rev !== this.hud.captionsRev || this._n !== lines.length || fading) {
      this._rev = this.hud.captionsRev; this._n = lines.length;
      paint(this.ctx, lines, W);
      this.tex.needsUpdate = true;
    }
  }
}

export class DesktopCaptions {
  constructor(hud) { this.hud = hud; }

  draw(ctx, w, h) {
    const lines = live(this.hud);
    if (!lines.length) return;
    const cw = Math.min(900, w - 40);
    ctx.save();
    ctx.translate((w - cw) / 2, h - 24 - (24 + lines.length * 40));
    paint(ctx, lines, cw, false);
    ctx.restore();
  }
}
