// GBRAIN live feed: every GBrain op the world service makes (contracts/EVENTS.md `gbrain_op`) animates in
// as one line near the person card: op icon, actor tag (PERCEPTION / LIVE / CARD / QM·CONTEXT ...),
// slug or query, hit count, latency. Reads in ACCENT, writes warmer. When a QM worker reads the person's
// page, a thin link pulses between this panel and the person card. Max 8 lines, old ones fade.
//
// Hooks (one line each in the shared files):
//   hud.js      applyBrain(hud, msg) in apply()
//   desktop.js  DesktopBrain: draw(ctx, placed, vr) after the dev cockpit
//   xr.js       XrBrain: frame(head, headQ, meshes, dev) after XrDev
// swarmviz.js consumes gbrain_op on its own (observeSwarm runs before this); nothing here touches it.
import * as THREE from 'three';
import { ANIM_HZ, due } from './perf.js';
import { BRAIN_LINES, XR, xrAt, xrGraph } from './layout.js';

const FONT = 'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const ACCENT = '#7cf0c5';
const WARM = '#ffc98a';
const BAD = '#ff6b7a';
const DIM = 'rgba(232,236,240,0.45)';
const MID = 'rgba(232,236,240,0.7)';
const S = 2;

const W = 240;
const HEAD_H = 30;
const LINE_H = 31;
const MAX_LINES = BRAIN_LINES; // layout.js: 5 in ?hud=demo, 8 in full
const IN_MS = 360;     // slide + fade in
const LIFE_MS = 14000; // then fade out over the last 2s
const OUT_MS = 2000;
const PULSE_MS = 1400;

const READS = new Set(['query', 'search', 'get_page']);
const OP_LABEL = { query: 'QUERY', search: 'SEARCH', get_page: 'READ', put_page: 'WRITE', add_timeline_entry: 'LOG', add_link: 'LINK' };

const now = () => performance.now();

// ---------------------------------------------------------------- state

export function applyBrain(hud, msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.kind === 'clear') { hud.brain = null; return false; }
  if (msg.kind !== 'gbrain_op') return false;
  const b = (hud.brain ||= { lines: [], pulse: null, v: 0 });
  const t = now();
  b.lines.push({ ...msg, t });
  if (b.lines.length > MAX_LINES) b.lines.splice(0, b.lines.length - MAX_LINES);
  b.v++;
  // a QM worker reading the person in front of you: pulse panel <-> card
  const actor = String(msg.actor || '');
  const personRead = READS.has(msg.op) && (msg.person_id || /^(people|relationships)\//.test(msg.slug || ''));
  if (actor.startsWith('qm:') && personRead) b.pulse = { t, person_id: msg.person_id || null, actor };
  if (import.meta.env?.DEV) window.__brain = b;
  return true;
}

function liveLines(hud, t) {
  const b = hud.brain;
  if (!b) return [];
  const before = b.lines.length;
  b.lines = b.lines.filter((l) => t - l.t < LIFE_MS);
  if (b.lines.length !== before) b.v++;
  return b.lines;
}

const animating = (lines, pulse, t) => lines.some((l) => t - l.t < IN_MS || t - l.t > LIFE_MS - OUT_MS) || (pulse && t - pulse.t < PULSE_MS);

// ---------------------------------------------------------------- canvas

function panel(w, h) {
  const c = document.createElement('canvas');
  c.width = w * S; c.height = h * S;
  const ctx = c.getContext('2d');
  ctx.scale(S, S);
  return { c, ctx };
}

function text(ctx, s, x, y, { size = 12, weight = 400, color = '#e8ecf0', font = FONT, track = 0, max, align = 'left' } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${track}px`;
  let str = String(s ?? '');
  if (max) while (str.length > 1 && ctx.measureText(str).width > max) str = str.slice(0, -2) + '…';
  ctx.fillText(str, x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  const w = ctx.measureText(str).width;
  ctx.textAlign = 'left';
  return w;
}

export function actorTag(a) {
  const s = String(a || 'world');
  return s.startsWith('qm:') ? `QM·${s.slice(3).toUpperCase()}` : s.toUpperCase();
}

const hitCount = (h) => (Array.isArray(h) ? h.length : typeof h === 'number' ? h : null);

// tiny op glyphs, drawn so they look the same on every platform font
function icon(ctx, op, x, y, col) {
  ctx.save();
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.3;
  if (op === 'query' || op === 'search') { // magnifier
    ctx.beginPath(); ctx.arc(x, y - 1, 3.4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 2.5, y + 1.5); ctx.lineTo(x + 5, y + 4); ctx.stroke();
  } else if (op === 'get_page') { // open page
    ctx.strokeRect(x - 3.5, y - 5, 7, 9);
    ctx.beginPath(); ctx.moveTo(x - 1.5, y - 2); ctx.lineTo(x + 1.5, y - 2); ctx.moveTo(x - 1.5, y + 1); ctx.lineTo(x + 1.5, y + 1); ctx.stroke();
  } else if (op === 'put_page') { // filled page
    ctx.fillRect(x - 3.5, y - 5, 7, 9);
  } else if (op === 'add_timeline_entry') { // tick on a rail
    ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  } else { // add_link: two nodes
    ctx.beginPath(); ctx.moveTo(x - 3, y + 2); ctx.lineTo(x + 3, y - 3); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - 3, y + 2, 1.8, 0, Math.PI * 2); ctx.arc(x + 3, y - 3, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

export function drawBrainPanel(lines, pulse, t = now()) {
  const n = Math.max(1, lines.length);
  const h = HEAD_H + n * LINE_H + 8;
  const { c, ctx } = panel(W, h);
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, W - 1, h - 1, 14);
  ctx.fillStyle = 'rgba(8, 10, 14, 0.66)';
  ctx.fill();
  const glow = pulse ? Math.max(0, 1 - (t - pulse.t) / PULSE_MS) : 0;
  ctx.strokeStyle = glow ? `rgba(124,240,197,${0.14 + 0.5 * glow})` : 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // header
  const live = lines.length && t - lines[lines.length - 1].t < 1500;
  ctx.fillStyle = ACCENT;
  ctx.globalAlpha = live ? 0.5 + 0.5 * Math.abs(Math.sin(t / 260)) : 0.5;
  ctx.beginPath(); ctx.arc(17, 18, 3, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  text(ctx, 'GBRAIN', 27, 22, { size: 9.5, weight: 600, color: DIM, track: 1.4 });
  const reads = lines.filter((l) => READS.has(l.op)).length;
  text(ctx, `${reads} read · ${lines.length - reads} write`, W - 16, 22, { size: 10, font: MONO, color: DIM, align: 'right' });

  if (!lines.length) {
    text(ctx, 'idle', 16, HEAD_H + 14, { size: 11, color: DIM });
    return c;
  }
  let y = HEAD_H + 14;
  lines.forEach((l, i) => {
    const age = t - l.t;
    const kin = Math.min(1, age / IN_MS);
    const e = 1 - Math.pow(1 - kin, 3);
    const out = age > LIFE_MS - OUT_MS ? Math.max(0, (LIFE_MS - age) / OUT_MS) : 1;
    const read = READS.has(l.op);
    const col = l.ok === false ? BAD : read ? ACCENT : WARM;
    ctx.save();
    const alpha = e * out * (1 - 0.06 * (lines.length - 1 - i)); // older lines recede
    ctx.globalAlpha = alpha;
    ctx.translate(-10 * (1 - e), 0);
    if (age < 900) { // fresh-line sweep
      ctx.fillStyle = read ? 'rgba(124,240,197,0.10)' : 'rgba(255,201,138,0.10)';
      ctx.globalAlpha *= 1 - age / 900;
      ctx.fillRect(6, y - 12, W - 12, LINE_H - 3);
      ctx.globalAlpha = alpha;
    }
    icon(ctx, l.op, 18, y - 4, col);
    const tag = actorTag(l.actor);
    const qm = String(l.actor || '').startsWith('qm:');
    text(ctx, tag, 30, y, { size: 8.5, weight: 700, track: 0.8, color: qm ? '#e8ecf0' : MID, max: 120 });

    const hc = hitCount(l.hits);
    const right = `${hc != null ? `${hc} hit${hc === 1 ? '' : 's'} · ` : ''}${l.count > 1 ? `×${l.count} · ` : ''}${l.ms != null ? `${Math.round(l.ms)}ms` : ''}`;
    text(ctx, right, W - 14, y, { size: 9.5, font: MONO, color: DIM, align: 'right' });
    const subject = l.query ? `“${l.query}”` : l.op === 'add_link' && l.to ? `${l.slug} → ${l.to}` : (l.slug || OP_LABEL[l.op] || l.op);
    text(ctx, subject, 30, y + 14, { size: 10.5, font: l.query ? FONT : MONO, color: l.miss ? DIM : col, max: W - 44 });
    ctx.restore();
    y += LINE_H;
  });
  return c;
}

// ---------------------------------------------------------------- desktop

export class DesktopBrain {
  constructor(hud) { this.hud = hud; this.cache = null; this.rect = null; }

  // placed: Map(track id -> card rect); vr: video rect
  draw(ctx, placed, vr) {
    const hud = this.hud, t = now();
    const lines = liveLines(hud, t);
    this.rect = null;
    if (!hud.brain || (!lines.length && !placed.size)) return;
    const pulse = hud.brain.pulse;
    const key = hud.brain.v;
    // redraw on change, or at <= ANIM_HZ while lines slide / fade (perf.js)
    if (!this.cache || this.cache.key !== key || (animating(lines, pulse, t) && due(this.cache, ANIM_HZ, t))) this.cache = { key, c: drawBrainPanel(lines, pulse, t), _drawT: t };
    const z = hud.ld, k = z ? z.k : 1;
    const c = this.cache.c, w = (c.width / S) * k, h = (c.height / S) * k;
    // far left rail (layout.js), under the control panel
    const [, card] = [...placed.entries()][0] || [];
    let x = z ? z.brain.x : 16, y = z ? z.brain.y : 96;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    y = Math.max(8, Math.min(innerHeight - h - 8, y));
    ctx.drawImage(c, x, y, w, h);
    this.rect = { x, y, w, h };
    if (card && pulse) this._pulse(ctx, { x, y, w, h }, card, pulse, t);
  }

  _pulse(ctx, p, card, pulse, t) {
    const k = (t - pulse.t) / PULSE_MS;
    if (k < 0 || k > 1) return;
    const a = { x: p.x + p.w, y: p.y + 20 };
    const z = { x: card.x, y: card.y + 22 };
    const cx = (a.x + z.x) / 2, cy = Math.min(a.y, z.y) - 70; // arc over the face, not through it
    ctx.save();
    ctx.strokeStyle = `rgba(124,240,197,${0.55 * (1 - k)})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.lineDashOffset = -t / 30;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cx, cy, z.x, z.y); ctx.stroke();
    ctx.setLineDash([]);
    const u = Math.min(1, k * 1.6); // a bead runs card -> panel (the page travels to the agent)
    const q = (s, e, m) => (1 - u) * (1 - u) * s + 2 * (1 - u) * u * m + u * u * e;
    ctx.fillStyle = `rgba(124,240,197,${1 - k})`;
    ctx.beginPath(); ctx.arc(q(z.x, a.x, cx), q(z.y, a.y, cy), 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.font = `700 8.5px ${FONT}`;
    ctx.fillStyle = `rgba(232,236,240,${0.8 * (1 - k)})`;
    ctx.textAlign = 'center';
    ctx.fillText(`${actorTag(pulse.actor)} READ`, cx, cy + 30);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}

// ---------------------------------------------------------------- XR

const M_PER_PX = 0.00105; // same scale as the dev cockpit panels

export class XrBrain {
  constructor(scene, hud) {
    this.scene = scene; this.hud = hud;
    this.m = null; // { mesh, key, w, h, placed }
    const geo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 24 }, () => new THREE.Vector3()));
    this.link = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x7cf0c5, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
    this.link.renderOrder = 11;
    this.link.frustumCulled = false;
    scene.add(this.link);
    if (import.meta.env?.DEV) window.__xrBrain = this;
  }

  _mesh(canvas, key) {
    const w = (canvas.width / S) * M_PER_PX, h = (canvas.height / S) * M_PER_PX;
    const m = this.m;
    if (m && Math.abs(m.w - w) < 1e-6 && Math.abs(m.h - h) < 1e-6) {
      m.mesh.material.map.image = canvas; m.mesh.material.map.needsUpdate = true; m.key = key;
      return m;
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    mesh.renderOrder = 10;
    if (m) { mesh.position.copy(m.mesh.position); this._drop(); }
    this.scene.add(mesh);
    return (this.m = { mesh, key, w, h, placed: !!m });
  }

  _drop() {
    if (!this.m) return;
    this.scene.remove(this.m.mesh);
    this.m.mesh.geometry.dispose(); this.m.mesh.material.map.dispose(); this.m.mesh.material.dispose();
    this.m = null;
  }

  // meshes: xr.js card meshes; dev: XrDev (its GitHub panel sits left of the person, we go under it)
  frame(head, headQ, meshes, dev) {
    const hud = this.hud, t = now();
    const lines = liveLines(hud, t);
    const card = [...meshes.entries()].find(([k]) => k.startsWith('card:'))?.[1];
    if (!hud.brain || (!lines.length && !card)) { this._drop(); this.link.material.opacity = 0; return; }
    const pulse = hud.brain.pulse;
    const key = `${hud.brain.v}:${animating(lines, pulse, t) ? Math.floor(t / (1000 / ANIM_HZ)) : 's'}`; // <= ANIM_HZ uploads (perf.js)
    const m = this.m && this.m.key === key ? this.m : this._mesh(drawBrainPanel(lines, pulse, t), key);
    // far left rail (layout.js): right edge just left of the graph's EVENT spine, top at the rail line
    const L = hud.lx;
    const sc = XR.panel;
    m.mesh.scale.setScalar(sc);
    let target;
    if (L) {
      const G = xrGraph(L, XR.dist);
      const xr = G.x - XR.brainClear * G.eff - XR.colGap;
      target = xrAt(L, xr - (m.w * sc) / 2, XR.leftTop - (m.h * sc) / 2);
    } else {
      target = new THREE.Vector3(-0.42, -0.1, -1.4).applyQuaternion(headQ).add(head);
    }
    if (!m.placed) { m.mesh.position.copy(target); m.placed = true; } else m.mesh.position.lerp(target, 0.12);
    m.mesh.lookAt(head);

    // pulse link: a thin arc from the panel's right edge to the card's left edge
    const k = pulse ? (t - pulse.t) / PULSE_MS : 2;
    if (card && k >= 0 && k <= 1) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(m.mesh.quaternion);
      const a = m.mesh.position.clone().addScaledVector(right, (m.w * sc) / 2).add(new THREE.Vector3(0, (m.h * sc) / 2 - 0.03, 0));
      const cr = new THREE.Vector3(1, 0, 0).applyQuaternion(card.mesh.quaternion);
      const z = card.mesh.position.clone().addScaledVector(cr, -card.mesh.geometry.parameters.width / 2)
        .add(new THREE.Vector3(0, card.mesh.geometry.parameters.height / 2 - 0.03, 0));
      const mid = a.clone().add(z).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.12, 0));
      const pos = this.link.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const u = i / (pos.count - 1);
        const p = a.clone().multiplyScalar((1 - u) * (1 - u)).add(mid.clone().multiplyScalar(2 * (1 - u) * u)).add(z.clone().multiplyScalar(u * u));
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
      this.link.material.opacity = 0.7 * (1 - k);
    } else this.link.material.opacity = 0;
  }
}

// ---------------------------------------------------------------- mock (?mock=1)
// [ms, msg] entries merged into mock.js BASE_SCRIPT, on the DEV_SCRIPT clock (card 800, run 1 swarm 6000,
// learned 17600, run 2 23500). Latencies are choreography, not measurements.
const op = (actor, o, x = {}) => ({ kind: 'gbrain_op', actor, op: o, ok: true, ...x });
const REL = 'relationships/stephen-matthew';
const PROC = 'procedures/add-discord-command';
const FR1 = 'feature-requests/2026-09-27-add-recap-command';
const FR2 = 'feature-requests/2026-09-27-add-streak-command';
const hits = (...s) => s.map((slug) => ({ slug, title: slug.split('/').pop().replace(/^\d{4}-\d\d-\d\d-/, '').replace(/-/g, ' ') }));

export const BRAIN_SCRIPT = [
  // the card: perception reads the person + relationship pages
  [700, op('card', 'get_page', { slug: 'people/matthew', person_id: 'matthew', title: 'Matthew', ms: 84 })],
  [760, op('card', 'get_page', { slug: REL, person_id: 'matthew', ms: 61 })],
  [900, op('perception', 'add_timeline_entry', { slug: 'people/matthew', person_id: 'matthew', ms: 112 })],
  // live pass compounds the relationship page
  [2400, op('live', 'put_page', { slug: REL, person_id: 'matthew', ms: 143 })],
  [3800, op('live', 'put_page', { slug: REL, person_id: 'matthew', ms: 131 })],
  // the feature request lands as a page, linked to Matthew
  [4200, op('perception', 'put_page', { slug: FR1, ms: 156, event_id: 'evt_recap' })],
  [4500, op('perception', 'add_link', { slug: FR1, to: 'people/matthew', person_id: 'matthew', ms: 48, event_id: 'evt_recap' })],
  // run 1 swarm: Context reads the person, then prior signals; Product looks for prior art; Builder never reads
  [6200, op('qm:Context', 'get_page', { slug: 'people/matthew', person_id: 'matthew', title: 'Matthew', ms: 92, event_id: 'evt_recap' })],
  [6700, op('qm:Context', 'query', { query: 'matthew opal feedback', hits: hits(REL, 'feedback/2026-09-20-opal-onboarding-feedback'), ms: 388, event_id: 'evt_recap' })],
  [7300, op('qm:Product', 'query', { query: 'discord command requests', hits: hits(FR1), ms: 341, event_id: 'evt_recap' })],
  [7500, op('live', 'put_page', { slug: REL, person_id: 'matthew', ms: 127 })],
  // Memorable learned it: the procedure becomes a GBrain page linked to where it came from
  [17900, op('memorable', 'put_page', { slug: PROC, title: 'add discord command', ms: 170, event_id: 'evt_recap' })],
  [18100, op('memorable', 'add_link', { slug: PROC, to: 'people/matthew', person_id: 'matthew', ms: 52, event_id: 'evt_recap' })],
  // run 2: the learned procedure is in GBrain now, Product finds it
  [22700, op('perception', 'put_page', { slug: FR2, ms: 149, event_id: 'evt_streak' })],
  [23700, op('qm:Context', 'get_page', { slug: 'people/matthew', person_id: 'matthew', title: 'Matthew', ms: 88, event_id: 'evt_streak' })],
  [24100, op('qm:Context', 'query', { query: 'matthew opal feedback', hits: hits(FR1, REL), ms: 352, event_id: 'evt_streak' })],
  [24600, op('qm:Product', 'query', { query: 'discord command requests', hits: hits(PROC, FR1), ms: 319, event_id: 'evt_streak' })],
  [24900, op('qm:Product', 'get_page', { slug: PROC, title: 'add discord command', ms: 77, event_id: 'evt_streak' })],
  [28600, op('memorable', 'add_timeline_entry', { slug: PROC, ms: 96, event_id: 'evt_streak' })],
];
