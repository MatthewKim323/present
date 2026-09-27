// Dev cockpit: GitHub + Claude Code panels beside the person card, plus live
// `context_delta` lines under the card. Same look as panels.js (dark glass, small
// type, one accent). All data comes from the world service (contracts/EVENTS.md:
// dev_github, dev_session, context_delta, preview_shot); this file never talks to GitHub.
// preview_shot = screenshot of the Builder's branch served locally, popped in front of the wearer.
//
// Hooks (kept to a few lines in the teammate-owned files):
//   hud.js      applyDev(hud, msg) at the top of apply(); withDeltas(hud, card) on person_card
//   desktop.js  DesktopDev (placement + click), drawPersonCardPlus for cards
//   xr.js       XrDev (body-locked meshes + pinch on buttons), drawPersonCardPlus for cards
//   main.js     setDevSender(fn) so button presses go out as dev_action
import * as THREE from 'three';
import { drawPersonCard } from './panels.js';
import { LITE } from './perf.js';

const FONT = 'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const ACCENT = '#7cf0c5';
const WARN = '#ffb86b';
const BAD = '#ff6b7a';
const DIM = 'rgba(232,236,240,0.45)';
const MID = 'rgba(232,236,240,0.66)';
const S = 2; // supersample, same as panels.js

const MAX_DELTAS = 4;
const DELTA_FADE_MS = 700;

// ---------------------------------------------------------------- state

let sender = () => false;
export function setDevSender(fn) { sender = fn; }

// Returns true when the message was a dev-cockpit kind (caller then touches + returns).
export function applyDev(hud, msg) {
  if (!msg || typeof msg !== 'object') return false;
  hud.deltas ||= new Map(); // person_id -> [{ text, kind, t }]
  switch (msg.kind) {
    case 'dev_github':
      if (!Array.isArray(msg.prs)) return false;
      hud.devGithub = { ...msg, _selectedPr: hud.devGithub?._selectedPr };
      if (!msg.prs?.some((p) => p.number === hud.devGithub._selectedPr)) hud.devGithub._selectedPr = msg.prs?.[0]?.number;
      return true;
    case 'agent_activity':
      hud.devWorkerLinks = (Array.isArray(msg.workers) ? msg.workers : []).filter(w => w && typeof w === 'object').flatMap((w) => [
        w.url && { label: `${w.name} preview`, url: w.url },
        w.pr_url && { label: `${w.name} PR`, url: w.pr_url },
        w.session_url && { label: `${w.name} session`, url: w.session_url },
      ].filter(Boolean)).slice(0, 6);
      return !!hud.qmSwarm && msg.hook === hud.qmSwarm.hook;
    case 'qm_swarm':
      if (!Array.isArray(msg.workers)) return false;
      hud.qmSwarm = { ...msg, _rx: performance.now() };
      for (const [key, activity] of hud.activity || [])
        if (activity.hook === msg.hook) hud.activity.delete(key);
      return true;
    case 'dev_session':
      hud.devSession = { ...msg, _rx: performance.now() };
      return true;
    case 'context_delta': {
      const pid = msg.person_id || '_';
      const list = [...(hud.deltas.get(pid) || []), { text: msg.text, kind: msg.delta_kind, t: performance.now() }];
      hud.deltas.set(pid, list.slice(-MAX_DELTAS));
      // re-key matching cards (new object -> both renderers re-raster). If nothing matches and there is
      // exactly one card, attach there: one person in front of you is the demo case.
      let hit = false;
      for (const [k, c] of hud.cards) if (c.person_id === msg.person_id) { hud.cards.set(k, withDeltas(hud, c)); hit = true; }
      if (!hit && hud.cards.size === 1) {
        const [k, c] = [...hud.cards][0];
        hud.deltas.set(c.person_id || '_', hud.deltas.get(pid));
        hud.cards.set(k, withDeltas(hud, c));
      }
      return true;
    }
    case 'preview_shot':
      // a re-send of a panel the wearer already closed stays closed
      if (hud.previewClosed !== `${msg.job_id}:${msg.pr}`) hud.previewShot = acceptShot(hud.previewShot, msg);
      return true;
    case 'clear':
      hud.devGithub = null; hud.devSession = null; hud.qmSwarm = null; hud.devWorkerLinks = []; hud.previewShot = null; hud.previewClosed = null; hud.deltas.clear();
      return false; // let hud.js clear its own state too
    default:
      return false;
  }
}

export function withDeltas(hud, card) {
  const live = hud.deltas?.get(card.person_id || '_') || [];
  return { ...card, _deltas: live };
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

function glass(ctx, x, y, w, h, r = 14, fill = 'rgba(8, 10, 14, 0.66)') {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function fit(ctx, s, max) {
  let str = String(s ?? '');
  if (max) while (str.length > 1 && ctx.measureText(str).width > max) str = str.slice(0, -2) + '…';
  return str;
}

function text(ctx, s, x, y, { size = 12, weight = 400, color = '#e8ecf0', font = FONT, track = 0, max, align = 'left' } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${track}px`;
  const str = fit(ctx, s, max);
  ctx.fillText(str, x, y);
  const w = ctx.measureText(str).width;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
  return w;
}

function dot(ctx, x, y, r, color, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

const host = (u) => { try { const x = new URL(u); return x.host + (x.pathname.length > 1 ? x.pathname : ''); } catch { return String(u || ''); } };
const base = (p) => String(p || '').split('/').pop();
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- person card + deltas

// Person card from panels.js with the live "+ fact" lines appended underneath.
export function drawPersonCardPlus(m, t = performance.now()) {
  const card = drawPersonCard(m);
  const live = m._deltas || [];
  const stored = live.length ? [] : (m.recent_deltas || []).slice(0, 3).map((s) => ({ text: `+ ${s}`, stored: true }));
  const lines = [...stored, ...live];
  if (!lines.length) return card;
  const cw = card.width / S, ch = card.height / S;
  const lh = 17, gap = 5;
  const sh = 10 + lines.length * lh;
  const { c, ctx } = panel(cw, ch + gap + sh);
  ctx.drawImage(card, 0, 0, cw, ch);
  glass(ctx, 0, ch + gap, cw, sh, 11, 'rgba(8, 10, 14, 0.55)');
  let y = ch + gap + 18;
  lines.forEach((d, i) => {
    const age = d.t ? t - d.t : 1e9;
    const fresh = Math.min(1, age / DELTA_FADE_MS);
    const older = lines.length - 1 - i; // 0 = newest
    const alpha = (d.stored ? 0.55 : 1 - older * 0.14) * fresh;
    ctx.globalAlpha = alpha;
    const dx = (1 - fresh) * 8; // slide in from the left a touch
    const str = String(d.text || '').replace(/^\+\s*/, '');
    text(ctx, '+', 14 + dx, y, { size: 12, weight: 600, color: ACCENT });
    text(ctx, str, 28 + dx, y, { size: 11.5, color: older === 0 && !d.stored ? '#e8ecf0' : MID, max: cw - 90 });
    if (d.kind) text(ctx, d.kind.replace(/_/g, ' ').replace('open loop ', ''), cw - 14, y, { size: 8.5, weight: 600, color: DIM, track: 1, align: 'right', max: 60 });
    ctx.globalAlpha = 1;
    y += lh;
  });
  return c;
}

export const deltasAnimating = (m, t = performance.now()) => (m._deltas || []).some((d) => t - d.t < DELTA_FADE_MS);

// ---------------------------------------------------------------- GitHub panel

const GH_W = 340;

// Returns a canvas with `.hits = [{ action, pr, url, x, y, w, h }]` in panel css px.
export function drawGithubPanel(m) {
  const prs = m?.prs || [];
  const top = prs.find((p) => p.number === m._selectedPr) || prs[0];
  const rest = prs.filter((p) => p !== top);
  const hunk = top?.hunk || [];
  let h = 34;
  if (!top) h += 22;
  else h += 20 + 18 + 18 + 18 + (hunk.length ? 22 + hunk.length * 14 + 8 : 0) + 38 + rest.length * 24 + 4;
  const { c, ctx } = panel(GH_W, h);
  c.hits = [];
  glass(ctx, 0, 0, GH_W, h);
  text(ctx, 'GITHUB', 16, 22, { size: 9.5, weight: 600, color: DIM, track: 1.4 });
  text(ctx, m?.repo || '', 70, 22, { size: 11, font: MONO, color: MID, max: 190 });
  text(ctx, `${prs.length} open`, GH_W - 16, 22, { size: 10, color: DIM, align: 'right' });
  if (!top) {
    text(ctx, 'no open [WORLD] PRs', 16, 48, { size: 11.5, color: MID });
    return c;
  }
  let y = 52;
  const ck = { pass: ACCENT, fail: BAD, pending: WARN, none: DIM }[top.checks] || DIM;
  dot(ctx, 20, y - 4, 3.5, ck);
  const nw = text(ctx, `#${top.number}`, 30, y, { size: 12, weight: 600, font: MONO, color: ACCENT });
  text(ctx, top.title.replace(/^\[WORLD\]\s*/, ''), 30 + nw + 8, y, { size: 12.5, weight: 600, max: GH_W - 60 - nw - 50 });
  text(ctx, top.state === 'draft' ? 'DRAFT' : (top.checks === 'none' ? '' : top.checks.toUpperCase()), GH_W - 16, y,
    { size: 8.5, weight: 600, color: ck, track: 1.2, align: 'right' });
  if (safeLink(top.url)) c.hits.push({ action: 'open_link', url: top.url, x: 16, y: y - 14, w: GH_W - 32, h: 18 });
  y += 18;
  text(ctx, top.branch, 30, y, { size: 10.5, font: MONO, color: DIM, max: 190 });
  const dw = text(ctx, `−${top.deletions}`, GH_W - 16, y, { size: 10.5, font: MONO, color: BAD, align: 'right' });
  text(ctx, `+${top.additions}`, GH_W - 22 - dw, y, { size: 10.5, font: MONO, color: ACCENT, align: 'right' });
  y += 18;
  const files = top.files || [];
  const shown = files.slice(0, 3).map(base).join(' · ') + (files.length > 3 ? `  +${files.length - 3}` : '');
  text(ctx, `${files.length} file${files.length === 1 ? '' : 's'}`, 30, y, { size: 9.5, weight: 600, color: DIM, track: 1 });
  text(ctx, shown, 84, y, { size: 10.5, font: MONO, color: MID, max: GH_W - 100 });
  y += 18;
  text(ctx, 'PREVIEW', 30, y, { size: 9.5, weight: 600, color: DIM, track: 1 });
  if (top.preview_url) text(ctx, host(top.preview_url), 84, y, { size: 10.5, font: MONO, color: ACCENT, max: GH_W - 100 });
  else text(ctx, 'building…', 84, y, { size: 10.5, color: WARN });

  if (hunk.length) {
    y += 12;
    const bh = 18 + hunk.length * 14;
    glass(ctx, 12, y, GH_W - 24, bh, 8, 'rgba(0, 0, 0, 0.42)');
    text(ctx, top.hunk_file || '', 22, y + 13, { size: 9, font: MONO, color: DIM, max: GH_W - 50 });
    let ly = y + 18;
    for (const l of hunk) {
      if (l.t !== ' ') {
        ctx.fillStyle = l.t === '+' ? 'rgba(124,240,197,0.10)' : 'rgba(255,107,122,0.10)';
        ctx.fillRect(13, ly + 1, GH_W - 26, 14);
      }
      const col = l.t === '+' ? ACCENT : l.t === '-' ? BAD : 'rgba(232,236,240,0.5)';
      text(ctx, l.t === ' ' ? '' : l.t, 20, ly + 11.5, { size: 10.5, font: MONO, color: col });
      text(ctx, l.s.replace(/\t/g, '  '), 32, ly + 11.5, { size: 10.5, font: MONO, color: l.t === ' ' ? 'rgba(232,236,240,0.55)' : col, max: GH_W - 50 });
      ly += 14;
    }
    y += bh;
  }

  // buttons act on the explicitly selected PR
  y += 10;
  const btns = [
    { action: 'approve', label: 'APPROVE', on: true, color: ACCENT },
    { action: 'open_preview', label: 'OPEN PREVIEW', on: !!top.preview_url, color: '#e8ecf0' },
    { action: 'comment', label: 'COMMENT', on: true, color: '#e8ecf0' },
  ];
  let bx = 12;
  const bw = (GH_W - 24 - 12) / 3;
  for (const b of btns) {
    ctx.save();
    ctx.globalAlpha = b.on ? 1 : 0.35;
    ctx.beginPath();
    ctx.roundRect(bx + 0.5, y + 0.5, bw - 1, 24, 12);
    ctx.fillStyle = b.action === 'approve' ? 'rgba(124,240,197,0.12)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = b.action === 'approve' ? 'rgba(124,240,197,0.55)' : 'rgba(255,255,255,0.18)';
    ctx.stroke();
    text(ctx, b.label, bx + bw / 2, y + 16, { size: 9.5, weight: 600, color: b.color, track: 1.2, align: 'center' });
    ctx.restore();
    if (b.on) c.hits.push({ action: b.action, pr: top.number, url: top.preview_url, x: bx, y, w: bw, h: 24 });
    bx += bw + 6;
  }
  y += 24 + 8;

  for (const p of rest) {
    y += 22;
    c.hits.push({ action: 'select_pr', pr: p.number, x: 12, y: y - 16, w: GH_W - 24, h: 24 });
    const col = { pass: ACCENT, fail: BAD, pending: WARN, none: DIM }[p.checks] || DIM;
    dot(ctx, 20, y - 4, 2.5, col);
    const w2 = text(ctx, `#${p.number}`, 30, y, { size: 10.5, font: MONO, color: MID });
    text(ctx, p.title.replace(/^\[WORLD\]\s*/, ''), 36 + w2, y, { size: 11, color: MID, max: GH_W - 130 - w2 });
    text(ctx, `+${p.additions} −${p.deletions}`, GH_W - 16, y, { size: 10, font: MONO, color: DIM, align: 'right' });
    y += 2;
  }
  return c;
}

// ---------------------------------------------------------------- Claude Code panel

const CC_W = 320;
const TOOL_COLOR = { Edit: ACCENT, Write: ACCENT, Bash: WARN, Read: MID, Grep: MID, Glob: MID };

export function sessionElapsed(m, t = performance.now()) {
  const live = ['queued', 'running', 'pr_open'].includes(m.state);
  return (m.elapsed_s || 0) + (live && m._rx ? (t - m._rx) / 1000 : 0);
}

export function drawSessionPanel(m, t = performance.now()) {
  const tail = (m.tail || []).slice(-8);
  const proc = m.procedure;
  let h = 34 + 20 + 18 + (proc ? 18 : 0) + (tail.length ? 12 + tail.length * 14 : 0) + 24;
  const { c, ctx } = panel(CC_W, h);
  c.hits = [];
  glass(ctx, 0, 0, CC_W, h);
  const st = m.state || 'running';
  const live = ['queued', 'running', 'pr_open'].includes(st);
  const col = st === 'done' ? ACCENT : st === 'failed' ? BAD : WARN;
  text(ctx, 'CLAUDE CODE', 16, 22, { size: 9.5, weight: 600, color: DIM, track: 1.4 });
  text(ctx, m.job_id || '', 104, 22, { size: 10.5, font: MONO, color: DIM, max: 90 });
  const ew = text(ctx, mmss(sessionElapsed(m, t)), CC_W - 16, 22, { size: 11, font: MONO, color: MID, align: 'right' });
  const sw = text(ctx, st.replace('_', ' ').toUpperCase(), CC_W - 24 - ew, 22, { size: 8.5, weight: 600, color: col, track: 1.2, align: 'right' });
  dot(ctx, CC_W - 32 - ew - sw, 18.5, 3, col, live ? 0.45 + 0.55 * Math.abs(Math.sin(t / 380)) : 1);
  let y = 48;
  text(ctx, m.feature || '', 16, y, { size: 13, weight: 600, max: CC_W - 32 });
  y += 18;
  text(ctx, live ? '›' : '·', 16, y, { size: 12, weight: 600, color: col });
  text(ctx, m.step || st, 28, y, { size: 11, font: MONO, color: '#e8ecf0', max: CC_W - 44 });
  if (proc) {
    y += 18;
    const rw = text(ctx, 'RECALLED', 16, y, { size: 9, weight: 600, color: ACCENT, track: 1.2 });
    text(ctx, `${proc.title} · ${proc.steps} steps`, 24 + rw, y, { size: 11, color: MID, max: CC_W - 40 - rw });
  }
  if (tail.length) {
    y += 8;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(16, y); ctx.lineTo(CC_W - 16, y); ctx.stroke();
    y += 2;
    tail.forEach((e, i) => {
      y += 14;
      ctx.globalAlpha = 0.4 + 0.6 * ((i + 1) / tail.length);
      text(ctx, e.tool, 16, y, { size: 10.5, font: MONO, color: TOOL_COLOR[e.tool] || MID, max: 52 });
      text(ctx, e.target, 66, y, { size: 10.5, font: MONO, color: MID, max: CC_W - 82 });
      ctx.globalAlpha = 1;
    });
  }
  y += 20;
  const foot = m.session_url ? host(m.session_url) : `${m.mode || 'local'} · claude -p${m.pr ? ` · PR #${m.pr}` : ''}`;
  text(ctx, m.session_url ? 'SESSION' : 'RUNNER', 16, y, { size: 9, weight: 600, color: DIM, track: 1.2 });
  if (safeLink(m.session_url)) c.hits.push({ action: 'open_link', url: m.session_url, x: 12, y: y - 14, w: CC_W - 24, h: 22 });
  text(ctx, foot, 72, y, { size: 10.5, font: MONO, color: m.session_url ? ACCENT : DIM, max: CC_W - 88 });
  return c;
}

export function drawWorkerLinks(links) {
  const rows = links.filter((l) => safeLink(l.url)).slice(0, 6);
  const { c, ctx } = panel(CC_W, 34 + rows.length * 28);
  c.hits = [];
  glass(ctx, 0, 0, CC_W, c.height / S);
  text(ctx, 'WORKER OUTPUTS', 16, 22, { size: 9.5, color: DIM, track: 1.4 });
  rows.forEach((link, i) => {
    const y = 34 + i * 28;
    text(ctx, link.label, 16, y + 17, { size: 11, color: MID, max: CC_W - 48 });
    text(ctx, '↗', CC_W - 24, y + 17, { size: 12 });
    c.hits.push({ action: 'open_link', url: link.url, x: 12, y, w: CC_W - 24, h: 28 });
  });
  return c;
}

// ---------------------------------------------------------------- QM SWARM panel
//
// One panel for the WorldHook swarm (`qm_swarm`): a lane per worker (Context / Product / Builder / ...), the
// Builder lane expands into its last few Claude Code tool calls, footer shows recalled / learned procedures.

const SW_W = 320;
const LANE_H = 22;
const TAIL_H = 14;
const TAIL_MAX = 6;
const STATE_COLOR = { done: ACCENT, failed: BAD, running: WARN };

export function laneElapsed(m, w, t = performance.now()) {
  if (w.elapsed_s == null) return null;
  return w.elapsed_s + ((w.state || 'running') === 'running' && m._rx ? (t - m._rx) / 1000 : 0);
}

export function drawSwarmPanel(m, t = performance.now()) {
  const workers = m.workers || [];
  const tails = workers.map((w) => (w.tail || []).slice(-TAIL_MAX));
  const foot = [m.recalled && ['RECALLED', m.recalled], m.learned && ['LEARNED', m.learned]].filter(Boolean);
  let h = 34 + 6 + workers.length * LANE_H + tails.reduce((a, tl) => a + (tl.length ? tl.length * TAIL_H + 6 : 0), 0) + 4;
  if (!workers.length) h += LANE_H;
  if (foot.length) h += 10 + foot.length * 18;
  const { c, ctx } = panel(SW_W, h);
  glass(ctx, 0, 0, SW_W, h);
  const pulse = 0.45 + 0.55 * Math.abs(Math.sin(t / 380));

  // header: QM SWARM · <hook>, done count on the right
  const lw = text(ctx, 'QM SWARM', 16, 22, { size: 9.5, weight: 600, color: DIM, track: 1.4 });
  const done = workers.filter((w) => w.state === 'done').length;
  const cw = workers.length ? text(ctx, `${done}/${workers.length}`, SW_W - 16, 22, { size: 10.5, font: MONO, color: done === workers.length ? ACCENT : MID, align: 'right' }) : 0;
  text(ctx, `· ${m.hook || ''}`, 16 + lw + 6, 22, { size: 11, font: MONO, color: MID, max: SW_W - 44 - lw - cw });

  let y = 34 + 6;
  if (!workers.length) text(ctx, 'waiting for workers…', 16, y + 14, { size: 11, color: DIM });
  workers.forEach((w, i) => {
    const st = w.state || 'running';
    const col = STATE_COLOR[st] || WARN;
    const ly = y + 15;
    dot(ctx, 20, ly - 4, 3, col, st === 'running' ? pulse : 1);
    text(ctx, w.name || 'Worker', 32, ly, { size: 12, weight: 600, max: 72 });
    const el = laneElapsed(m, w, t);
    const ew = el != null ? text(ctx, mmss(el), SW_W - 16, ly, { size: 10.5, font: MONO, color: DIM, align: 'right' }) + 8 : 0;
    const note = w.note || (st === 'running' ? 'working' : st);
    text(ctx, note, 108, ly, { size: 11.5, color: st === 'failed' ? BAD : MID, max: SW_W - 124 - ew });
    y += LANE_H;
    const tl = tails[i];
    if (tl.length) {
      // tool tail: a thin rail on the left, newest brightest
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(20, y - 2, 1, tl.length * TAIL_H + 2);
      tl.forEach((e, k) => {
        const ty = y + 10 + k * TAIL_H;
        ctx.globalAlpha = 0.4 + 0.6 * ((k + 1) / tl.length);
        text(ctx, e.tool, 32, ty, { size: 10, font: MONO, color: TOOL_COLOR[e.tool] || MID, max: 44 });
        text(ctx, e.target, 80, ty, { size: 10, font: MONO, color: MID, max: SW_W - 96 });
        ctx.globalAlpha = 1;
      });
      y += tl.length * TAIL_H + 6;
    }
  });

  if (foot.length) {
    y += 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(16, y); ctx.lineTo(SW_W - 16, y); ctx.stroke();
    y += 4;
    for (const [label, p] of foot) {
      y += 16;
      const rw = text(ctx, label.toLowerCase() + ':', 16, y, { size: 10.5, weight: 600, color: ACCENT });
      const steps = p.steps != null ? ` (${p.steps} step${p.steps === 1 ? '' : 's'})` : '';
      text(ctx, `${p.title || 'procedure'}${steps}`, 22 + rw, y, { size: 11, color: MID, max: SW_W - 38 - rw });
      y += 2;
    }
  }
  return c;
}

// ---------------------------------------------------------------- actions

export function safeLink(url) {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}

export function act(hud, hit) {
  if (!hit) return false;
  if (hit.action === 'select_pr') {
    if (hud.devGithub?.prs?.some((p) => p.number === hit.pr)) {
      hud.devGithub = { ...hud.devGithub, _selectedPr: hit.pr };
      hud.version++;
    }
    return true;
  }
  if (hit.action === 'open_link') {
    const url = safeLink(hit.url);
    if (!url) return true;
    if (hud.xrActive) {
      hud.pendingPreview = url;
      hud.apply({ kind: 'memory_event', text: 'LINK QUEUED', detail: 'opens when you exit AR' });
    } else openPreview(url);
    return true;
  }
  const msg = { kind: 'dev_action', action: hit.action, pr: hit.pr };
  if (hit.action === 'comment' && hit.text) msg.text = hit.text;
  if (!sender(msg)) {
    hud.apply({ kind: 'memory_event', text: 'ACTION NOT SENT', detail: 'Connect the live service to act on this PR.' });
    return true;
  }
  if (hit.action === 'open_preview' && hit.url) {
    if (hud.xrActive) {
      hud.pendingPreview = hit.url;
      hud.apply({ kind: 'memory_event', text: 'PREVIEW QUEUED', detail: 'opens when you exit AR' });
    } else openPreview(hit.url);
  } else if (hit.action !== 'open_preview') {
    hud.apply({ kind: 'memory_event', text: hit.action === 'approve' ? 'APPROVING' : 'COMMENTING', detail: `#${hit.pr}` });
  }
  return true;
}

// Desktop / post-XR: preview in an overlay iframe, plus a plain link (Vercel previews may refuse framing).
export function openPreview(url) {
  url = safeLink(url);
  if (!url) return;
  document.getElementById('dev-preview')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'dev-preview';
  wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;width:min(560px,calc(100vw - 32px));height:min(420px,70vh);' +
    'background:rgba(8,10,14,0.9);border:1px solid rgba(255,255,255,0.14);border-radius:14px;overflow:hidden;z-index:20;display:flex;flex-direction:column';
  const bar = document.createElement('div');
  bar.style.cssText = `display:flex;gap:10px;align-items:center;padding:8px 12px;font:11px ${MONO};color:${MID}`;
  const a = document.createElement('a');
  a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = host(url);
  a.style.cssText = `color:${ACCENT};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
  const x = document.createElement('button');
  x.textContent = 'close'; x.onclick = () => wrap.remove();
  bar.append(a, x);
  const f = document.createElement('iframe');
  f.src = url; f.style.cssText = 'flex:1;border:0;background:#fff';
  wrap.append(bar, f);
  document.body.appendChild(wrap);
}

// ---------------------------------------------------------------- preview shot
//
// `preview_shot`: the world service served the Builder's branch locally and screenshotted it. Live pages
// can't render inside immersive-ar, so the screenshot is the preview: a glass panel that pops in ~0.9 m in
// front of the wearer, shows a 16:10 window onto the (tall) shot, auto-scrolls once toward the new section,
// then scrolls a step per pinch. Pinch-hold or X dismisses; OPEN reuses open_preview.

const PV_W = 600;                  // panel css px
const PV_PAD = 12;
const PV_HEAD = 46;
const PV_WIN_W = PV_W - PV_PAD * 2;
const PV_WIN_H = Math.round(PV_WIN_W * 10 / 16);
const PV_FOOT = 44;
const PV_H = PV_HEAD + PV_WIN_H + PV_FOOT;
const PV_S = 2.4;                  // supersample: 1440 px texture, about 1:1 with a 1280 wide shot
const PV_IN_MS = 460;              // pop-in
const PV_OUT_MS = 220;             // dismiss fade
const PV_AUTO_DELAY = 900;         // then scroll 0 -> 40% once
const PV_AUTO_MS = 2600;
const PV_STEP_MS = 560;
const PV_HOLD_MS = 550;            // pinch/press held this long = dismiss

const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// New job/PR -> fresh panel (pops in again). Same job/PR re-sent -> keep scroll + position, swap the image.
function acceptShot(prev, msg) {
  const same = prev && !prev._out && prev.job_id === msg.job_id && prev.pr === msg.pr;
  const b64 = msg.jpeg_b64;
  if (same && prev._b64 === b64) return prev;
  const shot = same ? { ...prev, ...msg } : { ...msg, _rx: performance.now(), _key: `${msg.job_id}:${msg.pr}:${performance.now()}`, scroll: 0, _user: null };
  shot._b64 = b64;
  shot._v = (prev?._v || 0) + 1;
  const img = new Image();
  img.onload = () => { shot._v++; };
  if (b64) img.src = `data:image/jpeg;base64,${b64}`;
  shot.img = img;
  return shot;
}

function shotDims(shot) {
  const img = shot.img;
  const iw = img?.naturalWidth || shot.w || 1280, ih = img?.naturalHeight || shot.h || 800;
  const vh = iw * (PV_WIN_H / PV_WIN_W); // source rows visible in the window
  return { iw, ih, vh, max: Math.max(0, ih - vh) };
}

// Advance scroll for time t. Returns true while anything is moving (caller re-rasters).
function stepShot(shot, t) {
  const { ih, max } = shotDims(shot);
  const age = t - shot._rx;
  let moving = age < PV_IN_MS || (shot._out != null);
  if (shot._user) {
    const p = clamp01((t - shot._user.t0) / PV_STEP_MS);
    shot.scroll = shot._user.from + (shot._user.to - shot._user.from) * easeInOut(p);
    moving ||= p < 1;
  } else {
    const p = clamp01((age - PV_AUTO_DELAY) / PV_AUTO_MS);
    shot.scroll = Math.min(max, 0.4 * ih) * easeInOut(p);
    moving ||= p < 1;
  }
  return moving;
}

function scrollShot(shot, t = performance.now()) {
  stepShot(shot, t);
  const { vh, max } = shotDims(shot);
  const from = shot.scroll;
  const to = from >= max - 1 ? 0 : Math.min(max, from + vh * 0.7); // at the bottom: back to top
  shot._user = { from, to, t0: t };
}

function dismissShot(hud) {
  const s = hud.previewShot;
  if (s && s._out == null) { s._out = performance.now(); hud.previewClosed = `${s.job_id}:${s.pr}`; }
}

// Pop-in / fade-out envelope: { k: 0..1 appear progress, alpha }. Returns null once fully dismissed.
function shotEnvelope(shot, t) {
  const kin = easeOut(clamp01((t - shot._rx) / PV_IN_MS));
  if (shot._out == null) return { k: kin, alpha: kin };
  const p = clamp01((t - shot._out) / PV_OUT_MS);
  if (p >= 1) return null;
  return { k: kin * (1 - 0.3 * p), alpha: kin * (1 - p) };
}

// Draws into shot._canvas (reused, so the XR texture keeps the same image). `.hits` in panel css px.
export function drawPreviewPanel(shot, t = performance.now()) {
  let c = shot._canvas;
  if (!c) {
    c = shot._canvas = document.createElement('canvas');
    c.width = Math.ceil(PV_W * PV_S); c.height = Math.ceil(PV_H * PV_S);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(PV_S, 0, 0, PV_S, 0, 0);
  ctx.clearRect(0, 0, PV_W, PV_H);
  c.hits = [];
  glass(ctx, 0, 0, PV_W, PV_H, 16, 'rgba(8, 10, 14, 0.9)');

  // header: PREVIEW · PR #n, title, close
  dot(ctx, 20, 23, 3.5, ACCENT, 0.55 + 0.45 * Math.abs(Math.sin((t - shot._rx) / 420)));
  const lw = text(ctx, `PREVIEW · PR #${shot.pr ?? '?'}`, 30, 27, { size: 10, weight: 600, color: ACCENT, track: 1.4 });
  text(ctx, String(shot.title || '').replace(/^\[WORLD\]\s*/, ''), 30 + lw + 12, 27.5, { size: 13.5, weight: 600, max: PV_W - lw - 100 });
  const xr = { x: PV_W - 16 - 26, y: 10, w: 26, h: 26 };
  ctx.beginPath(); ctx.arc(xr.x + 13, xr.y + 13, 12.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.stroke();
  ctx.strokeStyle = MID; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(xr.x + 9, xr.y + 9); ctx.lineTo(xr.x + 17, xr.y + 17); ctx.moveTo(xr.x + 17, xr.y + 9); ctx.lineTo(xr.x + 9, xr.y + 17); ctx.stroke();
  ctx.lineWidth = 1;
  c.hits.push({ action: 'close', ...xr });

  // viewport window onto the screenshot
  const wx = PV_PAD, wy = PV_HEAD, ww = PV_WIN_W, wh = PV_WIN_H;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(wx, wy, ww, wh, 9); ctx.clip();
  ctx.fillStyle = '#0d0f13'; ctx.fillRect(wx, wy, ww, wh);
  const img = shot.img;
  const ready = img && img.complete && img.naturalWidth > 0;
  if (ready) {
    const { iw, ih, vh } = shotDims(shot);
    const sy = Math.max(0, Math.min(ih - Math.min(vh, ih), shot.scroll || 0));
    const sh = Math.min(vh, ih);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, sy, iw, sh, wx, wy, ww, wh * (sh / vh));
    // scrollbar
    if (ih > vh) {
      const th = Math.max(24, wh * (vh / ih)), ty = wy + (wh - th) * (sy / (ih - vh));
      ctx.fillStyle = 'rgba(8,10,14,0.35)'; ctx.fillRect(wx + ww - 7, wy + 4, 3, wh - 8);
      ctx.fillStyle = 'rgba(124,240,197,0.85)';
      ctx.beginPath(); ctx.roundRect(wx + ww - 7.5, ty + 4, 4, th - 8, 2); ctx.fill();
    }
  } else {
    text(ctx, shot.jpeg_b64 ? 'decoding…' : 'no screenshot', wx + ww / 2, wy + wh / 2, { size: 12, color: DIM, align: 'center' });
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath(); ctx.roundRect(wx + 0.5, wy + 0.5, ww - 1, wh - 1, 9); ctx.stroke();
  c.hits.push({ action: 'scroll', x: wx, y: wy, w: ww, h: wh });

  // footer: url, hint, OPEN
  const fy = wy + wh + 27;
  const uw = text(ctx, 'LOCAL', 16, fy, { size: 9, weight: 600, color: DIM, track: 1.2 });
  const bw = 78, bh = 26, bx = PV_W - 16 - bw, by = fy - 17;
  text(ctx, 'pinch to scroll · hold to close', bx - 12, fy, { size: 9.5, color: DIM, align: 'right' });
  text(ctx, host(shot.url), 16 + uw + 8, fy, { size: 11, font: MONO, color: ACCENT, max: bx - 190 - uw });
  ctx.beginPath(); ctx.roundRect(bx + 0.5, by + 0.5, bw - 1, bh, 13);
  ctx.fillStyle = 'rgba(124,240,197,0.12)'; ctx.fill();
  ctx.strokeStyle = 'rgba(124,240,197,0.55)'; ctx.stroke();
  text(ctx, 'OPEN', bx + bw / 2, by + 17, { size: 9.5, weight: 600, color: ACCENT, track: 1.4, align: 'center' });
  if (shot.url) c.hits.push({ action: 'open_preview', pr: shot.pr, url: shot.url, x: bx, y: by, w: bw, h: bh });
  return c;
}

// Shared hit handling. held = ms the pinch/press lasted.
function previewHit(hud, shot, px, py, held) {
  const h = (shot._canvas?.hits || []).find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
  if (held >= PV_HOLD_MS || h?.action === 'close') { dismissShot(hud); return true; }
  if (h?.action === 'open_preview') return act(hud, h);
  scrollShot(shot); // anywhere else on the panel scrolls
  return true;
}

// ---------------------------------------------------------------- desktop

export class DesktopDev {
  constructor(hud) {
    this.hud = hud;
    this.hits = [];
    this.cache = { gh: null, ghCanvas: null, s: null, sCanvas: null, sT: 0 };
    this.pv = null;   // preview panel screen rect + scale
    this.downT = 0;   // press start, for hold-to-close
    window.addEventListener('pointerdown', () => { this.downT = performance.now(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismissShot(hud); });
    if (import.meta.env?.DEV) window.__devCockpit = this; // headless checks read button hit rects
  }

  // placed: Map(track id -> {x,y,w,h}) of drawn person cards; vr: video rect.
  draw(ctx, placed, vr) {
    const hud = this.hud;
    this.hits = [];
    this.ssRect = null;
    const gh = hud.devGithub, ss = hud.qmSwarm || hud.devSession;
    const t = performance.now();
    this._cockpit(ctx, placed, vr, gh, ss, t);
    this._preview(ctx, t);
  }

  // Preview shot: centered overlay, same panel + behavior as XR.
  _preview(ctx, t) {
    const shot = this.hud.previewShot;
    this.pv = null;
    if (!shot) return;
    const env = shotEnvelope(shot, t);
    if (!env) { this.hud.previewShot = null; return; }
    stepShot(shot, t);
    const c = drawPreviewPanel(shot, t);
    const sc = Math.min(1.25, (innerWidth - 32) / PV_W, (innerHeight - 32) / PV_H);
    const w = PV_W * sc, h = PV_H * sc;
    const x = (innerWidth - w) / 2, y = (innerHeight - h) / 2 + 12 * (1 - env.k);
    const k = 0.92 + 0.08 * env.k;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.4 * env.alpha})`; // soft scrim so the cockpit underneath recedes
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.globalAlpha = env.alpha;
    ctx.translate(x + w / 2, y + h / 2); ctx.scale(k, k);
    ctx.drawImage(c, -w / 2, -h / 2, w, h);
    ctx.restore();
    this.pv = { x: x + w * (1 - k) / 2, y: y + h * (1 - k) / 2, w: w * k, h: h * k, sc: sc * k };
  }

  _cockpit(ctx, placed, vr, gh, ss, t) {
    const hud = this.hud;
    if (!gh && !ss && !hud.devWorkerLinks?.length) return;
    if (gh && this.cache.gh !== gh) { this.cache.gh = gh; this.cache.ghCanvas = drawGithubPanel(gh); }
    if (ss && (this.cache.s !== ss || t - this.cache.sT > 120)) { this.cache.s = ss; this.cache.sT = t; this.cache.sCanvas = ss === hud.qmSwarm ? drawSwarmPanel(ss, t) : drawSessionPanel(ss, t); }
    const card = [...placed.values()][0];
    const b = card && [...placed.keys()].map((id) => hud.bboxFor(id)).find(Boolean);
    const put = (c, x, y) => { const w = c.width / S, h = c.height / S; x = Math.max(8, Math.min(innerWidth - w - 8, x)); y = Math.max(8, Math.min(innerHeight - h - 8, y)); ctx.drawImage(c, x, y, w, h); return { x, y, w, h }; };
    const leftX = (w) => (b ? vr.x + b[0] * vr.w - w - 16 : card ? card.x - w - 16 : 24);
    let ghRect = null;
    if (gh) {
      const c = this.cache.ghCanvas;
      // left of the person (their bbox), else left of the card, else top-left
      ghRect = put(c, leftX(c.width / S), card ? card.y : 80);
      for (const h of c.hits) this.hits.push({ ...h, x: ghRect.x + h.x, y: ghRect.y + h.y });
    }
    if (ss) {
      const c = this.cache.sCanvas, w = c.width / S;
      let x = card ? card.x + card.w + 12 : innerWidth - w - 24, y = card ? card.y : 80;
      if (x + w > innerWidth - 8) { // no room right of the card: stack on the left side instead
        x = ghRect ? ghRect.x : leftX(w);
        y = ghRect ? ghRect.y + ghRect.h + 10 : y;
      }
      const rect = put(c, x, y);
      if (ss === hud.qmSwarm) this.ssRect = rect;
      for (const h of c.hits || []) this.hits.push({ ...h, x: rect.x + h.x, y: rect.y + h.y });
    }
    if (hud.devWorkerLinks?.length) {
      const c = drawWorkerLinks(hud.devWorkerLinks);
      const rect = put(c, 24, innerHeight - c.height / S - 24);
      for (const h of c.hits) this.hits.push({ ...h, x: rect.x + h.x, y: rect.y + h.y });
    }
  }

  click(x, y) {
    const pv = this.pv, shot = this.hud.previewShot;
    if (pv && shot && x >= pv.x && x <= pv.x + pv.w && y >= pv.y && y <= pv.y + pv.h) {
      return previewHit(this.hud, shot, (x - pv.x) / pv.sc, (y - pv.y) / pv.sc, performance.now() - this.downT);
    }
    const hit = this.hits.find((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    if (!hit) return false;
    if (hit.action === 'comment') {
      const t = window.prompt('Comment on PR #' + hit.pr + ' (empty = canned)', '');
      if (t === null) return true;
      return act(this.hud, { ...hit, text: t.trim() });
    }
    return act(this.hud, hit);
  }
}

// ---------------------------------------------------------------- XR

const M_PER_PX = 0.00105; // slightly smaller than the person card
const FOLLOW_DEG = 40;
const PV_M_PER_PX = 0.00077; // preview panel ~0.46 m wide
const PV_DIST = 0.9;
const PV_DROP = 0.08;        // below eye level    // body-locked: re-center only when the head turns this far away

export class XrDev {
  constructor(scene, session, hud) {
    this.scene = scene;
    this.hud = hud;
    this.meshes = {}; // gh, ss -> { mesh, key, canvas }
    this.anchorYaw = null;
    this.anchorPos = null;
    this.pv = null;   // preview shot mesh (world-locked once spawned)
    this.downT = 0;
    this.presses = new Map();
    hud.xrActive = true;
    if (import.meta.env?.DEV) window.__xrDev = this; // headless checks drive pinches on the preview
    session.addEventListener('selectstart', (ev) => {
      this.downT = performance.now();
      this.presses.set(ev.inputSource, this.downT);
    });
    session.addEventListener('end', () => {
      hud.xrActive = false;
      if (hud.pendingPreview) { openPreview(hud.pendingPreview); hud.pendingPreview = null; }
    });
  }

  _mesh(name, key, draw) {
    let m = this.meshes[name];
    if (m && m.key === key) return m;
    const canvas = draw();
    const w = (canvas.width / S) * M_PER_PX, h = (canvas.height / S) * M_PER_PX;
    if (m && Math.abs(m.w - w) < 1e-6 && Math.abs(m.h - h) < 1e-6) {
      m.mesh.material.map.image = canvas;
      m.mesh.material.map.needsUpdate = true;
      Object.assign(m, { key, canvas });
      return m;
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.renderOrder = 10;
    mesh.userData.dev = name;
    if (m) { mesh.position.copy(m.mesh.position); this._drop(name); }
    this.scene.add(mesh);
    return (this.meshes[name] = { mesh, key, canvas, w, h, placed: !!m });
  }

  _drop(name) {
    const m = this.meshes[name];
    if (!m) return;
    this.scene.remove(m.mesh);
    m.mesh.geometry.dispose(); m.mesh.material.map.dispose(); m.mesh.material.dispose();
    delete this.meshes[name];
  }

  // head: Vector3, headQ: Quaternion, cardMeshes: xr.js meshes Map (to sit beside the person card).
  frame(head, headQ, cardMeshes, dist = 1.6, hideCockpit = false) {
    if (hideCockpit) {
      for (const name of Object.keys(this.meshes)) this._drop(name);
      this._preview(head, headQ, performance.now());
      return;
    }
    const hud = this.hud;
    const t = performance.now();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(headQ);
    const yaw = Math.atan2(fwd.x, -fwd.z);
    const right = (a) => new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const ahead = (a) => new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
    const card = [...cardMeshes.entries()].find(([k]) => k.startsWith('card:'))?.[1];
    let center, cardHalf = 0, cy;
    if (card && card.target) {
      center = card.mesh.position.clone();
      cardHalf = card.mesh.geometry.parameters.width / 2;
      cy = center.y + card.mesh.geometry.parameters.height / 2; // top edge
      this.anchorYaw = Math.atan2(center.x - head.x, -(center.z - head.z));
    } else {
      // body-locked: hold position, re-center when the head has turned away
      const off = this.anchorYaw == null ? Infinity : Math.abs(Math.atan2(Math.sin(yaw - this.anchorYaw), Math.cos(yaw - this.anchorYaw)));
      if (off > THREE.MathUtils.degToRad(FOLLOW_DEG) || !this.anchorPos) {
        this.anchorYaw = yaw;
        this.anchorPos = head.clone().addScaledVector(ahead(yaw), dist).add(new THREE.Vector3(0, -0.02, 0));
      }
      center = this.anchorPos;
      cy = center.y + 0.14;
    }
    const r = right(this.anchorYaw);
    const place = (name, x, drop = 0) => {
      const m = this.meshes[name];
      const target = center.clone().addScaledVector(r, x);
      target.y = cy - m.h / 2 - drop;
      if (!m.placed) { m.mesh.position.copy(target); m.placed = true; } else m.mesh.position.lerp(target, 0.12);
      m.mesh.lookAt(head);
    };
    if (hud.devGithub) {
      const m = this._mesh('gh', hud.devGithub, () => drawGithubPanel(hud.devGithub));
      // left of the person: card sits right of their head, so skip past the card and a body width
      place('gh', card ? -(cardHalf + 0.55 + m.w / 2) : -(0.04 + m.w / 2));
    } else this._drop('gh');
    if (hud.qmSwarm || hud.devSession) {
      const s = hud.qmSwarm || hud.devSession;
      const sec = Math.floor(t / 250);
      const active = s === hud.qmSwarm && (s.workers || []).some(w => w.state === 'running');
      const key = active ? `${s._rx}:${Math.floor(t / (LITE ? 500 : 250))}` : `${s._rx}:${sec}`;
      const m = this._mesh('ss', key, () => s === hud.qmSwarm ? drawSwarmPanel(s, t) : drawSessionPanel(s, t));
      place('ss', card ? cardHalf + 0.06 + m.w / 2 : 0.04 + m.w / 2);
    } else this._drop('ss');
    if (hud.devWorkerLinks?.length) {
      const m = this._mesh('links', hud.devWorkerLinks, () => drawWorkerLinks(hud.devWorkerLinks));
      place('links', 0, 0.48);
    } else this._drop('links');
    this._preview(head, headQ, t);
  }

  _dropPreview() {
    const p = this.pv;
    if (!p) return;
    this.scene.remove(p.mesh);
    p.mesh.geometry.dispose(); p.mesh.material.map.dispose(); p.mesh.material.dispose();
    this.pv = null;
  }

  // Preview shot: pops in ~0.9 m ahead at eye level (a touch low), facing the wearer, then world-locked.
  _preview(head, headQ, t) {
    const hud = this.hud, shot = hud.previewShot;
    const env = shot && shotEnvelope(shot, t);
    if (!env) { if (shot) hud.previewShot = null; this._dropPreview(); return; }
    let p = this.pv;
    const moving = stepShot(shot, t);
    if (!p || p.key !== shot._key) {
      this._dropPreview();
      const canvas = drawPreviewPanel(shot, t);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PV_W * PV_M_PER_PX, PV_H * PV_M_PER_PX), mat);
      mesh.renderOrder = 20; // over the cockpit + cards: it is closest
      mesh.userData.dev = 'preview';
      mesh.userData.logicalWidth = PV_W;
      mesh.userData.logicalHeight = PV_H;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(headQ);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      const base = head.clone().addScaledVector(fwd, PV_DIST);
      base.y = head.y - PV_DROP;
      mesh.position.copy(base);
      mesh.lookAt(head);
      this.scene.add(mesh);
      p = this.pv = { mesh, key: shot._key, base, v: shot._v, drawn: t, moving: true };
    } else if (moving || p.moving || p.v !== shot._v || t - p.drawn > 250) {
      drawPreviewPanel(shot, t); // same canvas object, just re-upload
      p.mesh.material.map.needsUpdate = true;
      p.v = shot._v; p.drawn = t;
    }
    p.moving = moving;
    p.mesh.scale.setScalar(0.88 + 0.12 * env.k);
    p.mesh.material.opacity = env.alpha;
    p.mesh.position.copy(p.base).y -= 0.025 * (1 - env.k); // rises into place
  }

  // Pinch: raycaster already set from the input ray. Returns true if a dev button took it.
  select(raycaster, inputSource) {
    const started = this.presses.get(inputSource);
    const held = started == null ? 0 : performance.now() - started;
    this.presses.delete(inputSource);
    const pv = this.pv, shot = this.hud.previewShot;
    if (pv && shot) {
      const hit = raycaster.intersectObject(pv.mesh, false)[0];
      if (hit && hit.uv) return previewHit(this.hud, shot, hit.uv.x * PV_W, (1 - hit.uv.y) * PV_H, held);
    }
    const hits = raycaster.intersectObjects(Object.values(this.meshes).map((m) => m.mesh), false);
    const hit = hits[0];
    if (!hit?.uv) return false;
    const panel = this.meshes[hit.object.userData.dev];
    const px = hit.uv.x * (panel.canvas.width / S), py = (1 - hit.uv.y) * (panel.canvas.height / S);
    const b = (panel.canvas.hits || []).find((h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h);
    return b ? act(this.hud, b) : true;
  }
}

// ---------------------------------------------------------------- mock (?mock=1)

const HUNK = [
  { t: ' ', s: '  return (' },
  { t: ' ', s: '    <Steps>' },
  { t: '-', s: '      <Step title="Paste API key" />' },
  { t: '+', s: '      <Step title="Connect GitHub" onClick={oauth} />' },
  { t: '+', s: '      <Step title="Pick a repo" hint="we detect the stack" />' },
  { t: ' ', s: '    </Steps>' },
];
const TAIL = [
  ['Read', 'CLAUDE.md'], ['Glob', 'app/src/**/*.tsx'], ['Read', 'app/src/onboarding/Setup.tsx'],
  ['Edit', 'app/src/onboarding/Setup.tsx'], ['Edit', 'app/src/onboarding/steps.ts'], ['Bash', 'npm run build'],
  ['Bash', 'git commit -m "one-click GitHub connect"'], ['Bash', 'git push -u origin world/github-connect-b4821'],
  ['Bash', 'gh pr create --base main --title "[WORLD] One-click…'],
];
const STEPS = ['reading CLAUDE.md', 'searching code', 'reading Setup.tsx', 'editing Setup.tsx', 'editing steps.ts',
  'building', 'committing', 'pushing branch', 'opening PR'];
const FEATURE = 'One-click GitHub connect in setup';

function session(i, state, extra = {}) {
  return { kind: 'dev_session', job_id: 'b48211', feature: FEATURE, state, mode: 'local',
    step: STEPS[Math.min(i, STEPS.length - 1)], elapsed_s: 4 + i * 11,
    tail: TAIL.slice(0, i + 1).map(([tool, target]) => ({ tool, target })),
    procedure: { title: 'ship_customer_feature_request', steps: 7, score: 0.83 }, session_url: null, pr: null, ...extra };
}

function github(preview, checks) {
  return { kind: 'dev_github', repo: 'qtzx06/opal', prs: [
    { number: 12, title: `[WORLD] ${FEATURE}`, branch: 'world/github-connect-b48211', state: 'open', checks,
      additions: 38, deletions: 9, files: ['app/src/onboarding/Setup.tsx', 'app/src/onboarding/steps.ts', 'app/src/lib/github.ts'],
      preview_url: preview ? 'https://opal-git-world-github-connect-qtzx06.vercel.app' : null,
      url: 'https://github.com/qtzx06/opal/pull/12', hunk_file: 'app/src/onboarding/Setup.tsx', hunk: HUNK },
    { number: 11, title: '[WORLD] Dark mode toggle on landing', branch: 'world/dark-mode-b31002', state: 'open', checks: 'pass',
      additions: 21, deletions: 4, files: ['app/src/landing/Nav.tsx'], preview_url: null, url: '', hunk: [] },
  ] };
}

// Placeholder "screenshot" of the Opal landing with the new How it works section under the hero, drawn at
// runtime (no base64 blob in the repo). Lazy: only built when the mock actually applies the message.
let mockShotB64 = null;
function mockShot() {
  if (mockShotB64) return mockShotB64;
  const W = 1280, H = 1600;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const F = (w, px) => `${w} ${px}px ${FONT}`;
  g.fillStyle = '#fbfaf7'; g.fillRect(0, 0, W, H);
  // nav
  g.fillStyle = '#111'; g.font = F(700, 28); g.fillText('opal', 64, 62);
  g.font = F(500, 18); g.fillStyle = '#555';
  ['Product', 'Pricing', 'Docs'].forEach((s, i) => g.fillText(s, 820 + i * 110, 60));
  g.fillStyle = '#111'; g.beginPath(); g.roundRect(1110, 32, 110, 44, 22); g.fill();
  g.fillStyle = '#fff'; g.font = F(600, 16); g.fillText('Sign in', 1136, 60);
  // hero
  const hg = g.createLinearGradient(0, 110, 0, 700);
  hg.addColorStop(0, '#eef4ff'); hg.addColorStop(1, '#fbfaf7');
  g.fillStyle = hg; g.fillRect(0, 110, W, 600);
  g.fillStyle = '#111'; g.font = F(700, 76); g.textAlign = 'center';
  g.fillText('Ship the thing,', W / 2, 300); g.fillText('not the setup.', W / 2, 390);
  g.fillStyle = '#555'; g.font = F(400, 24);
  g.fillText('Opal turns a repo into a running product in one click.', W / 2, 460);
  g.fillStyle = '#3b5bfd'; g.beginPath(); g.roundRect(W / 2 - 110, 510, 220, 60, 30); g.fill();
  g.fillStyle = '#fff'; g.font = F(600, 20); g.fillText('Get started', W / 2, 548);
  // the new section (what the PR adds), outlined so it reads as "new" in the demo
  const sy = 760;
  g.strokeStyle = '#3b5bfd'; g.setLineDash([10, 8]); g.lineWidth = 3;
  g.beginPath(); g.roundRect(40, sy - 30, W - 80, 560, 24); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#3b5bfd'; g.font = F(700, 16); g.fillText('NEW', W / 2, sy + 20);
  g.fillStyle = '#111'; g.font = F(700, 52); g.fillText('How it works', W / 2, sy + 90);
  const steps = [['1', 'Connect GitHub', 'Pick a repo. We detect the stack.'], ['2', 'Preview every PR', 'Each branch gets a live URL.'],
    ['3', 'Get paid', 'Payouts explained up front.']];
  steps.forEach(([n, h, d], i) => {
    const x = 100 + i * 370, y = sy + 150;
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(x, y, 330, 300, 20); g.fill();
    g.strokeStyle = '#e4e4e0'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#eef1ff'; g.beginPath(); g.arc(x + 165, y + 80, 36, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3b5bfd'; g.font = F(700, 30); g.fillText(n, x + 165, y + 91);
    g.fillStyle = '#111'; g.font = F(700, 26); g.fillText(h, x + 165, y + 170);
    g.fillStyle = '#666'; g.font = F(400, 18); g.fillText(d, x + 165, y + 210);
  });
  // rest of the page
  g.fillStyle = '#111'; g.fillRect(0, 1380, W, 220);
  g.fillStyle = '#fff'; g.font = F(700, 36); g.fillText('Loved by builders at YC', W / 2, 1480);
  g.textAlign = 'left';
  mockShotB64 = c.toDataURL('image/jpeg', 0.82).split(',')[1];
  return mockShotB64;
}

const MOCK_SHOT = { kind: 'preview_shot', job_id: 'b451461', pr: 5, title: '[WORLD] Add How it works section under hero',
  url: 'http://192.168.1.20:4301/', w: 1280, h: 1600, get jpeg_b64() { return mockShot(); } };

// [ms, msg] entries merged into mock.js DEMO_SCRIPT. Deltas attach to the only card.
export const DEV_SCRIPT = [
  [2200, { kind: 'context_delta', person_id: 'matthew', delta_kind: 'preference', text: '+ wants payouts explained up front' }],
  [3600, { kind: 'context_delta', person_id: 'matthew', delta_kind: 'fact', text: '+ found the landing page confusing' }],
  [7200, { kind: 'context_delta', person_id: 'matthew', delta_kind: 'open_loop_you_owe', text: '+ send him the preview link' }],
  ...STEPS.map((_, i) => [9000 + i * 900, session(i, 'running')]),
  [13500, github(false, 'pending')],
  [17200, session(8, 'pr_open', { step: 'PR #12 opened · building preview', pr: 12 })],
  [19500, github(true, 'pass')],
  [19600, session(8, 'done', { step: 'PR #12 · preview ready', pr: 12, elapsed_s: 96 })],
  [21000, MOCK_SHOT], // world service served + screenshotted the branch: pops in front of the wearer
  [34000, session(8, 'done', { step: 'PR #12 · preview ready', pr: 12, elapsed_s: 96 })], // periodic re-send; also keeps the loop long enough to play with the preview
];
