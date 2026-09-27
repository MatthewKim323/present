// Perception overlay: the machine visibly SEES, RECOGNIZES and LEARNS the person in front of you.
// Data from the world service (contracts/EVENTS.md): `vision` (~5 Hz per tracked face), `face_capture`
// (transient crops while learning), `relationship_vector` (radar next to the person card).
// Same look as panels.js / devpanels.js: dark glass, small type, one accent. Subtle, not giant.
//
// Hooks (one-liners in the shared files):
//   hud.js      applyVision(hud, msg) right after applyDev
//   desktop.js  DesktopVision.draw(ctx, placed, vr) after the dev cockpit
//   xr.js       XrVision(scene, hud) in start(), .frame(xrHud, head, headQ) at the end of _frame
//   mock.js     VISION_SCRIPT + VISION_LEAD (scripted: unknown -> intro -> learning -> recognized -> radar grows)
import * as THREE from 'three';
import { LITE, ANIM_HZ, due } from './perf.js';

const FONT = 'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const ACCENT = '#7cf0c5';
const WARN = '#ffb86b';
const INK = '#e8ecf0';
const DIM = 'rgba(232,236,240,0.45)';
const MID = 'rgba(232,236,240,0.66)';
const S = 2;

const STALE_MS = 1500;        // vision track disappears if not refreshed
const LOCK_MS = 420;          // lock-on animation when a face is recognized
const DECODE_MS = 320;        // label chip "decodes" letter by letter
const FILM_HOLD_MS = 2600;    // filmstrip stays after learning finishes
const RADAR_ANIM_MS = 700;
const MAX_FILM = 12;

const now = () => performance.now();
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const easeOut = (x) => 1 - Math.pow(1 - clamp(x), 3);
const upper = (s) => String(s || '').toUpperCase();

const STATE_COLOR = {
  detecting: 'rgba(232,236,240,0.7)',
  matching: WARN,
  unknown: 'rgba(232,236,240,0.85)',
  recognized: ACCENT,
  learning: ACCENT,
};

// ---------------------------------------------------------------- state

export function applyVision(hud, msg) {
  if (!msg || typeof msg !== 'object') return false;
  hud.vfx ||= { faces: new Map(), film: new Map(), radar: new Map(), learnedAt: new Map() };
  const v = hud.vfx;
  switch (msg.kind) {
    case 'vision': {
      const t = now();
      if (msg.w && msg.h) hud.frameSize = [msg.w, msg.h];
      for (const e of Array.isArray(msg.tracks) ? msg.tracks : []) {
        if (!e || !Array.isArray(e.bbox) || e.bbox.length < 4 || !e.bbox.every(Number.isFinite)) continue; // malformed: skip, don't crash the frame
        const prev = v.faces.get(String(e.track_id));
        const f = prev || { sig: null, since: t };
        if (!prev || prev.e.state !== e.state) {
          f.since = t;
          if (prev && prev.e.state === 'learning' && e.state === 'recognized') learned(hud, e);
        }
        f.e = e; f.t = t;
        v.faces.set(String(e.track_id), f);
        hud._track(e.track_id, e.bbox, e.name);
      }
      return true;
    }
    case 'face_capture': {
      const k = String(msg.track_id);
      const list = v.film.get(k) || [];
      const img = new Image();
      img.src = `data:image/jpeg;base64,${msg.jpeg_b64}`; // shown, never stored
      list.push({ img, t: now(), n: msg.n, needed: msg.needed });
      v.film.set(k, list.slice(-MAX_FILM));
      return true;
    }
    case 'relationship_vector': {
      const prev = v.radar.get(msg.person_id);
      const from = prev ? shownDims(prev) : (msg.dims || []).map((d) => ({ ...d, value: 0 }));
      v.radar.set(msg.person_id, { ...msg, from, t: now() });
      return true;
    }
    case 'memory_event':
      // the service's PERSON ENROLLED toast duplicates our FACE LEARNED one
      return msg.text === 'PERSON ENROLLED' && [...v.learnedAt.values()].some((x) => now() - x < 6000);
    case 'clear':
      v.faces.clear(); v.film.clear(); v.radar.clear(); v.learnedAt.clear();
      return false;
    default:
      return false;
  }
}

function learned(hud, e) {
  hud.vfx.learnedAt.set(String(e.track_id), now());
  hud.apply({ kind: 'memory_event', text: 'FACE LEARNED', detail: upper(e.name) });
}

function liveFaces(hud, t = now()) {
  const out = [];
  for (const [k, f] of hud.vfx?.faces || []) {
    if (t - f.t > STALE_MS) { hud.vfx.faces.delete(k); continue; }
    out.push([k, f]);
  }
  return out;
}

function shownDims(r, t = now()) {
  const p = LITE ? 1 : easeOut((t - r.t) / RADAR_ANIM_MS);
  return (r.dims || []).map((d, i) => ({ label: d.label, value: (r.from[i]?.value ?? 0) + (d.value - (r.from[i]?.value ?? 0)) * p }));
}

// ---------------------------------------------------------------- drawing helpers

function text(ctx, s, x, y, { size = 11, weight = 400, color = INK, font = FONT, track = 0, align = 'left', max } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${track}px`;
  let str = String(s ?? '');
  if (max) while (str.length > 1 && ctx.measureText(str).width > max) str = str.slice(0, -2) + '…';
  ctx.fillText(str, x, y);
  const w = ctx.measureText(str).width;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  return w;
}

function glass(ctx, x, y, w, h, r = 8, fill = 'rgba(8, 10, 14, 0.62)') {
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function decode(str, since, t) {
  const age = t - since;
  if (age > DECODE_MS + str.length * 18) return str;
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    out += ch === ' ' || age > i * 18 + DECODE_MS * 0.5 ? ch : GLYPHS[(Math.floor(t / 40) + i * 7) % GLYPHS.length];
  }
  return out;
}

function chipLabel(e) {
  const sc = (x) => (x ?? 0).toFixed(2);
  switch (e.state) {
    case 'detecting': return ['DETECTING', `${sc(e.det_score)}`];
    case 'matching': return ['MATCHING', sc(e.match_score)];
    case 'unknown': return [upper(e.name || 'UNKNOWN PERSON'), sc(e.match_score)];
    case 'learning': return [`LEARNING · ${upper(e.name)}`, `${e.samples?.n ?? 0}/${e.samples?.needed ?? 10}`];
    default: return [upper(e.name), sc(e.match_score)];
  }
}

// Draw one tracked face into ctx. r = face rect in ctx px. f = { e, since, sig }.
// Layout: brackets on the face, landmarks, scan line, candidates to the LEFT (the person card sits right),
// chip + barcode + filmstrip BELOW.
export function drawFace(ctx, r, f, film, t = now(), learnedAt = 0) {
  const e = f.e;
  const col = STATE_COLOR[e.state] || INK;
  const lockAge = e.state === 'recognized' ? t - f.since : 1e9;
  const lock = easeOut(lockAge / LOCK_MS);
  const searching = e.state === 'detecting' || e.state === 'matching';
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;

  // corner brackets: breathe while searching, snap in on lock
  const breathe = searching ? 1 + 0.035 * Math.sin(t / 180) : 1;
  const k = (e.state === 'recognized' ? 1 + 0.35 * (1 - lock) : 1) * breathe;
  const w = r.w * k, h = r.h * k, x0 = cx - w / 2, y0 = cy - h / 2;
  const L = Math.max(8, Math.min(w, h) * 0.2);
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth = e.state === 'recognized' ? 2 : 1.5;
  ctx.globalAlpha = e.state === 'detecting' ? 0.75 : 1;
  if (!LITE && e.state === 'recognized' && lockAge < LOCK_MS * 1.6) { ctx.shadowColor = ACCENT; ctx.shadowBlur = 14 * (1 - lock); }
  ctx.beginPath();
  for (const [px, py, dx, dy] of [[x0, y0, 1, 1], [x0 + w, y0, -1, 1], [x0, y0 + h, 1, -1], [x0 + w, y0 + h, -1, -1]]) {
    ctx.moveTo(px + dx * L, py); ctx.lineTo(px, py); ctx.lineTo(px, py + dy * L);
  }
  ctx.stroke();
  ctx.restore();

  // tiny corner readouts
  ctx.globalAlpha = 0.8;
  text(ctx, `FACE ${(e.det_score ?? 0).toFixed(2)}`, x0, y0 - 5, { size: 8.5, font: MONO, color: DIM });
  text(ctx, `#${String(e.track_id).padStart(2, '0')}`, x0 + w, y0 - 5, { size: 8.5, font: MONO, color: DIM, align: 'right' });
  ctx.globalAlpha = 1;

  // scan line sweeping while searching (off in ?lite=1)
  if (searching && !LITE) {
    const p = ((t / 1100) % 1);
    const sy = r.y + p * r.h;
    const g = ctx.createLinearGradient(0, sy - r.h * 0.18, 0, sy);
    g.addColorStop(0, 'rgba(124,240,197,0)');
    g.addColorStop(1, 'rgba(124,240,197,0.16)');
    ctx.fillStyle = g;
    ctx.fillRect(r.x + 2, sy - r.h * 0.18, r.w - 4, r.h * 0.18);
    ctx.strokeStyle = 'rgba(124,240,197,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(r.x + 2, sy); ctx.lineTo(r.x + r.w - 2, sy); ctx.stroke();
  }

  // landmarks (normalized in frame coords -> face rect via the bbox)
  if (e.landmarks && e.bbox) {
    const [bx, by, bw, bh] = e.bbox;
    const pts = e.landmarks.map(([lx, ly]) => [r.x + ((lx - bx) / bw) * r.w, r.y + ((ly - by) / bh) * r.h]);
    ctx.strokeStyle = 'rgba(124,240,197,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [a, b] of [[0, 1], [0, 2], [1, 2], [2, 3], [2, 4], [3, 4]]) { ctx.moveTo(...pts[a]); ctx.lineTo(...pts[b]); }
    ctx.stroke();
    pts.forEach(([px, py], i) => {
      ctx.globalAlpha = LITE ? 0.85 : 0.6 + 0.4 * Math.abs(Math.sin(t / 300 + i));
      ctx.fillStyle = ACCENT;
      ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  // learning ring: progress arc + one tick per sample
  if (e.state === 'learning' || (learnedAt && t - learnedAt < 900)) {
    const n = e.samples?.n ?? (e.state === 'learning' ? 0 : 1), need = e.samples?.needed ?? 1;
    const frac = e.state === 'learning' ? clamp(n / need) : 1;
    const R = Math.max(r.w, r.h) * 0.72;
    const fade = e.state === 'learning' ? 1 : 1 - (t - learnedAt) / 900;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.beginPath(); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.stroke();
    for (let i = 0; i < need; i++) {
      const a = -Math.PI / 2 + (i / need) * Math.PI * 2;
      ctx.strokeStyle = i < n ? ACCENT : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (R + 3), cy + Math.sin(a) * (R + 3)); ctx.lineTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8)); ctx.stroke();
    }
    // sweeping head on the arc
    const ha = -Math.PI / 2 + frac * Math.PI * 2;
    ctx.fillStyle = ACCENT;
    ctx.beginPath(); ctx.arc(cx + Math.cos(ha) * R, cy + Math.sin(ha) * R, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // candidates, left of the face
  const cands = (e.top_candidates || []).slice(0, 3);
  const candFade = e.state === 'recognized' ? clamp(1 - (lockAge - 2500) / 600) : 1; // settles away after lock-on
  if (cands.length && e.state !== 'detecting' && candFade > 0) {
    ctx.save();
    ctx.globalAlpha = candFade;
    const cw = 108, rh = 15, ch = 20 + cands.length * rh;
    const lx = x0 - cw - 10, ly = y0;
    glass(ctx, lx, ly, cw, ch, 7, 'rgba(8,10,14,0.5)');
    text(ctx, 'CANDIDATES', lx + 8, ly + 13, { size: 7.5, weight: 600, color: DIM, track: 1.2 });
    cands.forEach((c, i) => {
      const yy = ly + 27 + i * rh;
      const top = i === 0 && e.state === 'recognized';
      text(ctx, c.name, lx + 8, yy, { size: 9.5, color: top ? ACCENT : MID, max: 48 });
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(lx + 54, yy - 6, 22, 4);
      ctx.fillStyle = top ? ACCENT : 'rgba(232,236,240,0.55)';
      ctx.fillRect(lx + 54, yy - 6, 22 * clamp(c.score), 4);
      text(ctx, c.score.toFixed(2), lx + cw - 6, yy, { size: 8.5, font: MONO, color: DIM, align: 'right' });
    });
    ctx.restore();
  }

  // label chip under the face
  const [main, score] = chipLabel(e);
  const shown = e.state === 'recognized' || e.state === 'unknown' ? decode(main, f.since, t) : main;
  ctx.font = `600 10.5px ${FONT}`;
  const mw = ctx.measureText(shown).width + shown.length * 1.2;
  ctx.font = `400 10px ${MONO}`;
  const sw = ctx.measureText(score).width;
  const chipW = mw + sw + 34, chipH = 20;
  const chipX = cx - chipW / 2, chipY = y0 + h + 8;
  const pop = e.state === 'recognized' ? 1 + 0.12 * (1 - lock) : 1;
  ctx.save();
  ctx.translate(cx, chipY + chipH / 2); ctx.scale(pop, pop); ctx.translate(-cx, -(chipY + chipH / 2));
  glass(ctx, chipX, chipY, chipW, chipH, 10, e.state === 'recognized' ? 'rgba(10,30,24,0.72)' : 'rgba(8,10,14,0.66)');
  ctx.fillStyle = col;
  ctx.globalAlpha = searching ? 0.45 + 0.55 * Math.abs(Math.sin(t / 220)) : 1;
  ctx.beginPath(); ctx.arc(chipX + 10, chipY + 10, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  text(ctx, shown, chipX + 18, chipY + 14, { size: 10.5, weight: 600, color: e.state === 'recognized' ? ACCENT : INK, track: 1.2 });
  text(ctx, score, chipX + chipW - 8, chipY + 14, { size: 10, font: MONO, color: MID, align: 'right' });
  ctx.restore();

  // embedding barcode: 16 bars, lerped so they shimmer between embeds
  let by = chipY + chipH + 6;
  if (e.embedding_sig) {
    f.sig ||= e.embedding_sig.map(() => 0.5);
    f.sig = f.sig.map((v, i) => v + ((e.embedding_sig[i] ?? v) - v) * 0.18);
    const bw = 3, gap = 1.5, bh = 14, total = 16 * bw + 15 * gap;
    const bx = cx - total / 2;
    f.sig.forEach((v, i) => {
      const hh = 2 + v * (bh - 2);
      ctx.fillStyle = e.state === 'recognized' || e.state === 'learning' ? ACCENT : 'rgba(232,236,240,0.7)';
      ctx.globalAlpha = 0.35 + 0.65 * v;
      ctx.fillRect(bx + i * (bw + gap), by + bh - hh, bw, hh);
    });
    ctx.globalAlpha = 1;
    text(ctx, 'SFACE·128→16', bx + total + 6, by + bh - 2, { size: 7.5, font: MONO, color: DIM });
    by += bh + 6;
  }

  // filmstrip of captured samples (slides in from the right)
  const learningLike = e.state === 'learning' || (learnedAt && t - learnedAt < FILM_HOLD_MS);
  if (film && film.length && learningLike) {
    const th = 26, gap = 3;
    const shownFilm = film.slice(-8);
    const total = shownFilm.length * (th + gap) - gap;
    const fx = cx - total / 2;
    const fade = e.state === 'learning' ? 1 : clamp(1 - (t - learnedAt - FILM_HOLD_MS * 0.6) / (FILM_HOLD_MS * 0.4));
    ctx.save();
    ctx.globalAlpha = fade;
    shownFilm.forEach((s, i) => {
      const a = easeOut((t - s.t) / 260);
      const x = fx + i * (th + gap) + (1 - a) * 24;
      ctx.globalAlpha = fade * a;
      ctx.save();
      ctx.beginPath(); ctx.roundRect(x, by, th, th, 4); ctx.clip();
      if (s.img.complete && s.img.naturalWidth) ctx.drawImage(s.img, x, by, th, th);
      else { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(x, by, th, th); }
      ctx.restore();
      ctx.strokeStyle = i === shownFilm.length - 1 && e.state === 'learning' ? ACCENT : 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x + 0.5, by + 0.5, th - 1, th - 1, 4); ctx.stroke();
      // shutter flash on the newest sample
      if (t - s.t < 180) { ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - (t - s.t) / 180)})`; ctx.fillRect(x, by, th, th); }
    });
    ctx.restore();
    text(ctx, e.state === 'learning' ? 'CAPTURING · embeddings only' : `${film.length} SAMPLES · stored as embeddings`,
      cx, by + th + 11, { size: 7.5, font: MONO, color: DIM, align: 'center' });
  }
}

// ---------------------------------------------------------------- radar

export const RADAR_W = 184, RADAR_H = 196;
const AXIS = { familiarity: 'FAMILIAR', knowledge: 'KNOWS', topics: 'TOPICS', 'open loops': 'LOOPS', warmth: 'WARMTH', recency: 'RECENT' };

export function drawRadar(r, t = now()) {
  const c = document.createElement('canvas');
  c.width = RADAR_W * S; c.height = RADAR_H * S;
  const ctx = c.getContext('2d');
  ctx.scale(S, S);
  glass(ctx, 0, 0, RADAR_W, RADAR_H, 14, 'rgba(8,10,14,0.66)');
  text(ctx, 'RELATIONSHIP', 14, 20, { size: 8.5, weight: 600, color: DIM, track: 1.4 });
  text(ctx, r.name || '', RADAR_W - 14, 20, { size: 9.5, weight: 600, color: ACCENT, track: 1, align: 'right', max: 70 });
  const dims = shownDims(r, t);
  const n = dims.length || 1;
  const cx = RADAR_W / 2, cy = 102, R = 50;
  const ang = (i) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  for (const f of [0.33, 0.66, 1]) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { const a = ang(i % n); const x = cx + Math.cos(a) * R * f, y = cy + Math.sin(a) * R * f; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const a = ang(i);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    const lx = cx + Math.cos(a) * (R + 12), ly = cy + Math.sin(a) * (R + 12) + 3;
    const align = Math.abs(Math.cos(a)) < 0.2 ? 'center' : Math.cos(a) > 0 ? 'left' : 'right';
    text(ctx, AXIS[dims[i].label] || upper(dims[i].label), lx, ly, { size: 7, weight: 600, color: DIM, track: 0.8, align });
  }
  const age = t - r.t;
  ctx.beginPath();
  dims.forEach((d, i) => { const a = ang(i), v = 0.04 + 0.96 * clamp(d.value); const x = cx + Math.cos(a) * R * v, y = cy + Math.sin(a) * R * v; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  ctx.fillStyle = `rgba(124,240,197,${0.16 + 0.14 * (1 - easeOut(age / 1200))})`;
  ctx.fill();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  dims.forEach((d, i) => {
    const a = ang(i), v = 0.04 + 0.96 * clamp(d.value);
    const grew = (d.value - (r.from[i]?.value ?? 0)) > 0.01 || (r.dims[i]?.value ?? 0) - (r.from[i]?.value ?? 0) > 0.01;
    const pulse = grew && age < 1200 ? 1 + 1.5 * (1 - age / 1200) : 1;
    ctx.fillStyle = ACCENT;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v, 2.2 * pulse, 0, Math.PI * 2); ctx.fill();
  });
  const foot = `${r.facts_count ?? 0} facts`;
  const fw = text(ctx, foot, 14, RADAR_H - 14, { size: 9, font: MONO, color: MID });
  if (r.last_delta) text(ctx, `+ ${r.last_delta}`, 22 + fw, RADAR_H - 14, { size: 9, color: age < 1500 ? INK : MID, max: RADAR_W - 36 - fw });
  return c;
}

const radarAnimating = (r, t = now()) => !LITE && t - r.t < 1300;

function radarFor(hud, cardMsg) {
  const radar = hud.vfx?.radar;
  if (!radar || !radar.size) return null;
  return (cardMsg && radar.get(cardMsg.person_id)) || (radar.size === 1 ? [...radar.values()][0] : null);
}

// ---------------------------------------------------------------- desktop

export class DesktopVision {
  constructor(hud) {
    this.hud = hud;
    this.radarCache = new Map();
  }

  // placed: Map(track id -> card rect) from desktop.js; vr: video rect on screen; hits: desktop.js rects (card, activity).
  draw(ctx, placed, vr, hits = []) {
    const hud = this.hud;
    const t = now();
    for (const [k, f] of liveFaces(hud, t)) {
      const [bx, by, bw, bh] = f.e.bbox;
      const r = { x: vr.x + bx * vr.w, y: vr.y + by * vr.h, w: bw * vr.w, h: bh * vr.h };
      drawFace(ctx, r, f, hud.vfx.film.get(k), t, hud.vfx.learnedAt.get(k) || 0);
    }
    // radar above the person card, else under the card column (card, deltas, activity), never over the face
    for (const [id, rect] of placed) {
      const r = radarFor(hud, hud.cards.get(id));
      if (!r) continue;
      let c = this.radarCache.get(r.person_id);
      if (!c || c.r !== r || radarAnimating(r, t)) { c = { r, canvas: drawRadar(r, t) }; this.radarCache.set(r.person_id, c); }
      const w = RADAR_W, h = RADAR_H;
      let x = rect.x, y = rect.y - h - 10;
      if (y < 8) {
        const col = hits.filter((hh) => hh.track === id && hh.x >= rect.x - 1 && hh.y >= rect.y - 1);
        y = Math.max(...col.map((hh) => hh.y + hh.h), rect.y + rect.h) + 10;
        if (y + h > innerHeight - 8) { x = rect.x + rect.w + 12; y = rect.y; } // no room below: beside the card
      }
      if (x + w > innerWidth - 8) x = innerWidth - w - 8;
      ctx.drawImage(c.canvas, x, y, w, h);
      break;
    }
  }
}

// ---------------------------------------------------------------- XR

const M_PER_PX = 0.0012; // same as the person card
const PAD_L = 140, PAD_R = 90, PAD_T = 80, PAD_B = 130, FACE_PX = 200;
// Face plane supersample in XR. The plane spans ~25 deg at 1.6 m (~500 headset px), so 1.25x (~540 texels
// wide) is already sharper than the display; 2x was an 860 px upload every frame.
const VFX_S = 1.25;
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1); // shared by every face / radar plane (scaled per mesh)
const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _v = new THREE.Vector3();

export class XrVision {
  constructor(scene, hud) {
    this.scene = scene;
    this.hud = hud;
    this.meshes = new Map(); // key -> { mesh, canvas, cw, ch }
  }

  // Unit plane scaled to (wm, hm) meters; the canvas (cw x ch css px) is only rebuilt when its size changes.
  _plane(k, cw, ch, wm, hm, sc = VFX_S) {
    let m = this.meshes.get(k);
    if (!m || m.cw !== cw || m.ch !== ch) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(cw * sc); canvas.height = Math.round(ch * sc);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      // redrawn often: no mipmap rebuild per upload (the texture is ~1:1 with display pixels anyway)
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(UNIT_PLANE, mat);
      mesh.renderOrder = 9; // under the cards
      if (m) { mesh.position.copy(m.mesh.position); mesh.userData.placed = true; this._drop(k); }
      this.scene.add(mesh);
      m = { mesh, canvas, cw, ch, sc };
      this.meshes.set(k, m);
    }
    m.mesh.scale.set(wm, hm, 1);
    return m;
  }

  _drop(k) {
    const m = this.meshes.get(k);
    if (!m) return;
    this.scene.remove(m.mesh);
    m.mesh.material.map.dispose(); m.mesh.material.dispose(); // geometry is the shared UNIT_PLANE
    this.meshes.delete(k);
  }

  // xr: XrHud (for _rayPoint, config, meshes). Called at the end of XrHud._frame.
  frame(xr, head, headQ) {
    const hud = this.hud;
    const t = now();
    const seen = new Set();
    const dist = xr.config.cardDistance;
    const hfov = THREE.MathUtils.degToRad(xr.config.hfov);
    const [fw, fh] = hud.frameSize;
    const right = _right.set(1, 0, 0).applyQuaternion(headQ);
    const up = _up.set(0, 1, 0).applyQuaternion(headQ);
    for (const [k, f] of liveFaces(hud, t)) {
      const [bx, by, bw, bh] = f.e.bbox;
      const facePxH = Math.max(96, Math.round(FACE_PX * (bh * fh) / Math.max(1e-6, bw * fw) / 16) * 16); // quantized: canvas rebuilt rarely
      const cw = PAD_L + FACE_PX + PAD_R, ch = PAD_T + facePxH + PAD_B;
      const faceM = dist * 2 * Math.tan(hfov / 2) * bw; // bbox width in meters at `dist`
      const mpp = faceM / FACE_PX;
      const key = 'vfx:' + k;
      seen.add(key);
      const m = this._plane(key, cw, ch, cw * mpp, ch * mpp);
      // animated reticle: redraw + re-upload at ANIM_HZ, not every frame (position still follows every frame)
      if (m.e !== f.e || due(m, ANIM_HZ, t)) {
        m.e = f.e;
        const ctx = m.canvas.getContext('2d');
        ctx.setTransform(m.sc, 0, 0, m.sc, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        drawFace(ctx, { x: PAD_L, y: PAD_T, w: FACE_PX, h: facePxH }, f, hud.vfx.film.get(k), t, hud.vfx.learnedAt.get(k) || 0);
        m.mesh.material.map.needsUpdate = true;
      }
      // face center in the world, then shift so the canvas' face rect sits on it
      const p = xr._rayPoint(head, headQ, bx + bw / 2, by + bh / 2, dist);
      const dx = (cw / 2 - (PAD_L + FACE_PX / 2)) * mpp, dy = (ch / 2 - (PAD_T + facePxH / 2)) * mpp;
      p.addScaledVector(right, dx).addScaledVector(up, -dy);
      if (!m.mesh.userData.placed) { m.mesh.position.copy(p); m.mesh.userData.placed = true; } else m.mesh.position.lerp(p, 0.35);
      m.mesh.quaternion.copy(headQ);
    }
    // radar above the first person card
    for (const [id, msg] of hud.cards) {
      const r = radarFor(hud, msg);
      const card = (hud.selectedTrack === String(id) && xr.meshes.get('detail:person')) || xr.meshes.get('label:' + id);
      if (!r || !card) continue;
      seen.add('radar');
      const wm = RADAR_W * M_PER_PX, hm = RADAR_H * M_PER_PX;
      const m = this._plane('radar', RADAR_W, RADAR_H, wm, hm, S);
      if (m.r !== r || (radarAnimating(r, t) && due(m, ANIM_HZ, t))) {
        const src = drawRadar(r, t);
        const ctx = m.canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, m.canvas.width, m.canvas.height);
        ctx.drawImage(src, 0, 0, m.canvas.width, m.canvas.height);
        m.mesh.material.map.needsUpdate = true;
        m.r = r;
      }
      const ch = card.mesh.geometry.parameters.height;
      const target = _v.copy(card.mesh.position).add(_right.set(0, ch / 2 + hm / 2 + 0.02, 0));
      if (!m.mesh.userData.placed) { m.mesh.position.copy(target); m.mesh.userData.placed = true; } else m.mesh.position.lerp(target, 0.15);
      m.mesh.lookAt(head);
      break;
    }
    for (const k of [...this.meshes.keys()]) if (!seen.has(k)) this._drop(k);
  }
}

// ---------------------------------------------------------------- mock (?mock=1)

// Scripted: unknown face -> "hey, I'm Matthew" -> learning filmstrip -> recognized -> radar grows.
// mock.js shifts the rest of the demo by VISION_LEAD so the card appears right after the lock-on.
export const VISION_LEAD = 6500;
const LEARN_AT = 3600, SAMPLE_MS = 260, NEEDED = 10, LEARNED_AT = LEARN_AT + NEEDED * SAMPLE_MS + 150;
const MOCK_END = 34000;

function mockSig(seed, jitter) {
  return Array.from({ length: 16 }, (_, i) => +(0.5 + 0.42 * Math.sin(seed * 1.7 + i * 2.3) * Math.cos(i * 0.9 + seed) + jitter * Math.sin(i * 5.1)).toFixed(2))
    .map((v) => clamp(v));
}

function mockFace(ms) {
  const s = Math.sin(ms / 1400);
  const bbox = [0.43 + 0.012 * s, 0.2 + 0.006 * Math.cos(ms / 900), 0.13, 0.18];
  const [x, y, w, h] = bbox;
  const lm = [[x + 0.31 * w, y + 0.42 * h], [x + 0.69 * w, y + 0.42 * h], [x + 0.5 * w, y + 0.6 * h], [x + 0.36 * w, y + 0.8 * h], [x + 0.64 * w, y + 0.8 * h]];
  const base = { track_id: 3, bbox, landmarks: lm.map(([a, b]) => [+a.toFixed(4), +b.toFixed(4)]), det_score: +(0.9 + 0.04 * Math.sin(ms / 300)).toFixed(2), person_id: null };
  const j = 0.04 * Math.sin(ms / 170);
  if (ms < 900) return { ...base, state: 'detecting', name: null, match_score: 0, top_candidates: [], embedding_sig: null };
  const strangers = [{ name: 'Stephen', score: +(0.14 + j).toFixed(2) }, { name: 'Priya', score: +(0.09 + j / 2).toFixed(2) }];
  if (ms < 2400) return { ...base, state: 'matching', name: null, match_score: strangers[0].score, top_candidates: strangers, embedding_sig: mockSig(3, j) };
  if (ms < LEARN_AT) return { ...base, state: 'unknown', name: 'UNKNOWN PERSON 03', match_score: strangers[0].score, top_candidates: strangers, embedding_sig: mockSig(3, j) };
  if (ms < LEARNED_AT) {
    const n = Math.min(NEEDED, Math.floor((ms - LEARN_AT) / SAMPLE_MS) + 1);
    return { ...base, state: 'learning', name: 'Matthew', match_score: 0, top_candidates: strangers, embedding_sig: mockSig(3, j), samples: { n, needed: NEEDED } };
  }
  const sc = +(0.86 + 0.02 * Math.sin(ms / 500)).toFixed(2);
  return { ...base, state: 'recognized', person_id: 'matthew', name: 'Matthew', match_score: sc,
    top_candidates: [{ name: 'Matthew', score: sc }, ...strangers], embedding_sig: mockSig(3, j / 3) };
}

// Fake face crop for the filmstrip (the real one is a 96px JPEG from the service).
function mockCrop(i) {
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 96, 96);
  bg.addColorStop(0, '#2b3440'); bg.addColorStop(1, '#161b22');
  g.fillStyle = bg; g.fillRect(0, 0, 96, 96);
  const dx = 4 * Math.sin(i * 1.3), tilt = 0.08 * Math.sin(i * 0.7);
  g.save(); g.translate(48 + dx, 50); g.rotate(tilt);
  g.fillStyle = '#c99a7c'; g.beginPath(); g.ellipse(0, 4, 24, 30, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1d1a18'; g.beginPath(); g.ellipse(0, -18, 26, 16, 0, Math.PI, Math.PI * 2); g.fill();
  g.fillStyle = '#2a2320'; g.fillRect(-12, -2, 7, 3); g.fillRect(5, -2, 7, 3);
  g.fillStyle = '#8a5a4a'; g.fillRect(-8, 18, 16, 2.5);
  g.restore();
  return c.toDataURL('image/jpeg', 0.7).split(',')[1];
}

const MOCK_DIMS = (fam, know, top, loops, warm, rec) => [
  { label: 'familiarity', value: fam }, { label: 'knowledge', value: know }, { label: 'topics', value: top },
  { label: 'open loops', value: loops }, { label: 'warmth', value: warm }, { label: 'recency', value: rec }];

const rv = (dims, facts, last) => ({ kind: 'relationship_vector', person_id: 'matthew', name: 'MATTHEW', dims, facts_count: facts, last_delta: last });

export const VISION_SCRIPT = [
  ...Array.from({ length: Math.floor(MOCK_END / 200) }, (_, i) => [i * 200, null]).map(([ms]) => [ms, { kind: 'vision', w: 640, h: 480, tracks: [mockFace(ms)] }]),
  ...Array.from({ length: NEEDED }, (_, i) => [LEARN_AT + i * SAMPLE_MS + 20, { kind: 'face_capture', track_id: 3, name: 'Matthew', n: i + 1, needed: NEEDED, _mock: i }]),
  [VISION_LEAD + 900, rv(MOCK_DIMS(0.28, 0.1, 0.17, 0.25, 0.5, 1), 1, null)],
  [VISION_LEAD + 2300, rv(MOCK_DIMS(0.28, 0.2, 0.17, 0.25, 0.5, 1), 2, 'wants payouts explained up front')],
  [VISION_LEAD + 3700, rv(MOCK_DIMS(0.28, 0.3, 0.33, 0.25, 0.22, 1), 3, 'found the landing page confusing')],
  [VISION_LEAD + 7300, rv(MOCK_DIMS(0.28, 0.3, 0.5, 0.5, 0.5, 1), 3, 'send him the PR when it lands')],
  [VISION_LEAD + 12000, rv(MOCK_DIMS(0.28, 0.4, 0.67, 0.5, 0.8, 1), 4, 'excited about the preview')],
];

// face_capture mock entries carry an index; build the crop lazily (needs a DOM canvas).
export function mockResolve(msg) {
  if (msg && msg.kind === 'face_capture' && msg._mock != null && !msg.jpeg_b64) return { ...msg, jpeg_b64: mockCrop(msg._mock) };
  if (msg && msg.kind === 'vision') return { ...msg, ts: Date.now() / 1000 };
  return msg;
}
