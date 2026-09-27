// HUD layout: ONE plan for every layer, so the HUD reads as a single interface around the person.
//
// Zones, as the wearer sees them (the person in front of you is the center of the world):
//
//   ┌──────────────┬──────────────────────────┬──────────────────────┬─────────────────┐
//   │              │        TOASTS (top center, one line at a time)  │                 │
//   │  GBRAIN      │                          │                      │  QM SWARM       │
//   │  live feed   │   3D SWARM GRAPH         │  [ FACE ]  PERSON    │  lanes          │
//   │  (far left)  │   (left of face,         │  reticle   CARD      │  (far right)    │
//   │              │    the centerpiece)      │  + chip    + deltas  │                 │
//   │              │                          │            RADAR     │  MEMORABLE      │
//   │              │                          │                      │  stack (under)  │
//   │              │              GITHUB PR panel (lower center)     │                 │
//   └──────────────┴──────────────────────────┴──────────────────────┴─────────────────┘
//
// Hierarchy: person first (reticle, card, radar hug the face), then the swarm (the graph beside them,
// lanes on the right rail), then memory (GBrain rail on the left, Memorable under the lanes).
// De-dupe rules: the learned / recalled procedure is ONE card (memorypanel.js); swarmviz keeps only the
// MEMORABLE node glow + beams + a one-line label. Toasts that repeat a panel's own animation are dropped
// (toastFilter below). Radar stacks under the card, never above it.
//
// Density: ?hud=minimal|demo|full (default demo).
//   minimal  card + reticle + toasts (plus the status strip). Everything else hidden.
//   demo     everything, restrained sizes (stage default).
//   full     everything, full size (more feed lines, bigger graph).
//
// XR: meters in the PERSON FRAME: origin = face center at ?dist= (1.6 m), x = right (horizontal,
// perpendicular to the head->person ray), y = up. Body-locked to the person (panels lerp to their targets).
// Desktop: css px, responsive. One scale k shrinks the side panels until the rails fit the viewport.
//
// Modules read their placement from here; their rendering code is untouched.
//   xr.js        computes the person frame each frame (xrFrame) -> hud.lx
//   desktop.js   computes the zones each frame (deskZones)      -> hud.ld
//   devpanels / visionfx / brainpanel / memorypanel / swarmviz read hud.lx / hud.ld.
import * as THREE from 'three';

const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const MODES = ['minimal', 'demo', 'full'];
export const HUD_MODE = MODES.includes(q.get('hud')) ? q.get('hud') : 'demo';

// ---------------------------------------------------------------- layers per mode

const MINIMAL = new Set(['card', 'deltas', 'reticle', 'toasts', 'status', 'activity']);
export function show(layer) {
  if (HUD_MODE !== 'minimal') return true;
  return MINIMAL.has(layer);
}
// layer names: card deltas reticle toasts status activity | radar swarm3d brain qmswarm memorable github preview

const FULL = HUD_MODE === 'full';

// ---------------------------------------------------------------- shared knobs

export const BRAIN_LINES = FULL ? 8 : 5;         // GBRAIN feed lines (fixed column height)
export const TOAST_MAX = 1;                      // toasts on screen at once (one line)

// ---------------------------------------------------------------- XR (meters, person frame)

export const XR = {
  panel: FULL ? 1 : 0.88,          // scale on every side panel (card stays 1: person first)
  gap: 0.04,                       // between panels in a column
  colGap: 0.06,                    // between columns
  faceHalfMin: 0.09,               // half face width when no bbox (m)
  // right of face: person card is placed by xr.js (bbox edge); radar stacks under it
  radarGap: 0.02,
  // far right rail: QM SWARM lanes, Memorable under them. x = left edge, from the card's right edge.
  rightTop: 0.16,                  // top edge above face center
  // left of face: 3D swarm graph. Graph local x spans ~[-0.52, 0.62], y ~[+0.05, -0.55] (EVENT at 0).
  graphScale: FULL ? 0.9 : 0.72,   // group scale
  graphPull: 0.35,                 // toward the wearer along the ray (m): reads in front of the rails
  graphRight: 0.62,                // local +x extent (PR label), keeps the graph off the face
  graphLeft: 0.55,                 // local -x extent (GBRAIN label)
  graphTop: 0.1,                   // EVENT node height over face center
  // far left rail: GBRAIN feed, right edge = graph left edge - colGap
  leftTop: 0.28,
  brainClear: 0.24,                // gap between the GBRAIN rail and the graph's EVENT node (graph meters)
  dist: 1.6,                       // default; xr.js overrides from ?dist= (config.cardDistance)
  // lower center: GitHub PR panel, top edge this far under the face bottom (clears chip + barcode + filmstrip)
  ghBelow: 0.2,
  // top center toasts: above the person's head (person frame), one line; head-locked fallback when nobody is there
  toastAbove: 0.13,                // bottom edge this far over the face top (clears the reticle readouts)
  toast: [0, 0.27, -1.2],
  status: [0, -0.56, -1.2],       // under the GitHub panel's bottom edge when you look at the person
  perf: [-0.36, 0.34, -1.2],
};

// Per-frame person frame. xr.js calls this once per frame, before any layer places itself.
// hud.lx = { P, r, up, fwd, halfW, halfH, head, has }  (P = face center at dist, or body-locked ahead)
const _fwd = new THREE.Vector3();
export function xrFrame(hud, xr, head, headQ) {
  const L = (hud.lx ||= { P: new THREE.Vector3(), r: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), fwd: new THREE.Vector3(), halfW: XR.faceHalfMin, halfH: XR.faceHalfMin, head: new THREE.Vector3(), has: false, yaw: null });
  const dist = xr.config.cardDistance;
  XR.dist = dist;
  L.head.copy(head);
  // the person: first card's track, else any live track
  let b = null;
  for (const id of hud.cards.keys()) { b = hud.bboxFor(id); if (b) break; }
  if (!b) for (const id of hud.tracks.keys()) { b = hud.bboxFor(id); if (b) break; }
  const face = firstFace(hud);
  if (face) b = face;
  if (b) {
    const c = xr._rayPoint(head, headQ, b[0] + b[2] / 2, b[1] + b[3] / 2, dist);
    const hfov = THREE.MathUtils.degToRad(xr.config.hfov);
    const W = dist * 2 * Math.tan(hfov / 2);
    const [fw, fh] = hud.frameSize;
    const halfW = Math.max(XR.faceHalfMin, (b[2] * W) / 2), halfH = Math.max(XR.faceHalfMin, (b[3] * W * (fh / fw)) / 2);
    if (!L.has) L.P.copy(c); else L.P.lerp(c, 0.2);
    L.halfW += (halfW - L.halfW) * 0.2; L.halfH += (halfH - L.halfH) * 0.2;
    L.has = true;
  } else {
    // nobody: body-locked ahead, re-centered only when the head turns > 40 deg away
    _fwd.set(0, 0, -1).applyQuaternion(headQ);
    const yaw = Math.atan2(_fwd.x, -_fwd.z);
    const off = L.yaw == null ? Infinity : Math.abs(Math.atan2(Math.sin(yaw - L.yaw), Math.cos(yaw - L.yaw)));
    if (off > THREE.MathUtils.degToRad(40) || (!L.has && L.yaw == null)) {
      L.yaw = yaw;
      L.P.set(head.x + Math.sin(yaw) * dist, head.y - 0.02, head.z - Math.cos(yaw) * dist);
    }
    L.halfW = XR.faceHalfMin; L.halfH = XR.faceHalfMin;
    L.has = false;
  }
  // right = horizontal, perpendicular to head -> P
  L.fwd.copy(L.P).sub(head); L.fwd.y = 0;
  if (L.fwd.lengthSq() < 1e-6) L.fwd.set(0, 0, -1);
  L.fwd.normalize();
  L.r.set(-L.fwd.z, 0, L.fwd.x);
  return L;
}

function firstFace(hud) {
  const faces = hud.vfx?.faces;
  if (!faces) return null;
  for (const f of faces.values()) if (f.e && Array.isArray(f.e.bbox) && performance.now() - f.t < 1500) return f.e.bbox;
  return null;
}

// World point in the person frame: x right, y up (meters), out = Vector3 (reused).
export function xrAt(L, x, y, out = new THREE.Vector3()) {
  return out.copy(L.P).addScaledVector(L.r, x).addScaledVector(L.up, y);
}

// 3D swarm graph, left of the face. Returns the EVENT node in person-frame coords and the graph's
// footprint at the person's distance (the group sits `graphPull` closer, scaled so it subtends the same angle).
export function xrGraph(L, dist) {
  const eff = XR.graphScale * dist / Math.max(0.3, dist - XR.graphPull);
  const x = -(L.halfW + XR.colGap + XR.graphRight * eff);
  return { x, y: XR.graphTop, eff, left: x - XR.graphLeft * eff, right: x + XR.graphRight * eff };
}

// Right edge of the person card column (card mesh is placed by xr.js), in person-frame x.
export function xrCardRight(L, cardMesh) {
  if (!cardMesh) return L.halfW + 0.03 + 0.36;
  const w = cardMesh.geometry.parameters.width * (cardMesh.scale?.x || 1);
  const d = cardMesh.position.clone().sub(L.P).dot(L.r);
  return d + w / 2;
}

// ---------------------------------------------------------------- desktop (css px)

export const DESK = {
  pad: 16,               // screen edge
  gap: 12,               // between panels
  faceGap: 24,           // face -> card (clears the chip's barcode caption)
  modeScale: FULL ? 1 : 0.9,
  minScale: 0.62,
  cardW: 300, radarW: 184, railW: 320, brainW: 240, ghW: 340,
  graphW: 1.3, graphH: 0.62,         // graph extent in its local meters (incl. labels + GBrain op ghosts)
  graphL: 0.66,                      // of which left of the EVENT node
  graphMinPx: 380, graphMaxPx: 560,  // px per graph meter
  toastY: 18,
};

let uiCache = { t: -1e9, r: null };
function uiRect() {
  const t = performance.now();
  if (t - uiCache.t > 500) {
    const el = typeof document !== 'undefined' && document.getElementById('ui');
    uiCache = { t, r: el ? el.getBoundingClientRect() : null };
  }
  return uiCache.r;
}

// face: {x,y,w,h} on screen or null. Returns every zone; modules place into them.
export function deskZones(vw, vh, face, ghUp = false) {
  const D = DESK;
  const ui = uiRect();
  const leftTop = Math.max(D.pad, ui && ui.width < vw * 0.6 ? ui.bottom + D.gap : D.pad);
  const f = face || { x: vw * 0.5 - 70, y: vh * 0.24, w: 140, h: 150 };
  // k: side panels shrink until card column + right rail fit right of the face
  const room = vw - D.pad - (f.x + f.w + D.faceGap) - D.gap;
  const k = Math.max(D.minScale, Math.min(D.modeScale, room / (D.cardW + D.railW)));
  const railW = D.railW * k;
  const right = { x: vw - D.pad - railW, y: D.pad, w: railW, k };
  let cardX = f.x + f.w + D.faceGap;
  if (cardX + D.cardW * k > right.x - D.gap) cardX = right.x - D.gap - D.cardW * k; // squeezed: hug the rail
  const card = { x: cardX, y: Math.max(D.pad + 40, f.y), w: D.cardW * k, k };
  const brain = { x: D.pad, y: leftTop, w: D.brainW * k, k };
  const brainH = (30 + BRAIN_LINES * 31) * k; // reserved: the column doesn't jump as lines come and go
  const gh = { w: D.ghW * k, k, cx: f.x + f.w / 2, bottom: vh - D.pad };
  // graph: left of the face, under the GBRAIN rail when the screen is narrow
  const gx0 = D.pad, gx1 = f.x - D.faceGap;
  const narrow = gx1 - (brain.x + brain.w + D.gap) < D.graphW * D.graphMinPx * k;
  const swarm = narrow
    ? { x: gx0, y: brain.y + brainH + D.gap * 2, w: gx1 - gx0, h: 0 }
    : { x: brain.x + brain.w + D.gap * 2, y: Math.max(leftTop, f.y - 40), w: gx1 - (brain.x + brain.w + D.gap * 2), h: 0 };
  swarm.h = Math.max(120, vh - D.pad - swarm.y);
  // the GitHub panel (lower center) takes the bottom band under the face: the graph stops at its left edge
  if (ghUp) { const ghX = gh.cx - gh.w / 2 - D.gap; if (ghX < swarm.x + swarm.w) swarm.w = Math.max(160, ghX - swarm.x); }
  const toast = { cx: vw / 2, y: D.toastY, minX: ui && ui.width < vw * 0.6 && ui.top < 60 ? ui.right + D.gap : D.pad };
  return { k, face: f, card, right, brain, brainH, gh, swarm, toast, vw, vh };
}

// Graph frame for DesktopSwarm: origin (EVENT node), px per graph meter.
export function deskGraph(z) {
  const s = z.swarm, D = DESK;
  const scale = Math.max(260, Math.min(D.graphMaxPx * (FULL ? 1 : 0.92), s.w / D.graphW, s.h / D.graphH));
  // local x spans ~[-0.66, 0.64]: put the left extent at the zone's left edge; EVENT a touch under the zone top
  return { ox: s.x + D.graphL * scale, oy: s.y + 0.08 * scale, scale, label: Math.min(1, z.k + 0.05) };
}

// ---------------------------------------------------------------- toasts

// Collapse toasts that duplicate a panel's own animation. false = drop.
const PROC_RX = /(PROCEDURE|SKILL).*(LEARNED|RECALLED)|RECALLED.*(PROCEDURE|SKILL)|LEARNED FROM RUN/;
export function toastFilter(hud, msg) {
  const text = String(msg.text || '').toUpperCase();
  const t = performance.now();
  const seen = (hud._toastSeen ||= new Map());
  const k = `${text}|${msg.detail || ''}`;
  if (text === 'FACE LEARNED' && seen.has(k)) return false;               // once per person per session
  if (seen.has(k) && t - seen.get(k) < 8000) return false;                // exact repeat
  seen.set(k, t);
  // the Memorable card is animating this already (library / recording / card present = Memorable is live)
  const m = hud.mem;
  if (show('memorable') && PROC_RX.test(text) && m && (m.lib || m.rec || m.card)) return false;
  return true;
}
