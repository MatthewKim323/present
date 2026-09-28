// Memorable on the HUD: procedural memory ("what have I learned how to do"), drawn apart from GBrain's
// declarative memory. Same dark glass as panels.js; GBrain keeps the mint ACCENT, Memorable gets a quiet
// lavender so the two memory systems never read as one.
//
// Reads (contracts/EVENTS.md): `procedure` {phase: recording|extracting|learned|recalled|refused},
// `procedure_library`, and observes `qm_swarm` (Builder tool tail -> the live tool-call tape).
// One stack, body-locked under the QM SWARM panel:
//   library strip   MEMORABLE · procedural memory              3 learned
//   chip            MEMORABLE · RECORDING  ||||||||||           12 tool calls
//   card            PROCEDURE LEARNED / RECALLED, numbered steps, trigger, -> saved to GBrain · procedures/<slug>
//   toast           NOT LEARNED · no_postcondition (honest refusals)
//
// Hooks (one line each): hud.js applyMemory(hud, msg); desktop.js DesktopMemory; xr.js XrMemory; mock.js MEMORY_SCRIPT.
import * as THREE from 'three';
import { ANIM_HZ } from './perf.js';
import { XR, xrAt, xrCardRight } from './layout.js';

const FONT = 'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const ACCENT = '#7cf0c5'; // GBrain / WORLD
const WARN = '#ffb86b';
const DIM = 'rgba(232,236,240,0.45)';
const MID = 'rgba(232,236,240,0.66)';
const INK = '#e8ecf0';
const MEM = '#b9a8ff'; // Memorable: procedural memory
const MEM_RGB = '185,168,255';
const S = 2;
const W = 320; // same column width as the QM SWARM panel

const CLASS_COLOR = { search: '#9cc6ff', read: MID, write: ACCENT, execute: WARN };
const TOOL_CLASS = { Read: 'read', WebFetch: 'read', Grep: 'search', Glob: 'search', WebSearch: 'search',
  Edit: 'write', Write: 'write', MultiEdit: 'write', NotebookEdit: 'write', Bash: 'execute' };
const REASONS = { no_postcondition: 'run ended without a passing check', 'empty trace': 'no tool calls captured',
  'not admitted': 'the judge did not admit it', too_short: 'trace too short to generalize' };

const CARD_MS = { learned: 16000, recalled: 14000 };
const TOAST_MS = 7000;
const SETTLE_MS = 2600;    // chip lingers after the swarm settles without an extraction
const STALE_MS = 180000;   // a recording nobody updates for this long is gone
const MAX_STEPS = 8;
const STEP_MS = 150;       // learned: steps materialize one by one
const SWEEP_MS = 210;      // recalled: highlight sweep per step
const TAPE_MAX = 46;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (p) => 1 - Math.pow(1 - clamp01(p), 3);
const now = () => performance.now();

// ---------------------------------------------------------------- state

const fresh = () => ({ v: 0, lib: null, libBump: 0, freshTitles: [], rec: null, card: null, toast: null, done: new Set() });

// Returns true when the message was consumed. qm_swarm and clear are observed only (devpanels.js / hud.js own them).
export function applyMemory(hud, msg) {
  if (!msg || typeof msg !== 'object') return false;
  const m = (hud.mem ||= fresh());
  const t = now();
  switch (msg.kind) {
    case 'procedure':
      onProcedure(m, msg, t);
      m.v++;
      return true;
    case 'procedure_library': {
      const items = Array.isArray(msg.items) ? msg.items : [];
      const prev = m.lib && new Set(m.lib.map((i) => i.title));
      m.freshTitles = prev ? items.map((i) => i.title).filter((x) => !prev.has(x)) : [];
      const usesUp = prev && items.some((i) => (m.lib.find((o) => o.title === i.title)?.uses ?? i.uses) < i.uses);
      if (m.freshTitles.length || usesUp) m.libBump = t;
      m.lib = items;
      m.v++;
      return true;
    }
    case 'qm_swarm':
      observeSwarm(m, msg, t);
      m.v++;
      return false;
    case 'clear':
      hud.mem = fresh();
      return false;
    default:
      return false;
  }
}

function newRec(key, msg, t) {
  return { key, event_id: msg.event_id, job_id: msg.job_id, source: msg.source || 'qm-swarm', title: msg.title || null,
    phase: 'recording', seen: 0, tailCount: 0, count: 0, prevCount: 0, countT: 0, tape: [], prevTail: null, t0: t, tu: t, tx: 0, settled: null };
}

const keyOf = (msg) => msg.event_id || msg.job_id || 'solo';
const sameRun = (r, msg) => r && (r.key === keyOf(msg) || (msg.job_id && r.job_id === msg.job_id));

function onProcedure(m, msg, t) {
  const key = keyOf(msg);
  switch (msg.phase) {
    case 'recording':
    case 'extracting': {
      if (!sameRun(m.rec, msg)) m.rec = newRec(key, msg, t);
      const r = m.rec;
      for (const k of ['event_id', 'job_id', 'source', 'title']) if (msg[k]) r[k] = msg[k];
      if (msg.phase === 'extracting' && r.phase !== 'extracting') r.tx = t;
      r.phase = msg.phase;
      r.tu = t;
      r.settled = null;
      if (msg.tool_calls_seen != null) r.seen = Math.max(r.seen, Number(msg.tool_calls_seen) || 0);
      syncTape(r, t);
      return;
    }
    case 'learned':
    case 'recalled':
      m.card = { ...msg, mode: msg.phase, t0: t };
      if (msg.phase === 'learned') { if (sameRun(m.rec, msg) || m.rec?.phase === 'extracting') m.rec = null; m.done.add(key); }
      return;
    case 'refused':
      m.toast = { ...msg, t0: t };
      if (sameRun(m.rec, msg) || m.rec?.phase === 'extracting') m.rec = null;
      m.done.add(key);
      return;
    default:
  }
}

// qm_swarm: a running Builder lane means an agent is working, so Memorable is watching its trace.
function observeSwarm(m, msg, t) {
  const workers = msg.workers || [];
  const b = workers.find((w) => /builder/i.test(w.name || ''));
  const running = workers.some((w) => (w.state || 'running') === 'running');
  const key = msg.event_id || `swarm:${msg.hook || ''}`;
  if (running && !m.done.has(key) && (!m.rec || (m.rec.key !== key && m.rec.phase !== 'extracting'))) {
    m.rec = newRec(key, { event_id: msg.event_id, source: 'qm-swarm' }, t);
  }
  const r = m.rec;
  if (!r || r.key !== key) return;
  if (b?.tail) addTail(r, b.tail, t);
  if (running) { r.settled = null; r.tu = t; } else if (r.phase === 'recording' && r.settled == null) r.settled = t;
}

function addTail(r, tail, t) {
  const cur = tail.map((e) => `${e.tool}|${e.target}`);
  const prev = r.prevTail || [];
  let k = 0;
  for (let n = Math.min(prev.length, cur.length); n > 0; n--) {
    if (prev.slice(prev.length - n).every((x, i) => x === cur[i])) { k = n; break; }
  }
  for (const e of tail.slice(k)) {
    r.tailCount++;
    const c = TOOL_CLASS[e.tool] || 'execute';
    // already counted via tool_calls_seen: color the oldest uncolored bar instead of adding one
    const slot = r.tailCount <= r.count ? r.tape.find((x) => !x.c) : null;
    if (slot) slot.c = c; else r.tape.push({ c, t });
  }
  r.prevTail = cur;
  syncTape(r, t);
}

function syncTape(r, t) {
  const count = Math.max(r.seen, r.tailCount);
  while (r.tape.length < count) r.tape.push({ c: null, t });
  if (count !== r.count) { r.prevCount = r.count; r.count = count; r.countT = t; }
  if (r.tape.length > TAPE_MAX) r.tape.splice(0, r.tape.length - TAPE_MAX);
}

// ---------------------------------------------------------------- canvas helpers

function panel(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * S);
  c.height = Math.ceil(h * S);
  const ctx = c.getContext('2d');
  ctx.scale(S, S);
  return { c, ctx };
}

function glass(ctx, x, y, w, h, r = 14, fill = 'rgba(8, 10, 14, 0.66)', stroke = 'rgba(255,255,255,0.14)') {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function text(ctx, s, x, y, { size = 12, weight = 400, color = INK, font = FONT, track = 0, max, align = 'left' } = {}) {
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

// Memorable's mark: a small loop with an arrowhead (learned from experience, used again).
function loopGlyph(ctx, x, y, r = 4.6, color = MEM, spin = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(spin);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI * 0.35, Math.PI * 1.45);
  ctx.stroke();
  const a = -Math.PI * 0.35, ax = r * Math.cos(a), ay = r * Math.sin(a);
  ctx.beginPath();
  ctx.moveTo(ax + 2.6, ay - 0.6);
  ctx.lineTo(ax - 0.6, ay - 2.4);
  ctx.lineTo(ax - 0.2, ay + 1.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Activity-class icons, ~10 px, stroked.
function classIcon(ctx, cls, cx, cy, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (cls === 'search') {
    ctx.arc(cx - 1, cy - 1, 3.1, 0, Math.PI * 2);
    ctx.moveTo(cx + 1.3, cy + 1.3); ctx.lineTo(cx + 4, cy + 4);
  } else if (cls === 'read') {
    ctx.moveTo(cx - 3.5, cy - 4.5); ctx.lineTo(cx + 1.5, cy - 4.5); ctx.lineTo(cx + 3.5, cy - 2.5); ctx.lineTo(cx + 3.5, cy + 4.5);
    ctx.lineTo(cx - 3.5, cy + 4.5); ctx.closePath();
    ctx.moveTo(cx - 1.5, cy - 0.5); ctx.lineTo(cx + 1.5, cy - 0.5);
    ctx.moveTo(cx - 1.5, cy + 2); ctx.lineTo(cx + 1.5, cy + 2);
  } else if (cls === 'write') {
    ctx.moveTo(cx - 3.8, cy + 3.8); ctx.lineTo(cx - 3, cy + 1.4); ctx.lineTo(cx + 2.4, cy - 4); ctx.lineTo(cx + 4, cy - 2.4);
    ctx.lineTo(cx - 1.4, cy + 3); ctx.closePath();
  } else { // execute
    ctx.moveTo(cx - 4, cy - 3); ctx.lineTo(cx - 0.8, cy); ctx.lineTo(cx - 4, cy + 3);
    ctx.moveTo(cx + 0.8, cy + 3.6); ctx.lineTo(cx + 4.2, cy + 3.6);
  }
  ctx.stroke();
  ctx.restore();
}

const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- blocks

// Library strip: count + last 3 titles.
export function drawLibrary(mem, t = now(), compact = false) {
  const items = mem.lib || [];
  const rows = compact ? [] : items.slice(0, 3);
  const h = compact ? 30 : 32 + (rows.length ? rows.length * 16 + 4 : 16);
  const { c, ctx } = panel(W, h);
  glass(ctx, 0, 0, W, h, 12);
  loopGlyph(ctx, 21, 16.5);
  const lw = text(ctx, 'MEMORABLE', 34, 21, { size: 9.5, weight: 600, color: MEM, track: 1.4 });
  text(ctx, '· procedural memory', 34 + lw + 6, 21, { size: 10, color: DIM });
  const bump = mem.libBump ? clamp01(1 - (t - mem.libBump) / 1600) : 0;
  const lab = text(ctx, 'learned', W - 16, 21, { size: 9.5, color: DIM, align: 'right' });
  text(ctx, String(items.length), W - 20 - lab, 21.5, { size: 13, weight: 600, font: MONO, color: bump > 0 ? MEM : INK, align: 'right' });
  if (compact) return c; // a card is up: header + count only
  if (!rows.length) {
    text(ctx, 'watching agent runs · nothing learned yet', 16, 42, { size: 10.5, color: DIM });
    return c;
  }
  rows.forEach((it, i) => {
    const y = 42 + i * 16;
    const isNew = bump > 0 && (mem.freshTitles.includes(it.title) || (!mem.freshTitles.length && i === 0));
    if (isNew) {
      ctx.fillStyle = `rgba(${MEM_RGB},${0.16 * bump})`;
      ctx.beginPath(); ctx.roundRect(8, y - 11, W - 16, 15, 5); ctx.fill();
    }
    ctx.fillStyle = MEM;
    ctx.globalAlpha = i === 0 ? 0.9 : 0.5;
    ctx.fillRect(18, y - 6, 4, 4);
    ctx.globalAlpha = 1;
    let rx = W - 16;
    const src = it.source === 'claude-code' ? 'CC' : 'QM';
    rx -= text(ctx, src, rx, y, { size: 8.5, weight: 600, color: DIM, track: 1, align: 'right' }) + 8;
    if (it.uses > 0) rx -= text(ctx, `↻${it.uses}`, rx, y, { size: 9.5, font: MONO, color: MEM, align: 'right' }) + 8;
    const steps = it.steps_count != null ? `  ${it.steps_count} steps` : '';
    const tw = text(ctx, it.title, 30, y, { size: 11, color: i === 0 ? INK : MID, max: rx - 30 - 58 });
    if (steps) text(ctx, steps, 30 + tw, y, { size: 9.5, color: DIM, max: rx - 34 - tw });
  });
  return c;
}

// Recording / extracting chip with the live tool-call counter and trace tape.
export function drawChip(r, t = now()) {
  const h = 50;
  const { c, ctx } = panel(W, h);
  glass(ctx, 0, 0, W, h, 13, 'rgba(8, 10, 14, 0.66)', `rgba(${MEM_RGB},0.28)`);
  const extracting = r.phase === 'extracting';
  // pulse: recording dot with an expanding ring; extracting: the loop spins
  if (extracting) loopGlyph(ctx, 21, 17, 4.6, MEM, t / 260);
  else {
    const p = (t % 1400) / 1400;
    ctx.strokeStyle = `rgba(${MEM_RGB},${0.55 * (1 - p)})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(21, 17, 3.5 + p * 6, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = MEM;
    ctx.beginPath(); ctx.arc(21, 17, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  const lw = text(ctx, 'MEMORABLE', 34, 21, { size: 9.5, weight: 600, color: MEM, track: 1.4 });
  text(ctx, extracting ? '· EXTRACTING' : '· RECORDING', 34 + lw + 6, 21, { size: 9.5, weight: 600, color: INK, track: 1.4 });

  // counter (rolls up when it changes)
  const unit = extracting ? 'calls → procedure' : `tool call${r.count === 1 ? '' : 's'}`;
  const uw = text(ctx, unit, W - 16, 21, { size: 9.5, color: DIM, align: 'right' });
  const nx = W - 20 - uw;
  const roll = r.countT ? clamp01((t - r.countT) / 260) : 1;
  ctx.save();
  ctx.beginPath(); ctx.rect(nx - 40, 7, 42, 18); ctx.clip();
  if (roll < 1) {
    ctx.globalAlpha = 1 - roll;
    text(ctx, String(r.prevCount), nx, 21.5 - 10 * easeOut(roll), { size: 13, weight: 600, font: MONO, color: MID, align: 'right' });
  }
  ctx.globalAlpha = easeOut(roll);
  text(ctx, String(r.count), nx, 21.5 + 10 * (1 - easeOut(roll)), { size: 13, weight: 600, font: MONO, color: roll < 1 ? MEM : INK, align: 'right' });
  ctx.restore();

  // tape: one bar per captured tool call, colored by activity class, newest grows in
  const x0 = 16, bw = 4, gap = 2, ty = 32, th = 10;
  const n = Math.min(r.tape.length, Math.floor((W - 32) / (bw + gap)));
  const tape = r.tape.slice(r.tape.length - n);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath(); ctx.roundRect(x0 - 3, ty - 2, W - 26, th + 4, 4); ctx.fill();
  tape.forEach((b, i) => {
    const grow = easeOut((t - b.t) / 320);
    const hh = th * Math.max(0.15, grow);
    ctx.fillStyle = b.c ? CLASS_COLOR[b.c] : `rgba(${MEM_RGB},0.55)`;
    ctx.globalAlpha = 0.45 + 0.55 * ((i + 1) / tape.length);
    ctx.fillRect(x0 + i * (bw + gap), ty + th - hh, bw, hh);
  });
  ctx.globalAlpha = 1;
  if (!tape.length) text(ctx, 'waiting for the first tool call…', x0, ty + 9, { size: 9.5, color: DIM });
  if (extracting) { // shimmer sweeping the trace: trace -> procedure
    const sw = ((t - r.tx) % 1100) / 1100;
    const gx = x0 - 30 + sw * (W - 2);
    const g = ctx.createLinearGradient(gx - 30, 0, gx + 30, 0);
    g.addColorStop(0, `rgba(${MEM_RGB},0)`); g.addColorStop(0.5, `rgba(${MEM_RGB},0.55)`); g.addColorStop(1, `rgba(${MEM_RGB},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x0 - 3, ty - 2, W - 26, th + 4);
  }
  return c;
}

function cardLayout(card) {
  const steps = (card.steps || []).slice(0, MAX_STEPS);
  const total = card.steps_total || (card.steps || []).length;
  const more = Math.max(0, total - steps.length);
  const mline = metricLine(card);
  const top = (card.trigger ? 80 : 64) + (mline ? 16 : 0);
  const h = top + steps.length * 19 + (more ? 16 : 0) + 38;
  return { steps, more, top, h, mline };
}

// Measured numbers from the run it was learned from (only what the server sent; never estimated here).
function metricLine(card) {
  const m = card.mode === 'learned' && card.metrics;
  if (!m) return null;
  const parts = [];
  if (m.tool_calls != null) parts.push(`${m.tool_calls} tool calls`);
  if (m.turns != null) parts.push(`${m.turns} turns`);
  const secs = m.seconds ?? m.seconds_to_pr;
  if (secs != null) parts.push(`${Math.round(secs)}s${m.seconds == null ? ' to PR' : ''}`);
  return parts.length ? parts.join(' · ') : null;
}

// Learned / recalled procedure card. Steps animate: learned materializes them one by one,
// recalled sweeps a highlight down them as they are injected into the Builder.
export function drawCard(card, t = now()) {
  const { steps, more, top, h, mline } = cardLayout(card);
  const { c, ctx } = panel(W, h);
  const age = t - card.t0;
  const recalled = card.mode === 'recalled';
  glass(ctx, 0, 0, W, h, 14, 'rgba(8, 10, 14, 0.7)', `rgba(${MEM_RGB},0.34)`);
  // accent rail on the left edge
  ctx.fillStyle = `rgba(${MEM_RGB},0.8)`;
  ctx.beginPath(); ctx.roundRect(0.5, 14, 2.5, h - 28, 1.25); ctx.fill();

  loopGlyph(ctx, 21, 18, 4.6, MEM, recalled ? Math.min(1, age / 700) * Math.PI * 2 : 0);
  if (recalled) {
    ctx.fillStyle = MEM;
    ctx.beginPath(); ctx.roundRect(33, 8.5, 70, 17, 8.5); ctx.fill();
    text(ctx, 'RECALLED', 68, 21, { size: 9, weight: 700, color: '#15121f', track: 1.4, align: 'center' });
  } else {
    text(ctx, 'PROCEDURE LEARNED', 34, 22, { size: 9.5, weight: 600, color: MEM, track: 1.4 });
  }
  text(ctx, `memorable · ${card.source === 'claude-code' ? 'claude-code' : 'qm swarm'}`, W - 16, 22, { size: 9, font: MONO, color: DIM, align: 'right' });
  text(ctx, card.title || 'procedure', 16, 45, { size: 14, weight: 600, max: W - 32 });
  if (card.trigger) {
    const ww = text(ctx, 'WHEN', 16, 63, { size: 8.5, weight: 600, color: DIM, track: 1.2 });
    text(ctx, card.trigger, 16 + ww + 8, 63, { size: 10.5, color: MID, max: W - 40 - ww });
  }
  if (mline) {
    const my = card.trigger ? 79 : 63;
    const ww = text(ctx, 'FIRST RUN', 16, my, { size: 8.5, weight: 600, color: DIM, track: 1.2 });
    text(ctx, mline, 16 + ww + 8, my, { size: 10, font: MONO, color: MID, max: W - 40 - ww });
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.moveTo(16, top - 8); ctx.lineTo(W - 16, top - 8); ctx.stroke();

  steps.forEach((st, i) => {
    const y = top + i * 19;
    let alpha = 1, dx = 0, hl = 0;
    if (recalled) {
      const p = clamp01((age - 520 - i * SWEEP_MS) / 420);
      hl = Math.sin(Math.PI * p);
      alpha = 0.55 + 0.45 * (p > 0 ? 1 : 0.4);
    } else {
      const p = clamp01((age - 280 - i * STEP_MS) / 260);
      alpha = easeOut(p);
      dx = (1 - easeOut(p)) * 10;
      hl = p > 0 && p < 1 ? 1 - p : 0;
    }
    if (alpha <= 0.01) return;
    if (hl > 0.01) {
      ctx.fillStyle = `rgba(${MEM_RGB},${0.2 * hl})`;
      ctx.beginPath(); ctx.roundRect(9, y, W - 18, 17, 5); ctx.fill();
    }
    ctx.globalAlpha = alpha;
    const cls = st.activity_class || 'execute';
    text(ctx, pad2(st.seq ?? i + 1), 16 + dx, y + 12.5, { size: 9.5, font: MONO, color: hl > 0.3 ? MEM : DIM });
    classIcon(ctx, cls, 42 + dx, y + 8.5, CLASS_COLOR[cls] || MID);
    const aw = text(ctx, st.action || 'step', 54 + dx, y + 12.5, { size: 11, weight: 600, max: 90 });
    if (st.target) text(ctx, st.target, 62 + aw + dx, y + 12.5, { size: 10, font: MONO, color: MID, max: W - 78 - aw });
    ctx.globalAlpha = 1;
  });
  let y = top + steps.length * 19;
  const stepsDone = recalled ? 520 + steps.length * SWEEP_MS + 200 : 280 + steps.length * STEP_MS + 120;
  if (more) {
    ctx.globalAlpha = clamp01((age - stepsDone + 100) / 250);
    text(ctx, `+${more} more step${more === 1 ? '' : 's'}`, 54, y + 11, { size: 10, color: DIM });
    ctx.globalAlpha = 1;
    y += 16;
  }

  // footer: where it went. learned -> GBrain (mint, GBrain's color); recalled -> into the Builder
  const fa = easeOut((age - stepsDone) / 320);
  ctx.globalAlpha = fa;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.moveTo(16, y + 6); ctx.lineTo(W - 16, y + 6); ctx.stroke();
  const fy = y + 25;
  const slug = card.gbrain_slug;
  if (recalled) {
    const aw = text(ctx, '→', 16 + 4 * (1 - fa), fy, { size: 12, weight: 600, color: MEM });
    const iw = text(ctx, 'injected into Builder', 22 + aw, fy, { size: 10.5, weight: 600, color: INK });
    if (slug) text(ctx, `· from ${slug}`, 28 + aw + iw, fy, { size: 10, font: MONO, color: DIM, max: W - 44 - aw - iw });
  } else if (slug) {
    const aw = text(ctx, '→', 16 + 4 * (1 - fa), fy, { size: 12, weight: 600, color: ACCENT });
    const sw = text(ctx, 'saved to', 22 + aw, fy, { size: 10.5, color: MID });
    const gw = text(ctx, 'GBrain', 26 + aw + sw, fy, { size: 10.5, weight: 600, color: ACCENT });
    text(ctx, `· ${slug}`, 32 + aw + sw + gw, fy, { size: 10, font: MONO, color: MID, max: W - 48 - aw - sw - gw });
  } else {
    text(ctx, 'draft kept locally · not mirrored to GBrain', 16, fy, { size: 10, color: DIM });
  }
  ctx.globalAlpha = 1;

  // materialize: a thin lavender scan line passes down the card once
  const sp = clamp01(age / (recalled ? 500 : 700));
  if (sp < 1) {
    const sy = 4 + sp * (h - 8);
    const g = ctx.createLinearGradient(0, sy - 14, 0, sy + 1);
    g.addColorStop(0, `rgba(${MEM_RGB},0)`); g.addColorStop(1, `rgba(${MEM_RGB},${0.22 * (1 - sp)})`);
    ctx.fillStyle = g;
    ctx.fillRect(3, sy - 14, W - 6, 15);
    ctx.fillStyle = `rgba(${MEM_RGB},${0.8 * (1 - sp)})`;
    ctx.fillRect(10, sy, W - 20, 1);
  }
  return c;
}

// Honest refusal: Memorable looked at the run and did not learn from it. Reason verbatim + a gloss.
export function drawRefused(m) {
  const reason = String(m.reason || 'not admitted');
  const gloss = REASONS[reason] || '';
  const h = 50;
  const { c, ctx } = panel(W, h);
  glass(ctx, 0, 0, W, h, 13, 'rgba(8, 10, 14, 0.66)', 'rgba(255,184,107,0.3)');
  loopGlyph(ctx, 21, 16.5, 4.6, WARN);
  const hw = text(ctx, 'MEMORABLE · NOT LEARNED', 34, 21, { size: 9.5, weight: 600, color: WARN, track: 1.3 });
  if (m.title) text(ctx, m.title, W - 16, 21, { size: 10, color: DIM, align: 'right', max: W - 60 - hw });
  const rw = text(ctx, reason, 34, 39, { size: 10.5, font: MONO, color: INK, max: W - 50 });
  if (gloss) text(ctx, `· ${gloss}`, 40 + rw, 39, { size: 10, color: DIM, max: W - 56 - rw });
  return c;
}

// ---------------------------------------------------------------- stack

const envelope = (age, life, fadeIn = 220, fadeOut = 600) =>
  age < 0 ? 0 : age > life ? 0 : Math.min(clamp01(age / fadeIn), clamp01((life - age) / fadeOut));

// Current blocks, top to bottom, with alpha / slide. Also prunes expired state.
export function memoryBlocks(hud, t = now()) {
  const m = hud.mem;
  if (!m) return [];
  const out = [];
  let animating = false;
  const r = m.rec;
  if (r && ((r.settled != null && t - r.settled > SETTLE_MS) || t - r.tu > STALE_MS)) { m.rec = null; m.v++; }
  if (m.card && t - m.card.t0 > CARD_MS[m.card.mode] + 50) { m.card = null; m.v++; }
  if (m.toast && t - m.toast.t0 > TOAST_MS) { m.toast = null; m.v++; }
  const active = m.rec || m.card || m.toast;
  if ((m.lib && m.lib.length) || active) {
    out.push({ id: 'lib', canvas: drawLibrary(m, t, !!m.card), alpha: 1 });
    if (m.libBump && t - m.libBump < 1700) animating = true;
  }
  if (m.rec) {
    const rr = m.rec;
    const a = Math.min(clamp01((t - rr.t0) / 250), rr.settled != null ? clamp01(1 - (t - rr.settled - SETTLE_MS + 600) / 600) : 1);
    out.push({ id: 'chip', canvas: drawChip(rr, t), alpha: a });
    animating = true; // pulse + tape
  }
  if (m.card) {
    const age = t - m.card.t0, life = CARD_MS[m.card.mode];
    const a = envelope(age, life, m.card.mode === 'recalled' ? 320 : 240);
    const slide = m.card.mode === 'recalled' ? (1 - easeOut(age / 420)) * 26 : 0;
    out.push({ id: 'card', canvas: drawCard(m.card, t), alpha: a, dx: slide });
    if (age < 4200 || life - age < 700) animating = true;
  }
  if (m.toast) {
    const age = t - m.toast.t0;
    out.push({ id: 'toast', canvas: drawRefused(m.toast), alpha: envelope(age, TOAST_MS) });
    if (age < 300 || TOAST_MS - age < 700) animating = true;
  }
  out.animating = animating;
  return out;
}

// All blocks composited into one canvas (XR uses one mesh). null when nothing to show.
const GAP = 8;
export function drawMemoryStack(hud, t = now()) {
  const blocks = memoryBlocks(hud, t);
  if (!blocks.length) return null;
  const hs = blocks.map((b) => b.canvas.height / S);
  const h = hs.reduce((a, x) => a + x, 0) + GAP * (blocks.length - 1);
  const { c, ctx } = panel(W + 30, h); // +30: room for the recalled card's slide-in
  let y = 0;
  blocks.forEach((b, i) => {
    ctx.globalAlpha = clamp01(b.alpha);
    ctx.drawImage(b.canvas, b.dx || 0, y, W, hs[i]);
    y += hs[i] + GAP;
  });
  ctx.globalAlpha = 1;
  c.animating = blocks.animating;
  return c;
}

// ---------------------------------------------------------------- desktop

// Draws under the QM SWARM panel (devpanels.js DesktopDev.ssRect), else bottom right.
export class DesktopMemory {
  constructor(hud, dev) {
    this.hud = hud;
    this.dev = dev;
    this.cache = null;
    this.rect = null;
    if (import.meta.env?.DEV) window.__mem = this; // headless checks
  }

  draw(ctx) {
    const t = now();
    const mem = this.hud.mem;
    if (!mem) { this.rect = null; return; }
    let c;
    // redraw on change, else at <= ANIM_HZ while animating (perf.js), else once a second
    const ch = this.cache;
    if (ch && ch.v === mem.v && (ch.c.animating ? t - ch.t < 1000 / ANIM_HZ : t - ch.t < 1000)) c = ch.c;
    else { c = drawMemoryStack(this.hud, t); this.cache = c ? { v: mem.v, c, t } : null; }
    if (!c) { this.rect = null; return; }
    const w = c.width / S, h = c.height / S;
    const ss = this.dev?.ssRect;
    const z = this.hud.ld, kz = z ? z.k : 1;
    let x, y, k = kz;
    if (ss) {
      // far right rail, under the QM SWARM panel; shrinks (to 0.6 of the rail scale) before it leaves the screen
      x = ss.x; y = ss.y + ss.h + 10;
      k = Math.max(kz * 0.6, Math.min(kz, (innerHeight - 8 - y) / h));
    } else if (z) { x = z.right.x; y = z.right.y; } // no swarm panel: top of the right rail
    else { x = innerWidth - W - 24; y = innerHeight - h - 24; }
    x = Math.max(8, Math.min(innerWidth - W * k - 8, x));
    y = Math.max(8, Math.min(innerHeight - h * k - 8, y));
    ctx.drawImage(c, x, y, w * k, h * k);
    this.rect = { x, y, w: W * k, h: h * k, k };
  }
}

// ---------------------------------------------------------------- XR

const M_PER_PX = 0.00105; // same scale as the dev cockpit panels

export class XrMemory {
  constructor(scene, hud) {
    this.scene = scene;
    this.hud = hud;
    this.m = null; // { mesh, w, h, v, drawn, placed }
    this.anchorYaw = null;
    this.anchorPos = null;
    if (import.meta.env?.DEV) window.__xrMem = this;
  }

  _drop() {
    if (!this.m) return;
    this.scene.remove(this.m.mesh);
    this.m.mesh.geometry.dispose(); this.m.mesh.material.map.dispose(); this.m.mesh.material.dispose();
    this.m = null;
  }

  // dev: devpanels.js XrDev (its `ss` mesh is the QM SWARM panel we sit under)
  frame(head, headQ, dev) {
    const mem = this.hud.mem;
    const t = now();
    let m = this.m;
    const stale = !m || m.v !== mem?.v || m.animating || t - m.drawn > 1000;
    if (!mem) { this._drop(); return; }
    if (stale && (!m || t - m.drawn > 1000 / ANIM_HZ)) { // <= ANIM_HZ texture uploads while animating (perf.js)
      const c = drawMemoryStack(this.hud, t);
      if (!c) { this._drop(); return; }
      const w = (c.width / S) * M_PER_PX, h = (c.height / S) * M_PER_PX;
      if (m && Math.abs(m.w - w) < 1e-6 && Math.abs(m.h - h) < 1e-6) {
        m.mesh.material.map.image = c;
        m.mesh.material.map.needsUpdate = true;
      } else {
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
        mesh.renderOrder = 11;
        mesh.userData.dev = 'memorable';
        const prev = m;
        this.scene.add(mesh);
        m = this.m = { mesh, w, h, placed: false, top: prev?.top || null };
        if (prev) { mesh.position.copy(prev.mesh.position); m.placed = true; this.scene.remove(prev.mesh); prev.mesh.geometry.dispose(); prev.mesh.material.map.dispose(); prev.mesh.material.dispose(); }
      }
      m.v = mem.v; m.drawn = t; m.animating = !!c.animating;
    }
    if (!m) return;

    // top-left corner target: under the QM SWARM panel (far right rail, layout.js), else the top of that rail
    const ss = dev?.meshes?.ss;
    const L = this.hud.lx;
    const sc = XR.panel;
    m.mesh.scale.setScalar(sc);
    let top;
    if (ss) {
      const ssc = ss.mesh.scale.x || 1;
      top = ss.mesh.position.clone();
      top.y -= (ss.h * ssc) / 2 + XR.gap * 0.5;
      const r = new THREE.Vector3(1, 0, 0).applyQuaternion(ss.mesh.quaternion);
      top.addScaledVector(r, -(ss.w * ssc) / 2); // left edges aligned
    } else if (L) {
      const card = [...(dev?.cardMeshes || [])].find(([k]) => k.startsWith('card:'))?.[1];
      top = xrAt(L, xrCardRight(L, card?.mesh) + XR.colGap, XR.rightTop);
    } else {
      top = new THREE.Vector3(0.45, 0.1, -1.5).applyQuaternion(headQ).add(head);
    }
    const q = new THREE.Quaternion();
    const probe = new THREE.Object3D();
    probe.position.copy(top);
    probe.lookAt(head);
    q.copy(probe.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const target = top.clone().addScaledVector(right, (m.w * sc) / 2);
    target.y -= (m.h * sc) / 2;
    if (!m.placed) { m.mesh.position.copy(target); m.placed = true; } else m.mesh.position.lerp(target, 0.14);
    m.mesh.lookAt(head);
  }
}

// ---------------------------------------------------------------- mock (?mock=1)
//
// Mirrors DEV_SCRIPT (devpanels.js) times: run 1 (!recap) records the Builder's trace, extracts, learns
// "add discord command" and mirrors it to GBrain; run 2 (!streak) recalls it before the Builder starts.
// Counts are choreography for the mock only; real counts come from the Builder's StreamParser.

const PROC_TITLE = 'add discord command';
const STEPS = [
  { seq: 1, action: 'Grep', activity_class: 'search', target: '@bot.command discord-bot/core' },
  { seq: 2, action: 'Read', activity_class: 'read', target: 'discord-bot/core/bot.py' },
  { seq: 3, action: 'Edit', activity_class: 'write', target: 'discord-bot/core/bot.py' },
  { seq: 4, action: 'Bash', activity_class: 'execute', target: 'python3 -m compileall -q core utils' },
  { seq: 5, action: 'Bash', activity_class: 'execute', target: 'gh pr create --base main --title "[WORLD] …"' },
];
const SLUG = 'procedures/add-discord-command';
const OLD = { title: 'Add How it works section under hero', steps_count: 12, source: 'claude-code', learned_at: '2026-09-27T19:02:40Z', uses: 0, gbrain_slug: 'procedures/add-how-it-works-section-under-hero' };
const LIB = (uses, withNew = true) => ({ kind: 'procedure_library', items: [
  ...(withNew ? [{ title: PROC_TITLE, steps_count: STEPS.length, source: 'claude-code', learned_at: '2026-09-27T21:04:11Z', uses, gbrain_slug: SLUG }] : []), OLD] });
const proc = (phase, run, extra = {}) => ({ kind: 'procedure', phase, source: 'claude-code',
  event_id: run === 1 ? 'evt_recap' : 'evt_streak', job_id: run === 1 ? 'b40211' : 'b40587', ...extra });
const rec = (run, n, feature) => proc('recording', run, { title: feature, trigger: `ship customer feature request: ${feature}`, tool_calls_seen: n });
const R1 = 'Add !recap command', R2 = 'Add !streak command';

export const MEMORY_SCRIPT = [
  [0, LIB(0, false)],
  // run 1: the Builder works, Memorable watches the trace
  ...[[7400, 0], [8600, 1], [9200, 2], [9900, 3], [10200, 4], [11000, 5], [11800, 6], [12500, 7], [13400, 8], [14300, 9]]
    .map(([t, n]) => [t, rec(1, n, R1)]),
  [15400, proc('extracting', 1, { title: R1, tool_calls_seen: 9 })],
  [17750, proc('learned', 1, { title: PROC_TITLE, steps: STEPS, trigger: `ship customer feature request: ${R1}`, gbrain_slug: SLUG, admitted: true, tool_calls_seen: 9 })],
  [17800, LIB(0)],
  // run 2: recall fires off the real-world event, before the Builder starts
  [23450, proc('recalled', 2, { title: PROC_TITLE, steps: STEPS, trigger: `ship customer feature request: ${R1}`, gbrain_slug: SLUG })],
  [23480, LIB(1)],
  ...[[23800, 0], [25200, 2], [26100, 3], [27000, 4], [28000, 5]].map(([t, n]) => [t, rec(2, n, R2)]),
];
