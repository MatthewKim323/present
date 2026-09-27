import { config } from './config.js';
import { Link } from './link.js';
import { HudState } from './hud.js';
import { DesktopHud } from './desktop.js';
import { XrHud } from './xr.js';
import { runMock } from './mock.js';
import { listCameras, pickCamera, openCamera, openMic, FrameGrabber, MicStreamer } from './capture.js';

const $ = (id) => document.getElementById(id);
const video = $('cam');
const hud = new HudState();
const isQuest = /OculusBrowser|Quest/i.test(navigator.userAgent);
const source = config.source || (isQuest ? 'quest3s' : 'desktop-sim');

let audioCtx = null;
let grabber = null, mic = null, xr = null, desktop = null, camLabel = '';

function log(s) {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString()} ${s}\n` + el.textContent.slice(0, 3000);
}

const link = new Link(config.wsUrl, {
  onMessage: (m) => hud.apply(m),
  onStatus: (s) => log(`ws ${s} ${config.wsUrl}`),
});
if (config.mock) runMock((m) => hud.apply(m));

const trackArg = (id) => (id == null ? null : /^\d+$/.test(String(id)) ? Number(id) : id);
function pinch(track) {
  const msg = { kind: 'gesture', type: 'pinch', target_track_id: trackArg(track) };
  link.send(msg);
  log(`-> ${JSON.stringify(msg)}`);
}

function statusLine() {
  const cam = grabber ? `cam ${grabber.rate.toFixed(1)}fps ${grabber.canvas.width}x${grabber.canvas.height}` : 'cam off';
  const m = mic ? `mic ${mic.chunks ? (mic.level > 0.02 ? 'live' : 'quiet') : 'wait'}` : 'mic off';
  return `${cam} · ${m} · ws ${link.state}${config.mock ? ' · mock' : ''} · ${source}`;
}
setInterval(() => { $('status').textContent = statusLine() + (camLabel ? `\n${camLabel}` : ''); }, 500);

// ---- capture ---------------------------------------------------------------

async function startCapture(deviceId) {
  if (grabber) { grabber.stop(); video.srcObject && video.srcObject.getTracks().forEach((t) => t.stop()); }
  const stream = await openCamera(deviceId);
  video.srcObject = stream;
  await video.play().catch(() => {});
  const track = stream.getVideoTracks()[0];
  camLabel = track.label;
  log(`camera: ${track.label} ${JSON.stringify(track.getSettings().width)}x${JSON.stringify(track.getSettings().height)}`);
  grabber = new FrameGrabber({
    stream, videoEl: video, fps: config.fps, width: config.width, quality: config.jpegQuality,
    onFrame: (f) => {
      hud.frameSize = [f.w, f.h];
      link.send({ kind: 'frame', ...f, head_pose: xr ? xr.headPose : [0, 0, 0, 0, 0, 0, 1] }, { droppable: true });
    },
  });
  grabber.start();
  await fillCameraSelect(track.getSettings().deviceId);
}

async function fillCameraSelect(activeId) {
  const cams = await listCameras();
  const sel = $('cam-select');
  sel.innerHTML = '';
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.deviceId;
    o.textContent = c.label || c.deviceId.slice(0, 8);
    if (c.deviceId === activeId) o.selected = true;
    sel.appendChild(o);
  }
  log(`cameras: ${cams.map((c) => c.label || '?').join(' | ')}`);
}

async function startMic() {
  if (mic || !config.audio) return;
  try {
    const stream = await openMic();
    mic = new MicStreamer({ ctx: audioCtx, stream, chunkMs: config.audioChunkMs, onChunk: (a) => link.send({ kind: 'audio', ...a }, { droppable: true }) });
    await mic.start();
    log(`mic: ${stream.getAudioTracks()[0].label}`);
  } catch (e) {
    log(`mic failed: ${e.message}`);
    mic = null;
  }
}

// First getUserMedia unlocks labels, then pick the best world-facing camera.
async function bootCapture() {
  // Must happen synchronously in the click, before any await, or it stays suspended.
  if (!audioCtx && config.audio) { audioCtx = new AudioContext(); audioCtx.resume().catch(() => {}); }
  try {
    if (!config.video) throw new Error('video disabled (?video=0)');
    await startCapture();
    const best = pickCamera(await listCameras(), config.camHint);
    if (best && best.label && best.label !== camLabel) await startCapture(best.deviceId);
  } catch (e) {
    log(`camera failed: ${e.name} ${e.message}`);
  }
  startMic(); // not awaited: never block the HUD on the mic
}

// ---- modes -----------------------------------------------------------------

$('btn-desktop').onclick = async () => {
  if (!grabber && !mic) await bootCapture();
  if (!desktop) desktop = new DesktopHud({ canvas: $('overlay'), video, hud, onPinch: pinch });
  desktop.start();
  $('ui').classList.add('min');
  $('ui').onclick = (e) => { if (e.target === $('ui') || e.target.classList.contains('brand')) $('ui').classList.toggle('min'); };
};

// On Quest: tap "1. Camera + mic" first (accept the permission prompts), then
// "2. Enter AR". requestSession needs a fresh user gesture, so we never await
// permissions before it.
$('btn-start').onclick = () => bootCapture();

$('btn-ar').onclick = async () => {
  if (!grabber && !mic) bootCapture();
  try {
    desktop && desktop.stop();
    xr = new XrHud({ hud, config, onPinch: pinch, statusLine });
    xr.onEnd = () => { log('xr ended'); xr = null; };
    await xr.start();
    log('xr started');
  } catch (e) {
    log(`xr failed: ${e.message}`);
    xr = null;
  }
};

$('cam-select').onchange = (e) => startCapture(e.target.value).catch((err) => log(`camera failed: ${err.message}`));

$('btn-label').onclick = () => {
  const name = $('label-name').value.trim();
  const track = $('label-track').value.trim();
  if (!name || !track) return;
  const msg = { kind: 'label', track_id: trackArg(track), name };
  link.send(msg);
  log(`-> ${JSON.stringify(msg)}`);
};

// ?emulate=1: Meta's IWER polyfills navigator.xr as a Quest 3, so the XR path can
// be exercised in a desktop browser (no passthrough, but layout + pinch logic run).
const emulated = config.emulate
  ? import('iwer').then(({ XRDevice, metaQuest3 }) => { new XRDevice(metaQuest3).installRuntime({ forceInstall: true }); log('iwer: emulating Quest 3'); })
  : Promise.resolve();

emulated.then(() => XrHud.supported()).then((ok) => {
  $('btn-ar').disabled = !ok;
  if (!ok) $('btn-ar').title = 'immersive-ar not available in this browser';
});

log(`${source} · ${navigator.userAgent.match(/OculusBrowser\/[\d.]+/)?.[0] || 'desktop'}`);
