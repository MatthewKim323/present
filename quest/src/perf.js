// Headset survival kit. URL flags (config.js):
//   ?perf=1  tiny overlay: fps, frame ms p50/p95, draw calls, textures (XR: head-locked corner, desktop: DOM)
//   ?lite=1  stage fallback: no scan line, no swarm particles/trails, no radar animation, slower label redraws
//   ?diag=1  diagnostics section in the control panel (XR features, cameras, ws RTT, GPU) for the first headset run
// Also: rate gates for animated canvas labels, the OFFLINE chip, and a warn-once helper.
import { config } from './config.js';

export const LITE = !!config.lite;

// Animated canvas labels redraw at most this often (textures re-upload each redraw).
export const ANIM_HZ = LITE ? 8 : 18;

// true when `hz` allows another redraw for this holder (holder._t stores the last draw time).
export function due(holder, hz = ANIM_HZ, t = performance.now(), key = '_drawT') {
  if (holder[key] != null && t - holder[key] < 1000 / hz) return false;
  holder[key] = t;
  return true;
}

// console.warn at most once per 5 s per tag, so a bad message kind can't flood the Quest console.
const warned = new Map();
export function warnOnce(tag, ...rest) {
  const t = performance.now();
  if (t - (warned.get(tag) || -1e9) < 5000) return;
  warned.set(tag, t);
  console.warn(`[world] ${tag}`, ...rest);
}

// Run fn, never throw. One failing HUD layer must not stop the frame loop (three.js stops requesting
// frames when the animation callback throws: the HUD would freeze in the headset).
export function safe(tag, fn) {
  try { return fn(); } catch (e) { warnOnce(tag, e); return undefined; }
}

// ---------------------------------------------------------------- frame stats

const N = 240;
export const stats = {
  ms: new Float32Array(N), dt: new Float32Array(N), i: 0, n: 0, last: 0,
  calls: 0, tris: 0, textures: 0, geometries: 0, uploads: 0,
};

export function frameBegin() { return performance.now(); }

// t0 from frameBegin; renderer optional (XR).
export function frameEnd(t0, renderer) {
  const t = performance.now();
  const s = stats;
  s.ms[s.i] = t - t0;
  s.dt[s.i] = s.last ? t - s.last : 0;
  s.last = t;
  s.i = (s.i + 1) % N;
  s.n = Math.min(N, s.n + 1);
  if (renderer) {
    s.calls = renderer.info.render.calls;
    s.tris = renderer.info.render.triangles;
    s.textures = renderer.info.memory.textures;
    s.geometries = renderer.info.memory.geometries;
  }
}

const tmp = new Float32Array(N);
function pct(arr, p) {
  const n = stats.n;
  if (!n) return 0;
  for (let i = 0; i < n; i++) tmp[i] = arr[i];
  const v = tmp.subarray(0, n).sort();
  return v[Math.min(n - 1, Math.floor(p * n))];
}

export function summary() {
  const dt = pct(stats.dt, 0.5);
  return {
    fps: dt ? 1000 / dt : 0,
    p50: pct(stats.ms, 0.5),
    p95: pct(stats.ms, 0.95),
    calls: stats.calls,
    textures: stats.textures,
    geometries: stats.geometries,
  };
}

export function perfLine() {
  const s = summary();
  const gpu = s.calls || s.textures ? `  ${s.calls}dc  ${s.textures}tex` : ''; // desktop has no three renderer
  return `${s.fps.toFixed(0)}fps  ${s.p50.toFixed(1)}/${s.p95.toFixed(1)}ms${gpu}${LITE ? '  LITE' : ''}`;
}

// ---------------------------------------------------------------- small canvases (perf + offline)

const FONT = 'ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';

function chip(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w * 2; c.height = h * 2;
  const g = c.getContext('2d');
  g.scale(2, 2);
  g.beginPath();
  g.roundRect(0.5, 0.5, w - 1, h - 1, h / 2);
  g.fillStyle = 'rgba(8,10,14,0.62)';
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.stroke();
  draw(g);
  return c;
}

// XR perf overlay texture (msg = perfLine() string).
export function drawPerf(line) {
  return chip(220, 20, (g) => {
    g.font = `500 9.5px ${MONO}`;
    g.fillStyle = 'rgba(232,236,240,0.8)';
    g.fillText(line, 10, 13.5);
  });
}

// Subtle OFFLINE chip (msg = text like "OFFLINE · retry 3s").
export function drawOffline(text) {
  return chip(170, 20, (g) => {
    g.fillStyle = '#ffb86b';
    g.beginPath(); g.arc(11, 10, 3, 0, Math.PI * 2); g.fill();
    g.font = `600 9px ${FONT}`;
    if ('letterSpacing' in g) g.letterSpacing = '1.2px';
    g.fillStyle = 'rgba(232,236,240,0.78)';
    g.fillText(text, 20, 13.5);
  });
}

// null when connected (or mock-only with no server ever seen), else the chip text.
export function offlineText(net, t = performance.now()) {
  if (!net || net.state === 'open') return null;
  if (t - net.since < 1500) return null; // brief blips don't flash the chip
  if (config.mock && !net.everOpen) return null; // ?mock=1 without a server: nothing is wrong
  const s = Math.max(0, Math.ceil((net.retryAt - t) / 1000));
  return net.state === 'connecting' ? 'OFFLINE · reconnecting' : `OFFLINE · retry ${s}s`;
}

// ---------------------------------------------------------------- desktop DOM overlays

// Desktop: DOM chips (perf numbers + offline), updated at 2 Hz. XR draws its own (xr.js).
export function mountDesktopOverlays(hud) {
  const el = document.createElement('div');
  el.id = 'hud-chips';
  el.style.cssText = 'position:fixed;top:12px;right:12px;display:flex;flex-direction:column;gap:6px;align-items:flex-end;z-index:15;pointer-events:none;' +
    `font:500 10.5px ${MONO};color:rgba(232,236,240,0.8)`;
  const pill = 'padding:4px 10px;border-radius:10px;background:rgba(8,10,14,0.62);border:1px solid rgba(255,255,255,0.12)';
  const off = document.createElement('div');
  off.style.cssText = pill + ';color:#ffb86b;letter-spacing:1.2px;font-weight:600;display:none';
  const pf = document.createElement('div');
  pf.style.cssText = pill + (config.perf ? '' : ';display:none');
  el.append(off, pf);
  document.body.appendChild(el);
  setInterval(() => {
    const o = offlineText(hud.net);
    off.style.display = o ? '' : 'none';
    if (o) off.textContent = `● ${o}`;
    if (config.perf) pf.textContent = perfLine();
  }, 500);
}

// ---------------------------------------------------------------- ?diag=1

// Renders into the control panel (#ui). info: { link, xrInfo() -> {...} | null }.
export function mountDiag({ link, xrInfo }) {
  const box = document.createElement('pre');
  box.id = 'diag';
  box.style.cssText = `margin:8px 0 0;padding:8px;border-radius:8px;background:rgba(255,255,255,0.04);font:10px/1.45 ${MONO};` +
    'white-space:pre-wrap;max-height:46vh;overflow:auto;opacity:0.9';
  document.getElementById('ui').appendChild(box);
  const rows = { page: '', xr: 'checking…', gl: '', cams: 'no permission yet (tap 1. Camera + mic)', ws: '', health: '' };

  const ua = navigator.userAgent;
  rows.page = [
    `browser  ${ua.match(/OculusBrowser\/[\d.]+/)?.[0] || ua.match(/Chrome\/[\d.]+/)?.[0] || ua.slice(0, 60)}`,
    `origin   ${location.origin}  secure=${isSecureContext}`,
    `apis     gUM=${!!navigator.mediaDevices?.getUserMedia} MSTP=${'MediaStreamTrackProcessor' in window} worklet=${!!window.AudioWorkletNode} xr=${!!navigator.xr}`,
    `device   dpr=${devicePixelRatio} cores=${navigator.hardwareConcurrency || '?'} mem=${navigator.deviceMemory || '?'}GB`,
    `flags    ${location.search || '(none)'}`,
  ].join('\n');

  // XR support (after IWER installs, if ?emulate=1, so wait a beat)
  setTimeout(async () => {
    if (!navigator.xr) { rows.xr = 'navigator.xr missing (needs https or localhost)'; return; }
    const q = async (m) => navigator.xr.isSessionSupported(m).catch((e) => `err ${e.name}`);
    rows.xr = `supported ar=${await q('immersive-ar')} vr=${await q('immersive-vr')} inline=${await q('inline')}`;
  }, 800);

  // GPU: a throwaway context, released right away (browsers cap live WebGL contexts)
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      rows.gl = `gpu      ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}  maxTex=${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } else rows.gl = 'gpu      no webgl2';
  } catch (e) { rows.gl = `gpu      ${e.message}`; }

  const cams = async () => {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const v = devs.filter((d) => d.kind === 'videoinput'), a = devs.filter((d) => d.kind === 'audioinput');
      if (v.some((d) => d.label)) rows.cams = `${v.length} cams: ${v.map((d) => d.label).join(' | ')}\n         ${a.length} mics: ${a.map((d) => d.label || '?').join(' | ')}`;
      else rows.cams = `${v.length} cams, ${a.length} mics (labels after permission: tap 1. Camera + mic)`;
    } catch (e) { rows.cams = `enumerateDevices failed: ${e.message}`; }
  };
  const health = async () => {
    try {
      const t0 = performance.now();
      const r = await fetch('/health', { cache: 'no-store' });
      const ms = performance.now() - t0;
      const h = r.ok ? await r.json().catch(() => null) : null;
      const gb = h && (typeof h.gbrain === 'object' ? JSON.stringify(h.gbrain).slice(0, 60) : h.gbrain);
      rows.health = `http     /health ${r.status} ${ms.toFixed(0)}ms${h ? `  gbrain=${gb} enrolled=${h.enrolled}` : ''}`;
    } catch (e) { rows.health = `http     /health failed: ${e.message}`; }
  };
  const render = () => {
    const n = link.net;
    rows.ws = `ws       ${link.url}\n         ${n.state}  rtt=${link.rtt != null ? link.rtt.toFixed(0) + 'ms' : (n.state === 'open' ? 'n/a (no pong yet)' : '-')}  reconnects=${n.reconnects}  rx=${link.received}  tx=${link.sent}`;
    const x = xrInfo && xrInfo();
    const xr = x ? `\nsession  features=[${x.features.join(', ')}]\n         fps=${x.frameRate ?? '?'} supported=[${x.rates.join(',')}] blend=${x.blend} fbScale=${x.fbScale}` : '';
    box.textContent = ['DIAG', rows.page, `xr       ${rows.xr}${xr}`, rows.gl, `cams     ${rows.cams}`, rows.ws, rows.health].join('\n');
  };
  cams(); health();
  navigator.mediaDevices?.addEventListener?.('devicechange', cams);
  setInterval(cams, 4000);
  setInterval(health, 10000);
  setInterval(render, 1000);
  render();
}
