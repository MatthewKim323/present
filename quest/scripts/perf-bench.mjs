// Headless perf bench for the XR HUD: Chrome + IWER (emulated Quest 3) + ?mock=1, CPU throttled via CDP.
//   npm run dev                                   (or NO_HTTPS=1 npm run dev)
//   node scripts/perf-bench.mjs                    defaults: http://localhost:5173, 4x CPU, 42 s, 6 AR cycles
//   node scripts/perf-bench.mjs --url https://localhost:5173 --throttle 4 --secs 42 --cycles 6 --q "lite=1" --shot out.png
// Measures, while inside the emulated immersive-ar session:
//   frame JS time per rAF (every callback that ran for that frame: IWER + three + our HUD), p50/p95/p99,
//   frames over the 72 Hz budget (13.9 ms), texture uploads/s and MB/s (texImage2D/texSubImage2D),
//   main-thread busy % (CDP TaskDuration), draw calls + live textures (three renderer.info),
//   and after N enter/exit AR cycles: WebGL contexts created + live textures + JS heap after GC.
// SwiftShader renders WebGL on the CPU in headless, so GPU cost is not representative; the JS numbers are.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']] : a), []));
const BASE = args.url || 'http://localhost:5173';
const SECS = Number(args.secs || 42);
const THROTTLE = Number(args.throttle || 4);
const CYCLES = Number(args.cycles ?? 6);
const EXTRA = args.q ? `&${args.q}` : '';
const PORT = 9300 + Math.floor(Math.random() * 500);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'perfbench-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-swiftshader',
  '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

// Injected before any page script: time every rAF callback (grouped per frame), count texture uploads + GL contexts.
const INSTRUMENT = `(() => {
  const B = window.__bench = { frames: [], tex: 0, texBytes: 0, ctx: 0, on: false };
  const raf = window.requestAnimationFrame.bind(window);
  let cur = -1, dur = 0;
  window.requestAnimationFrame = (fn) => raf((ts) => {
    const a = performance.now();
    try { fn(ts); } finally {
      if (B.on) { if (ts !== cur) { if (cur >= 0) B.frames.push([cur, dur]); cur = ts; dur = 0; } dur += performance.now() - a; }
    }
  });
  const size = (args) => { for (const x of args) if (x && typeof x === 'object' && 'width' in x && 'height' in x && !(x instanceof ArrayBuffer)) return (x.width * x.height * 4) || 0; return 0; };
  for (const P of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!P) continue;
    for (const m of ['texImage2D', 'texSubImage2D']) {
      const orig = P.prototype[m];
      P.prototype[m] = function (...a) { if (B.on) { B.tex++; B.texBytes += size(a); } return orig.apply(this, a); };
    }
  }
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...r) { if (/webgl/.test(type) && !this.__counted) { this.__counted = true; B.ctx++; } return gc.call(this, type, ...r); };
})();`;

async function cdp() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not start');
}

const ws = new WebSocket(await cdp(), { perMessageDeflate: false });
await new Promise((r) => ws.once('open', r));
let id = 0;
const pending = new Map();
const logs = [];
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).split('\n')[0]);
  else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(m.params.type + ' ' + m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true })).result.value;
const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

await send('Page.enable');
await send('Runtime.enable');
await send('Performance.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
const url = args.raw ? `${BASE}/?${args.q || ''}` : `${BASE}/?mock=1&emulate=1&audio=0${EXTRA}`; // --raw: only --q params
await send('Page.navigate', { url });
await sleep(3000);

// --desktop: click Desktop, wait, screenshot (--shot), print console warnings/errors, exit. For visual checks.
if (args.desktop) {
  await ev(`document.getElementById('btn-desktop').click()`);
  await sleep(Number(args.wait || 5000));
  if (args.shot) writeFileSync(args.shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log(JSON.stringify({ url, errors: [...new Set(logs)].slice(0, 10) }, null, 2));
  chrome.kill();
  process.exit(0);
}

const enterAr = async () => {
  await ev(`document.getElementById('btn-ar').click()`);
  for (let i = 0; i < 40; i++) { if (await ev(`!!(window.__xrSwarm && window.__xrSwarm.xr.session)`)) return true; await sleep(250); }
  return false;
};
const exitAr = async () => {
  await ev(`window.__xrSwarm && window.__xrSwarm.xr.end()`);
  for (let i = 0; i < 40; i++) { if (await ev(`!(window.__xrSwarm && window.__xrSwarm.xr.session)`)) return true; await sleep(250); }
  return false;
};
const rinfo = () => ev(`(() => { const r = window.__xrSwarm && window.__xrSwarm.xr.renderer; return r ? { calls: r.info.render.calls, textures: r.info.memory.textures, geometries: r.info.memory.geometries, programs: (r.info.programs || []).length } : null; })()`);

if (!(await enterAr())) { console.error('could not enter AR', logs.slice(-5)); process.exit(1); }
await sleep(1000);
await send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
const m0 = await metrics();
await ev(`(__bench.frames = [], __bench.tex = 0, __bench.texBytes = 0, __bench.on = true)`);
const samples = [];
for (let s = 0; s < SECS; s += 3) { await sleep(3000); samples.push(await rinfo()); }
const b = await ev(`(__bench.on = false, { frames: __bench.frames, tex: __bench.tex, texBytes: __bench.texBytes, ctx: __bench.ctx })`);
const m1 = await metrics();
await send('Emulation.setCPUThrottlingRate', { rate: 1 });
if (args.shot) writeFileSync(args.shot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

const d = b.frames.map((f) => f[1]).sort((x, y) => x - y);
const pct = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))] || 0;
const span = (b.frames.at(-1)[0] - b.frames[0][0]) / 1000;
const wall = m1.Timestamp - m0.Timestamp;
const valid = samples.filter(Boolean);
const out = {
  url, throttle: THROTTLE, secs: +wall.toFixed(1),
  fps: +(b.frames.length / span).toFixed(1),
  frame_ms: { p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2), max: +d.at(-1).toFixed(1), mean: +(d.reduce((a, x) => a + x, 0) / d.length).toFixed(2) },
  over_13_9ms_pct: +((100 * d.filter((x) => x > 13.9).length) / d.length).toFixed(1),
  tex_uploads_per_s: +(b.tex / wall).toFixed(1),
  tex_MB_per_s: +(b.texBytes / 1e6 / wall).toFixed(2),
  main_thread_busy_pct: +((100 * (m1.TaskDuration - m0.TaskDuration)) / wall).toFixed(1),
  script_pct: +((100 * (m1.ScriptDuration - m0.ScriptDuration)) / wall).toFixed(1),
  draw_calls: { max: Math.max(...valid.map((x) => x.calls)), median: valid.map((x) => x.calls).sort((a, c) => a - c)[valid.length >> 1] },
  textures_max: Math.max(...valid.map((x) => x.textures)),
};

if (CYCLES > 0) {
  for (let i = 0; i < CYCLES; i++) { await exitAr(); await sleep(400); await enterAr(); await sleep(1500); }
  await send('HeapProfiler.enable');
  await send('HeapProfiler.collectGarbage');
  const m2 = await metrics();
  const r = await rinfo();
  out.after_cycles = { cycles: CYCLES, gl_contexts_created: await ev('__bench.ctx'), live_textures: r?.textures, live_geometries: r?.geometries, js_heap_MB: +(m2.JSHeapUsedSize / 1e6).toFixed(1) };
}
// --fuzz: feed malformed / unknown / oversized messages straight into HudState while in AR, then check the
// XR loop is still producing frames (a throw inside the animation callback would freeze the headset HUD).
if (args.fuzz) {
  const count = () => ev('__bench.frames.length');
  await ev('(__bench.frames = [], __bench.on = true)');
  const res = await ev(`(() => {
    const hud = window.__xrSwarm.hud, big = 'A'.repeat(7e6);
    const bad = [null, 42, 'str', [], {}, { kind: 'nope_unknown' }, { kind: 'vision', tracks: [{ track_id: 1 }, null, { track_id: 2, bbox: 'x' }] },
      { kind: 'vision', tracks: 'x' }, { kind: 'tracks', tracks: [null, { track_id: 5, bbox: [NaN, 1] }] }, { kind: 'person_card', anchor_track_id: 9, bbox: 'nope' },
      { kind: 'person_card' }, { kind: 'agent_activity', workers: 'x' }, { kind: 'qm_swarm', workers: [null, {}] }, { kind: 'qm_swarm', hook: 'h', workers: 7 },
      { kind: 'dev_github', prs: [{}] }, { kind: 'dev_github', prs: 'x' }, { kind: 'context_delta' }, { kind: 'relationship_vector', dims: 'x' },
      { kind: 'face_capture', track_id: 1, jpeg_b64: big }, { kind: 'preview_shot', jpeg_b64: big }, { kind: 'preview_shot', jpeg_b64: 5 },
      { kind: 'memory_event', text: { a: 1 } }, { kind: 'gbrain_op' }, { kind: 'procedure', phase: 'recalled' }, { type: 'person.encountered', payload: {} }];
    let threw = 0;
    for (const m of bad) { try { hud.apply(m); } catch { threw++; } }
    return { sent: bad.length, threw };
  })()`);
  await sleep(3000);
  out.fuzz = { ...res, frames_after_3s: await count() };
  await ev('__bench.on = false');
}
out.errors = [...new Set(logs)].slice(0, 8);
console.log(JSON.stringify(out, null, 2));
ws.close();
chrome.kill();
await sleep(300);
try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(0);
