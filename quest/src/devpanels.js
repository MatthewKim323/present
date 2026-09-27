// Dev cockpit: GitHub + Claude Code panels beside the person card, plus live
// `context_delta` lines under the card. Same look as panels.js (dark glass, small
// type, one accent). All data comes from the world service (contracts/EVENTS.md:
// dev_github, dev_session, context_delta); this file never talks to GitHub.
//
// Hooks (kept to a few lines in the teammate-owned files):
//   hud.js      applyDev(hud, msg) at the top of apply(); withDeltas(hud, card) on person_card
//   desktop.js  DesktopDev (placement + click), drawPersonCardPlus for cards
//   xr.js       XrDev (body-locked meshes + pinch on buttons), drawPersonCardPlus for cards
//   main.js     setDevSender(fn) so button presses go out as dev_action
import * as THREE from 'three';
import { drawPersonCard } from './panels.js';

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
      hud.devGithub = msg;
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
    case 'clear':
      hud.devGithub = null; hud.devSession = null; hud.deltas.clear();
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
  const top = prs[0];
  const rest = prs.slice(1, 4);
  const hunk = top?.hunk || [];
  let h = 34;
  if (!top) h += 22;
  else h += 20 + 18 + 18 + 18 + (hunk.length ? 22 + hunk.length * 14 + 8 : 0) + 38 + rest.length * 18 + 4;
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

  // buttons (act on the newest PR)
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
    y += 16;
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
  text(ctx, foot, 72, y, { size: 10.5, font: MONO, color: m.session_url ? ACCENT : DIM, max: CC_W - 88 });
  return c;
}

// ---------------------------------------------------------------- actions

function act(hud, hit) {
  if (!hit) return false;
  const msg = { kind: 'dev_action', action: hit.action, pr: hit.pr };
  if (hit.action === 'comment' && hit.text) msg.text = hit.text;
  sender(msg);
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

// ---------------------------------------------------------------- desktop

export class DesktopDev {
  constructor(hud) {
    this.hud = hud;
    this.hits = [];
    this.cache = { gh: null, ghCanvas: null, s: null, sCanvas: null, sT: 0 };
    if (import.meta.env?.DEV) window.__devCockpit = this; // headless checks read button hit rects
  }

  // placed: Map(track id -> {x,y,w,h}) of drawn person cards; vr: video rect.
  draw(ctx, placed, vr) {
    const hud = this.hud;
    this.hits = [];
    const gh = hud.devGithub, ss = hud.devSession;
    if (!gh && !ss) return;
    const t = performance.now();
    if (gh && this.cache.gh !== gh) { this.cache.gh = gh; this.cache.ghCanvas = drawGithubPanel(gh); }
    if (ss && (this.cache.s !== ss || t - this.cache.sT > 120)) { this.cache.s = ss; this.cache.sT = t; this.cache.sCanvas = drawSessionPanel(ss, t); }
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
      put(c, x, y);
    }
  }

  click(x, y) {
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
const FOLLOW_DEG = 40;    // body-locked: re-center only when the head turns this far away

export class XrDev {
  constructor(scene, session, hud) {
    this.scene = scene;
    this.hud = hud;
    this.meshes = {}; // gh, ss -> { mesh, key, canvas }
    this.anchorYaw = null;
    this.anchorPos = null;
    hud.xrActive = true;
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
  frame(head, headQ, cardMeshes, dist = 1.6) {
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
    const place = (name, x) => {
      const m = this.meshes[name];
      const target = center.clone().addScaledVector(r, x);
      target.y = cy - m.h / 2;
      if (!m.placed) { m.mesh.position.copy(target); m.placed = true; } else m.mesh.position.lerp(target, 0.12);
      m.mesh.lookAt(head);
    };
    if (hud.devGithub) {
      const m = this._mesh('gh', hud.devGithub, () => drawGithubPanel(hud.devGithub));
      // left of the person: card sits right of their head, so skip past the card and a body width
      place('gh', card ? -(cardHalf + 0.55 + m.w / 2) : -(0.04 + m.w / 2));
    } else this._drop('gh');
    if (hud.devSession) {
      const s = hud.devSession;
      const sec = Math.floor(t / 250);
      const m = this._mesh('ss', `${s._rx}:${sec}`, () => drawSessionPanel(s, t));
      place('ss', card ? cardHalf + 0.06 + m.w / 2 : 0.04 + m.w / 2);
    } else this._drop('ss');
  }

  // Pinch: raycaster already set from the input ray. Returns true if a dev button took it.
  select(raycaster) {
    const gh = this.meshes.gh;
    if (!gh) return false;
    const hit = raycaster.intersectObject(gh.mesh, false)[0];
    if (!hit || !hit.uv) return false;
    const px = hit.uv.x * (gh.canvas.width / S), py = (1 - hit.uv.y) * (gh.canvas.height / S);
    const b = (gh.canvas.hits || []).find((h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h);
    return b ? act(this.hud, b) : true; // swallow pinches on the panel body
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
];
