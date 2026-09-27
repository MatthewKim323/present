// Rasterize HUD panels to 2D canvases. Same pixels in desktop mode (drawn over
// the webcam) and in XR (used as textures on small planes). Subtle: dark glass,
// small type, one accent.


const FONT = 'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';
const ACCENT = '#7cf0c5';
const WARN = '#ffb86b';
const BAD = '#ff6b7a';
const S = 2; // supersample

function panel(w, h) {
  const c = document.createElement('canvas');
  c.width = w * S;
  c.height = h * S;
  const ctx = c.getContext('2d');
  ctx.scale(S, S);
  return { c, ctx, w, h };
}

function glass(ctx, w, h, r = 14) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, w - 1, h - 1, r);
  ctx.fillStyle = 'rgba(8, 10, 14, 0.66)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

function text(ctx, s, x, y, { size = 13, weight = 400, color = '#e8ecf0', font = FONT, track = 0, max } = {}) {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${track}px`;
  let str = String(s ?? '');
  if (max) while (str.length > 1 && ctx.measureText(str).width > max) str = str.slice(0, -2) + '…';
  ctx.fillText(str, x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

// 1. Person card: name, role/company, last topic, owes you / you owe.
export function drawPersonCard(m) {
  const w = 300;
  const rows = [m.last && ['LAST', m.last], m.owes_you && ['OWES YOU', m.owes_you], m.you_owe && ['YOU OWE', m.you_owe],
    m.watching && ['WATCHING', m.watching]].filter(Boolean);
  const h = 58 + rows.length * 20 + 6;
  const { c, ctx } = panel(w, h);
  glass(ctx, w, h);
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(18, 22, 3.5, 0, Math.PI * 2);
  ctx.fill();
  const pill = m.agent ? 58 : 0; // pinch-assigned entity agent (world.entity_adopted)
  text(ctx, (m.name || 'UNKNOWN').toUpperCase(), 30, 27, { size: 15, weight: 600, track: 2, max: w - 44 - pill });
  if (pill) {
    ctx.beginPath();
    ctx.roundRect(w - pill - 10, 13, pill, 18, 9);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.stroke();
    text(ctx, 'AGENT', w - pill + 3, 26, { size: 9.5, weight: 600, color: ACCENT, track: 1.4 });
  }
  text(ctx, m.subtitle || '', 30, 45, { size: 12, color: 'rgba(232,236,240,0.62)', max: w - 44 });
  let y = 70;
  for (const [k, v] of rows) {
    text(ctx, k, 16, y, { size: 9.5, weight: 600, color: k === 'YOU OWE' ? WARN : k === 'WATCHING' ? ACCENT : 'rgba(232,236,240,0.45)', track: 1.2 });
    text(ctx, v, 92, y, { size: 12, max: w - 106 });
    y += 20;
  }
  return c;
}

// 2. Memory event toast: "✓ FEATURE REQUEST REMEMBERED · Opal landing"
export function drawMemoryToast(m) {
  const probe = panel(1, 1).ctx;
  probe.font = `600 11px ${FONT}`;
  const main = `✓  ${(m.text || '').toUpperCase()}`;
  const mw = probe.measureText(main).width + main.length * 1.2;
  probe.font = `400 12px ${FONT}`;
  const dw = m.detail ? probe.measureText(`·  ${m.detail}`).width + 10 : 0;
  const w = Math.ceil(Math.min(560, mw + dw + 32));
  const h = 34;
  const { c, ctx } = panel(w, h);
  glass(ctx, w, h, 17);
  text(ctx, main, 16, 21.5, { size: 11, weight: 600, color: ACCENT, track: 1.2 });
  if (m.detail) text(ctx, `·  ${m.detail}`, 16 + mw + 8, 21.5, { size: 12, color: 'rgba(232,236,240,0.8)', max: w - mw - 30 });
  return c;
}

// 3. Agent activity: WorldHook swarm status.
export function drawAgentActivity(m, t = performance.now()) {
  const workers = m.workers || [];
  const w = 300;
  const h = 34 + workers.length * 22 + 8;
  const { c, ctx } = panel(w, h);
  glass(ctx, w, h);
  text(ctx, 'WORLDHOOK', 16, 22, { size: 9.5, weight: 600, color: 'rgba(232,236,240,0.45)', track: 1.4 });
  text(ctx, m.hook || '', 100, 22, { size: 11, font: MONO, color: 'rgba(232,236,240,0.75)', max: w - 114 });
  let y = 46;
  for (const wk of workers) {
    const st = wk.state || 'running';
    const col = st === 'done' ? ACCENT : st === 'failed' ? BAD : WARN;
    ctx.fillStyle = col;
    ctx.globalAlpha = st === 'running' ? 0.45 + 0.55 * Math.abs(Math.sin(t / 380)) : 1;
    ctx.beginPath();
    ctx.arc(20, y - 4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    text(ctx, wk.name || '', 32, y, { size: 12, weight: 600, max: 80 });
    text(ctx, wk.note || st, 112, y, { size: 11.5, color: 'rgba(232,236,240,0.62)', max: w - 126 });
    y += 22;
  }
  return c;
}

// Tiny status strip (XR only, so we can verify cam/mic/ws from inside the headset).
export function drawStatus(line) {
  const w = 360, h = 22;
  const { c, ctx } = panel(w, h);
  glass(ctx, w, h, 11);
  text(ctx, line, 10, 15, { size: 10, font: MONO, color: 'rgba(232,236,240,0.7)', max: w - 20 });
  return c;
}

export const anyRunning = (m) => (m.workers || []).some((w) => (w.state || 'running') === 'running');
