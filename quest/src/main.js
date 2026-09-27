import { act as devAct, setDevSender } from "./devpanels.js";
import { createLiveWork } from './live-work.js';
import { createWorldApi } from './world-api.js';
import { personRequest } from './person-actions.js';
import { config } from "./config.js";
import { Link } from "./link.js";
import { HudState } from "./hud.js";
import { DesktopHud } from "./desktop.js";
import { XrHud } from "./xr.js";
import { DEMO_SCRIPT } from "./mock.js";
import { mockResolve } from './visionfx.js';
import {
  listCameras,
  pickCamera,
  openCamera,
  openMic,
  FrameGrabber,
  MicStreamer,
} from "./capture.js";
import { PANEL_CATALOG } from "./panel-catalog.js";
import { mountShell } from "./shell.jsx";
import { mountDesktopOverlays, mountDiag } from './perf.js';

const video = document.getElementById("cam");
const hud = new HudState();
const isQuest = /OculusBrowser|Quest/i.test(navigator.userAgent);
const source = config.source || (isQuest ? "quest3s" : "desktop-sim");
let audioCtx, grabber, mic, xr, lastXr, desktop, link;
let cameraLocalOnly = false;
let mode = "idle",
  busy = false,
  error = "",
  cameras = [],
  cameraId = "",
  camLabel = "",
  arSupported = false;
let studio = false,
  studioType = "person";
let previewPhase = 0,
  previewTimer,
  phaseTimers = [],
  muted = false;
const logs = [];
const listeners = new Set();
const notify = () => {
  document.body.dataset.camera = grabber ? "on" : "off";
  listeners.forEach((fn) => fn());
};
const log = (message) => {
  logs.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
  logs.length = Math.min(logs.length, 30);
  notify();
};
const trackArg = (id) =>
  id == null ? null : /^\d+$/.test(String(id)) ? Number(id) : id;

setDevSender(message => {
  if (mode !== "live") return false;
  return link?.send(message) || false;
});

const worldApi = createWorldApi();
const personActions = new Set();
const liveWork = createLiveWork({ api: worldApi, hud, isLive: () => mode === 'live',
  onChange: snapshot => {
    if (!snapshot.errors.watches) for (const [id, states] of hud.personActionState || []) {
      if (states.watch !== 'done' || snapshot.watches.some(w => w.active && w.match?.person_id === id && w.match?.type === 'feature_request.detected')) continue;
      personActions.delete(`${id}:watch`);
      const card = [...hud.cards.values()].find(c => c.person_id === id);
      if (card) markPersonAction(card, 'watch', null);
    }
    notify();
  }, onError: e => log(`backend: ${e.message}`) });
let pendingDetail = null;
function showDetail(target) {
  if (xr?.session) {
    pendingDetail = target;
    hud.apply({ kind: 'memory_event', text: 'details ready', detail: 'exit AR to open services' });
  } else window.dispatchEvent(new CustomEvent('world:details', { detail: target }));
}
function markPersonAction(card, action, state) {
  hud.personActionState ||= new Map();
  const states = { ...(hud.personActionState.get(card.person_id) || {}), [action]: state };
  hud.personActionState.set(card.person_id, states);
  for (const [id, current] of hud.cards) if (current.person_id === card.person_id)
    hud.cards.set(id, { ...current, _actionState: states });
  hud.touch();
}
async function personAction(track, action) {
  const card = hud.cards.get(String(track));
  const key = `${card?.person_id}:${action}`;
  if (personActions.has(key)) return;
  if (mode !== 'live') {
    hud.apply({ kind: 'memory_event', text: 'simulated encounter', detail: 'connect live to create an agent or watch' });
    notify(); return;
  }
  try {
    const body = personRequest(card, action);
    personActions.add(key);
    markPersonAction(card, action, 'pending');
    hud.apply({ kind: 'memory_event', text: action === 'adopt' ? 'creating agent' : 'creating watch', detail: card.name });
    notify();
    await (action === 'adopt' ? worldApi.qmAdopt(body) : worldApi.qmWatch(body));
    markPersonAction(card, action, 'done');
    hud.apply({ kind: 'memory_event', text: action === 'adopt' ? 'agent ready' : 'watch active', detail: card.name });
    void liveWork.refresh();
  } catch (e) {
    personActions.delete(key);
    if (card) markPersonAction(card, action, null);
    hud.apply({ kind: 'memory_event', text: 'action failed', detail: e.message });
  }
  notify();
}
hud.onPersonAction = personAction;
window.addEventListener('world:qm-token', () => { if (mode === 'live') void liveWork.refresh(); });

function ensureLink() {
  if (link) return;
  link = new Link(config.wsUrl, {
    onMessage: (message) => {
      hud.apply(message);
      if (['qm_swarm', 'agent_activity', 'memory_event'].includes(message.kind)) void liveWork.refresh();
      notify();
    },
    onStatus: (state) => {
      // The server replays its current panels after open. Discard stale local
      // panels first, including dismissals missed while disconnected.
      if (state === "open") { hud.resetPanels(); void liveWork.refresh(); }
      log(`connection ${state}`);
    },
  });
  hud.net = link.net;
}
function pinch(track) {
  if (mode === "preview") return;
  link?.send({
    kind: "gesture",
    type: "pinch",
    target_track_id: trackArg(track),
  });
}
function showDesktop() {
  if (!desktop)
    desktop = new DesktopHud({
      canvas: document.getElementById("overlay"),
      video,
      hud,
      onPinch: pinch,
    });
  desktop.stop();
  desktop.start();
}
function statusLine() {
  if (mode === "preview") return "preview · simulated encounter";
  return `${grabber ? `camera ${grabber.rate.toFixed(1)} fps` : "camera off"} · ${mic ? (muted ? "mic muted" : "mic on") : "mic off"} · ${link?.state === "open" ? "connected" : "offline"}`;
}
function stopPreview() {
  clearInterval(previewTimer);
  phaseTimers.forEach(clearTimeout);
  phaseTimers = [];
}
function stopCapture() {
  cameraLocalOnly = false;
  grabber?.stop();
  grabber = null;
  video.srcObject?.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
  if (mic) {
    mic.stream.getTracks().forEach((track) => track.stop());
    mic.stop();
    mic = null;
  } else audioCtx?.close().catch(() => {});
  audioCtx = null;
  camLabel = "";
  muted = false;
}
function setMode(next) {
  mode = next;
  if (next === 'live') liveWork.start(); else liveWork.stop();
  document.body.dataset.mode = next;
  notify();
}
function phase(next) {
  phaseTimers.forEach(clearTimeout);
  phaseTimers = [];
  previewPhase = next;
  hud.apply({ kind: "clear" });
  for (const [time, message] of DEMO_SCRIPT) {
    if (message.kind === "track") continue;
    if (time <= [800, 5200, 6000][next]) hud.apply(mockResolve(message));
  }
  hud.selectedTrack = "3";
  hud.setView(["person", "memories", "agents"][next]);
  hud.apply({
    kind: "track",
    track_id: 3,
    bbox: [0.35, 0.32, 0.16, 0.35],
    label: "Matthew · simulated",
  });
  if (next === 2) {
    for (const [time, message] of DEMO_SCRIPT.filter(([time, msg]) => time > 6000 && msg.kind !== 'track'))
      phaseTimers.push(setTimeout(() => { hud.apply(mockResolve(message)); notify(); }, time - 6000));
  }
  notify();
}
async function preview() {
  if (busy) return;
  if (xr) await xr.end();
  stopCapture();
  stopPreview();
  studio = false;
  link?.close();
  link = null;
  hud.net = null;
  error = "";
  setMode("preview");
  phase(0);
  showDesktop();
  previewTimer = setInterval(
    () =>
      hud.apply({
        kind: "track",
        track_id: 3,
        bbox: [0.35, 0.32, 0.16, 0.35],
        label: "Matthew · simulated",
      }),
    1000,
  );
}
async function startCapture(deviceId) {
  const stream = await openCamera(deviceId);
  grabber?.stop();
  grabber = null;
  video.srcObject?.getTracks().forEach((track) => track.stop());
  video.srcObject = stream;
  try {
    await video.play();
  } catch (e) {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    throw e;
  }
  const track = stream.getVideoTracks()[0];
  camLabel = track.label;
  cameraId = track.getSettings().deviceId;
  grabber = new FrameGrabber({
    stream,
    videoEl: video,
    fps: config.fps,
    width: config.width,
    quality: config.jpegQuality,
    onFrame: (frame) => {
      hud.frameSize = [frame.w, frame.h];
      if (!cameraLocalOnly)
        link?.send(
          {
            kind: "frame",
            ...frame,
            head_pose: xr ? xr.headPose : [0, 0, 0, 0, 0, 0, 1],
          },
          { droppable: true },
        );
    },
  });
  grabber.start();
  cameras = await listCameras();
  log(`camera ready: ${camLabel}`);
}
async function startMic() {
  if (mic || !config.audio) return;
  let stream;
  try {
    stream = await openMic();
    mic = new MicStreamer({
      ctx: audioCtx,
      stream,
      chunkMs: config.audioChunkMs,
      onChunk: (chunk) => {
        if (!muted)
          link?.send({ kind: "audio", ...chunk }, { droppable: true });
      },
    });
    await mic.start();
    log("microphone ready");
  } catch (e) {
    stream?.getTracks().forEach((track) => track.stop());
    mic = null;
    error = `microphone unavailable: ${e.message}. you can still use the visual interface.`;
    log(error);
  }
}
async function live() {
  if (busy) return;
  cameraLocalOnly = false;
  busy = true;
  error = "";
  notify();
  // AudioContext must be resumed synchronously in the user gesture.
  if (config.audio && !audioCtx) {
    audioCtx = new AudioContext();
    audioCtx.resume().catch(() => {});
  }
  stopPreview();
  studio = false;
  if (mode !== "live") hud.apply({ kind: "clear" });
  setMode("live");
  ensureLink();
  showDesktop();
  try {
    if (config.video) {
      await startCapture();
      const best = pickCamera(cameras, config.camHint);
      if (best?.label && best.label !== camLabel)
        await startCapture(best.deviceId);
    }
  } catch (e) {
    error = `camera unavailable: ${e.message}. check browser permissions or use the preview.`;
    log(error);
  }
  await startMic();
  busy = false;
  notify();
}
async function enterAR() {
  if (busy || xr) return;
  if (mode === "idle") {
    error = "start camera + mic first, then enter AR.";
    notify();
    return;
  }
  busy = true;
  error = "";
  notify();
  try {
    xr = new XrHud({
      hud,
      config,
      onPinch: pinch,
      statusLine,
      onPanelAction: panelAction,
      onPanelDismiss: panelDismiss,
    });
    xr.onEnd = () => {
      lastXr = xr;
      xr = null;
      if (pendingDetail) { showDetail(pendingDetail); pendingDetail = null; }
      showDesktop();
      notify();
    };
    await xr.start();
    desktop?.stop();
    log("AR session started");

  } catch (e) {
    error = `could not enter AR: ${e.message}`;
    xr = null;
    showDesktop();
    log(error);
  } finally {
    busy = false;
    notify();
  }
}
async function endSession() {
  if (busy) return;
  if (xr) await xr.end();
  stopPreview();
  stopCapture();
  desktop?.stop();
  link?.close();
  link = null;
  hud.net = null;
  hud.apply({ kind: "clear" });
  studio = false;
  error = "";
  setMode("idle");
}
function panelDismiss(id) {
  if (id === 'live:navigation' && !hud.panels.has(id)) return;
  if (id.startsWith('live:') && !hud.panels.has(id)) { liveWork.dismiss(id); notify(); return; }
  hud.apply({ kind: "panel", op: "dismiss", id });
  if (mode !== "preview") link?.send({ kind: "panel_dismiss", panel_id: id });
  notify();
}
function panelAction(id, actionId) {
  if (id.startsWith('live:') && !hud.panels.has(id)) {
    if (id === 'live:navigation') {
      const cards = (hud.workPanels || []).filter(panel => panel.view === hud.view);
      const slots = Math.max(1, 3 - hud.livePanels().length - 1);
      const count = Math.max(1, Math.ceil(cards.length / slots));
      hud.workPage = ((hud.workPage || 0) + (actionId === 'next-page' ? 1 : -1) + count) % count;
      hud.touch(); notify(); return;
    }
    void liveWork.action(id, actionId).then(target => {
      if (target?.url) {
        const pr = hud.devGithub?.prs?.find(pr => pr.url === target.url);
        if (pr) { devAct(hud, { action: 'select_pr', pr: pr.number }); hud.setView('person'); }
        else devAct(hud, { action: 'open_link', url: target.url });
      }
      else if (target?.id === 'details') showDetail(target);
      notify();
    }).catch(e => { hud.apply({ kind: 'memory_event', text: 'action failed', detail: e.message }); notify(); });
    return;
  }
  const requestId = crypto.randomUUID();
  if (!hud.beginPanelAction(id, actionId, requestId)) return;
  const receipt = (status) =>
    hud.apply({
      kind: "panel_result",
      panel_id: id,
      action_id: actionId,
      request_id: requestId,
      status,
    });
  if (mode === "preview") receipt("received");
  else {
    let sent = false;
    try {
      sent = !!link?.send({
        kind: "panel_action",
        panel_id: id,
        action_id: actionId,
        request_id: requestId,
      });
    } catch {
      /* Socket closed between open check and send. */
    }
    if (!sent) receipt("rejected");
  }
  notify();
}

function summon(type, append = false) {
  const entry = PANEL_CATALOG.find((item) => item.type === type);
  if (!entry) return;
  studioType = type;
  if (!append) hud.panels.clear();
  hud.apply({ kind: "panel", ...entry.sample, ttl_ms: 3600000 });
  notify();
}
async function openStudio() {
  if (busy) return;
  await preview();
  stopPreview();
  studio = true;
  hud.apply({ kind: "clear" });
  summon(studioType);
}
function connectAgent() {
  if (busy) return;
  stopPreview();
  if (mode !== "live") hud.apply({ kind: "clear" });
  studio = false;
  setMode("live");
  ensureLink();
  showDesktop();
}
const api = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  snapshot() {
    return {
      mode,
      studio,
      studioType,
      panels: hud.surfacePanels(),
      busy,
      error,
      cameras,
      cameraId,
      camLabel,
      arSupported,
      inAR: !!xr?.session,
      connected: link?.state === "open",
      connection: link?.state || "closed",
      camera: !!grabber,
      mic: !!mic,
      muted,
      fps: grabber?.rate || 0,
      previewPhase,
      view: hud.view,
      selectedTrack: hud.selectedTrack,
      people: [...hud.cards].map(([id, msg]) => ({ id, ...msg })),
      memories: hud.memoryHistory,
      workers:
        (
          hud.activity.get(hud.selectedTrack) ||
          [...hud.activity.values()].at(-1)
        )?.workers || [],
      memoryCount: hud.memoryHistory.length,
      logs: [...logs],
      status: statusLine(),
    };
  },
  preview,
  live,
  enterAR,
  endSession,
  phase,
  openStudio,
  summon,
  panelAction,
  panelDismiss,
  connectAgent,
  personAction,
  view(value) {
    hud.setView(value);
    if (!hud.selectedTrack && hud.cards.size)
      hud.selectedTrack = hud.cards.keys().next().value;
    notify();
  },
  select(id) {
    hud.select(id);
    pinch(id);
    notify();
  },
  dismiss() {
    hud.selectedTrack = null;
    hud.touch();
    notify();
  },
  toggleMic() {
    if (!mic) return;
    muted = !muted;
    mic.stream.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    notify();
  },
  async camera(id) {
    if (busy || mode === "idle") return;
    if (mode === "preview") cameraLocalOnly = true;
    busy = true;
    notify();
    try {
      await startCapture(id);
      error = "";
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      notify();
    }
  },
  label(track, name) {
    if (
      typeof name !== "string" ||
      typeof track !== "string" ||
      !name.trim() ||
      !track.trim()
    )
      return false;
    const sent = link?.send({
      kind: "label",
      track_id: trackArg(track),
      name: name.trim(),
    });
    if (!sent) {
      error = "connect to the world service before enrolling a person.";
      notify();
      return false;
    }
    log(`enrollment requested for ${name.trim()}`);
    return true;
  },
};
mountShell(api);
mountDesktopOverlays(hud);
if (config.diag) mountDiag({ link: () => link, xrInfo: () => (xr || lastXr)?.info() });
addEventListener('error', (e) => log(`error: ${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`));
addEventListener('unhandledrejection', (e) => log(`unhandled: ${e.reason?.message || e.reason}`));
setInterval(notify, 350);
const emulated = config.emulate
  ? import("iwer").then(({ XRDevice, metaQuest3 }) => {
      (window.__iwer = new XRDevice(metaQuest3)).installRuntime({ forceInstall: true });
      log("Quest emulator ready");
    })
  : Promise.resolve();
emulated
  .then(() => XrHud.supported())
  .then((ok) => {
    arSupported = ok;
    notify();
  })
  .catch((e) => log(e.message));
if (new URLSearchParams(location.search).get("live") === "1") connectAgent();
else if (new URLSearchParams(location.search).get("studio") === "1") openStudio();
else if (config.mock) preview();
window.addEventListener("pagehide", () => {
  stopPreview();
  stopCapture();
  link?.close();
});
