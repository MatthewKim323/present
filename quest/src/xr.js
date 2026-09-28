// Spatial adaptations of React Bits Target Cursor, Dock and Animated Content.
// These are native three.js planes: no DOM overlays inside immersive WebXR.
// Cards are anchored by projecting the perception bbox (from the passthrough camera frame) into a
// ray from the head and placing the label at a fixed distance; tune with ?hfov= and ?dist=.
import * as THREE from "three";
import { FluidGlassPass } from "./fluid-glass-pass.js";
import { XrPointers } from "./xr-pointers.js";
import { XrVision, hideCard } from "./visionfx.js";
import { XrSwarm } from './swarmviz.js';
import { XrBrain } from './brainpanel.js';
import { XrCaptions } from './captions.js';
import { XrMemory } from './memorypanel.js';
import { due, safe, frameBegin, frameEnd, perfLine, drawPerf, drawOffline, offlineText } from './perf.js';
import { XrDev, deltasAnimating } from "./devpanels.js";
import { drawActionPerson as drawPersonCardPlus } from './person-actions.js';
import {
  drawPersonLabel,
  drawMemoryToast,
  drawAgentActivity,
  drawStatus,
  drawDock,
  drawMemoryList,
  drawToolPanel,
} from "./panels.js";
import { XR, xrFrame, xrAt, show } from './layout.js';
import { XrInput } from './xrinput.js';

const M_PER_PX = 0.0012;
const VIEWS = ["person", "memories", "agents"];
const EMPTY_ACTIVITY = { workers: [] };
const DOCK_Y = -0.23;
let sharedRenderer = null;

function getRenderer(config) {
  if (sharedRenderer) return sharedRenderer;
  const renderer = new THREE.WebGLRenderer({ antialias: !config.lite, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  if (config.lite) renderer.xr.setFramebufferScaleFactor(0.85);
  return (sharedRenderer = renderer);
}

export class XrHud {
  constructor({
    hud,
    config,
    onPinch,
    statusLine,
    onPanelAction = () => {},
    onPanelDismiss = () => {},
  }) {
    Object.assign(this, {
      hud,
      config,
      onPinch,
      statusLine,
      onPanelAction,
      onPanelDismiss,
    });
    this.headPose = [0, 0, 0, 0, 0, 0, 1];
    this.meshes = new Map();
    this.session = null;
    this.reducedMotion =
      globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
      false;
    this._head = new THREE.Vector3();
    this._headQ = new THREE.Quaternion();
    this._matrix = new THREE.Matrix4();
    this._origin = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    // Hand pinch (and controller trigger) arrive as `select`. xrinput.js gets first say (grab / resize /
    // panel); a pinch on nothing, a label, the dock, a tool panel, a GitHub button or the preview runs _onSelect.
    this._select = (ev) => {
      let used = false;
      if (this.input) safe('xr input select', () => { used = this.input.consumeSelect(ev); });
      if (!used) this._onSelect(ev);
    };
    this._end = () => {
      try {
        this._devEnd?.();
      } finally {
        this._dispose();
        this.onEnd?.();
      }
    };
  }

  static async supported() {
    return !!(
      navigator.xr &&
      (await navigator.xr.isSessionSupported("immersive-ar").catch(() => false))
    );
  }

  async start() {
    try {
      const renderer = getRenderer(this.config);
      this.renderer = renderer;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(
        70,
        innerWidth / innerHeight,
        0.05,
        50,
      );
      // Quest Browser: 'local' is always granted for immersive sessions; hand-tracking gives pinch as `select`
      // without controllers; dom-overlay is optional. Its root is the empty #xr-dom (index.html), never the
      // page body: the React shell and the #cam video must not be composited over passthrough.
      const init = { requiredFeatures: ['local'], optionalFeatures: ['local-floor', 'hand-tracking', 'dom-overlay'] };
      let domRoot = document.getElementById('xr-dom');
      if (!domRoot) { domRoot = document.createElement('div'); domRoot.id = 'xr-dom'; document.body.appendChild(domRoot); }
      init.domOverlay = { root: domRoot };
      let session;
      try {
        session = await navigator.xr.requestSession('immersive-ar', init);
      } catch (e) {
        // Some Quest Browser builds reject the optional features (dom-overlay/hand-tracking): retry bare.
        console.warn('immersive-ar with optional features failed, retrying bare:', e);
        session = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['local-floor', 'hand-tracking'] })
          .catch(() => navigator.xr.requestSession('immersive-ar'))
          .catch(async (e2) => {
            // AR refused outright: fall back to immersive-vr with the headset camera feed as the backdrop,
            // so the HUD still sits over the real world (flat, not stereo passthrough).
            console.warn('immersive-ar refused, falling back to immersive-vr + camera backdrop:', e2);
            const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
            const cam = document.getElementById('cam');
            if (cam && cam.srcObject) {
              const tex = new THREE.VideoTexture(cam);
              tex.colorSpace = THREE.SRGBColorSpace;
              this.scene.background = tex;
            }
            this.vrFallback = true;
            return s;
          });
      }
      this.session = session;
      session.addEventListener("end", this._end);
      await renderer.xr.setSession(session);
      if (this.config.hz && session.updateTargetFrameRate && [...(session.supportedFrameRates || [])].includes(this.config.hz))
        session.updateTargetFrameRate(this.config.hz).catch(() => {});
      const fluidGlass = await FluidGlassPass.create(renderer, this.scene, {
        nativePassthrough: true,
      });
      if (this.session !== session || this.renderer !== renderer) {
        fluidGlass.dispose();
        throw new Error("AR session ended while loading glass");
      }
      this.fluidGlass = fluidGlass;
      this.refSpace = renderer.xr.getReferenceSpace();
      this._initDev();
      this.vfx = new XrVision(this.scene, this.hud);
      this.swarm = new XrSwarm(this.scene, this);
      this.brain = new XrBrain(this.scene, this.hud);
      this.captions = new XrCaptions(this.scene, this.hud); // live transcript strip
      this.mem = new XrMemory(this.scene, this.hud);
      this._initInput();
      session.addEventListener("select", this._select);
      this._createCursor();
      renderer.setAnimationLoop((t, frame) => this._frame(t, frame));
    } catch (error) {
      const session = this.session;
      this._dispose();
      if (session) await session.end().catch(() => {});
      throw error;
    }
  }

  async end() {
    if (this.session) await this.session.end();
  }

  info() {
    const s = this.session;
    if (!s) return this._info || null;
    return (this._info = {
      features: [...(s.enabledFeatures || ['(enabledFeatures n/a)'])],
      frameRate: s.frameRate != null ? Math.round(s.frameRate) : null,
      rates: [...(s.supportedFrameRates || [])],
      blend: s.environmentBlendMode || '?',
      fbScale: this.config.lite ? 0.85 : 1,
    });
  }

  _initDev() {
    // XrDev owns a session-end preview hook. Keep it under our single end
    // listener so failure cleanup can release it without opening a preview.
    this.dev = new XrDev(
      this.scene,
      {
        addEventListener: (type, listener) => {
          if (type === "end") this._devEnd = listener;
          else {
            this.session.addEventListener(type, listener);
            (this._devListeners ||= []).push([type, listener]);
          }
        },
      },
      this.hud,
    );
  }

  // Hover outline, pinch-hold move, corner / two-hand resize (xrinput.js). Getters, not meshes: every module
  // rebuilds its mesh when sizes change. `pass` panels keep their click in _onSelect (labels, dock, tool
  // panels, GitHub buttons, preview). XrPointers owns the beams (see _frameInner).
  _initInput() {
    safe('xr input init', () => {
      const I = (this.input = new XrInput(this));
      const list = (prefix) => { const out = []; for (const [k, m] of this.meshes) if (k.startsWith(prefix)) out.push([k, m.mesh]); return out; };
      I.register('label', () => list('label:'), { pass: true, grab: false });
      I.register('detail', () => list('detail:'), { pass: true, grab: false });
      I.register('tool', () => list('tool:'), { pass: true, grab: false });
      I.register('dock', () => this.meshes.get('dock')?.mesh, { pass: true, grab: false });
      I.register('gh', () => this.dev?.meshes.gh?.mesh, { pass: true });
      I.register('ss', () => this.dev?.meshes.ss?.mesh);
      I.register('links', () => this.dev?.meshes.links?.mesh, { pass: true });
      I.register('memorable', () => this.mem?.m?.mesh);
      I.register('brain', () => this.brain?.m?.mesh);
      I.register('graph', () => (this.swarm?.group.visible ? this.swarm.group : null), { proxy: [-0.6, -0.62, 0.66, 0.16] });
      I.register('preview', () => this.dev?.pv?.mesh, { pass: true, grab: false });
    });
  }

  _dispose() {
    for (const [type, listener] of this._devListeners || [])
      this.session?.removeEventListener(type, listener);
    this._devListeners = [];
    this.dev?._dropPreview();
    if (this.dev)
      for (const name of Object.keys(this.dev.meshes)) this.dev._drop(name);
    this.dev = null;
    if (this.vfx)
      for (const key of [...this.vfx.meshes.keys()]) this.vfx._drop(key);
    this.vfx = null;
    this._devEnd = null;
    this.hud.xrActive = false;
    this.pointers?.dispose();
    this.pointers = null;
    this.input = null; // its lasers / outlines live in the scene, cleared below
    this.captions = null;
    this.renderer?.setAnimationLoop(null);
    this.session?.removeEventListener("select", this._select);
    this.session?.removeEventListener("end", this._end);
    for (const m of this.meshes.values()) this._remove(m);
    this.meshes.clear();
    this.fluidGlass?.dispose();
    this.fluidGlass = null;
    if (this.cursor) {
      this.scene.remove(this.cursor);
      this.cursor.geometry.dispose();
      this.cursor.material.dispose();
      this.cursor = null;
    }
    // The renderer and WebGL context are shared across AR entries. The session
    // scene is disposable; preserving the renderer avoids Quest's context cap.
    if (this.scene) {
      this.scene.traverse(object => {
        object.geometry?.dispose();
        const mats = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
        for (const mat of mats) {
          for (const value of Object.values(mat)) if (value?.isTexture) value.dispose();
          mat.dispose();
        }
      });
      this.scene.background?.dispose?.(); // immersive-vr fallback camera backdrop
      this.scene.background = null;
      this.scene.clear();
    }
    this.renderer?.renderLists?.dispose();
    this.renderer = null;
    this.session = null;
    this.refSpace = null;
    this.focused = null;
  }

  _frame(t, frame) {
    const t0 = frameBegin();
    safe('xr frame', () => this._frameInner(t, frame));
    if (this.renderer && this.scene && this.camera) safe('xr render', () => this.renderer.render(this.scene, this.camera));
    frameEnd(t0, this.renderer);
  }

  _frameInner(t, frame) {
    if (!frame || !this.session) return;
    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) {
      this.pointers?.dispose();
      if (this.cursor) this.cursor.visible = false;
      return;
    }
    const p = pose.transform.position,
      o = pose.transform.orientation;
    this.headPose = [p.x, p.y, p.z, o.x, o.y, o.z, o.w];
    this._head.set(p.x, p.y, p.z);
    this._headQ.set(o.x, o.y, o.z, o.w);
    const head = this._head,
      headQ = this._headQ;
    const hud = this.hud,
      seen = new Set();
    const selected = hud.selectedTrack;
    let freeIdx = 0;
    // layout.js person frame (face center at ?dist=, right, up): every layer places itself relative to it
    safe('xr layout', () => xrFrame(hud, this, head, headQ));

    for (const [id, msg] of hud.cards) {
      if (hideCard(hud, id, msg)) continue; // unknown background faces: no floating label (visionfx.js)
      const key = "label:" + id;
      seen.add(key);
      const selectedLabel = selected === String(id);
      const focused = this.focused === key;
      const m = this._mesh(
        key,
        msg,
        (data) => drawPersonLabel(data, { selected: selectedLabel, focused }),
        `${selectedLabel}:${focused}`,
      );
      const b = hud.bboxFor(id);
      if (b) {
        m.target = this._rayPoint(
          head,
          headQ,
          b[0] + b[2] + 0.025,
          b[1] + 0.16 * b[3],
          this.config.cardDistance,
        );
        // The ray reaches the face edge; offset half a label so it sits beside the face.
        m.target.add(new THREE.Vector3(m.mesh.geometry.parameters.width / 2, 0, 0).applyQuaternion(headQ));
      } else {
        if (!m.placed)
          m.target = this._local(
            head,
            headQ,
            0.24,
            0.1 - 0.12 * freeIdx,
            -this.config.cardDistance,
          );
        freeIdx++;
      }
      m.mesh.userData = { track: id, action: "select", key };
    }

    const toolPanels = (hud.surfacePanels?.() || []).slice(0, 3);
    this._toolPanels(toolPanels, seen);
    // Custom tools own the center of view; legacy content yields to them.
    let detail = null;
    if (!toolPanels.length && hud.view === "memories") {
      detail = this._mesh(
        "detail:memories",
        hud.memoryHistory,
        drawMemoryList,
        hud.version,
      );
    } else if (!toolPanels.length && hud.view === "agents") {
      const activity =
        hud.activity.get(selected) ||
        hud.activity.get("free") ||
        [...hud.activity.values()][0] ||
        EMPTY_ACTIVITY;
      detail = this._mesh("detail:agents", activity, drawAgentActivity);
    } else if (
      !toolPanels.length &&
      selected != null &&
      hud.cards.has(selected)
    ) {
      detail = this._mesh(
        "detail:person",
        hud.cards.get(selected),
        (card) => drawPersonCardPlus(card, this.reducedMotion ? t + 1000 : t),
        !this.reducedMotion && deltasAnimating(hud.cards.get(selected), t)
          ? Math.floor(t / 50)
          : "settled",
      );
    }
    if (detail) {
      seen.add(detail.key);
      // Keep the bottom edge above the dock even when the content grows.
      const bottom = DOCK_Y + (64 * M_PER_PX) / 2 + 0.035;
      const centerY = Math.max(
        0.025,
        bottom + detail.mesh.geometry.parameters.height / 2,
      );
      detail.headLocked = this._offsetFor(
        detail,
        0,
        centerY,
        -this.config.cardDistance,
      );
      detail.mesh.userData = {
        key: detail.key,
        action: "detail",
        track: selected,
      };
    }

    if (hud.dockVisible !== false) {
      seen.add("dock");
      const dock = this._mesh("dock", hud.view, drawDock);
      dock.headLocked = this._offsetFor(
        dock,
        0,
        DOCK_Y,
        -this.config.cardDistance,
      );
      dock.mesh.userData = { key: "dock", action: "dock" };
    }

    // One confirmation at a time; expanded detail owns the center of view.
    // Expire hidden toasts too, while retaining them in memory history.
    // Placement (layout.js): above the person's head when someone is in front of you, else head-locked top center.
    const liveToasts = hud.liveToasts();
    const L = hud.lx;
    for (const toast of detail || toolPanels.length
      ? []
      : liveToasts.slice(-1)) {
      const key = "toast:" + toast.t;
      seen.add(key);
      const m = this._mesh(key, toast, drawMemoryToast);
      if (L && L.has) {
        m.headLocked = null;
        m.target = xrAt(L, 0, L.halfH + XR.toastAbove + m.mesh.geometry.parameters.height / 2, m.target || new THREE.Vector3());
      } else {
        m.target = null;
        m.headLocked = this._offsetFor(m, ...XR.toast);
      }
      m.alpha = toast.age > 0.85 ? Math.max(0, (1 - toast.age) / 0.15) : 1;
    }
    const now = performance.now();
    // status strip: under the GitHub panel's bottom edge when you look at the person (layout.js), refreshed at 2 Hz
    if (due(this, 2, now, '_statusT')) this._statusLine = `glass: native passthrough · ${this.statusLine()}`;
    seen.add("status");
    const status = this._mesh("status", this._statusLine, drawStatus);
    status.headLocked = this._offsetFor(status, ...XR.status);
    status.alpha = 0.7;
    // OFFLINE chip (world service unreachable), just above the status strip. Subtle, not an alarm.
    const offline = offlineText(hud.net, now);
    if (offline) {
      seen.add('offline');
      const chip = this._mesh('offline', offline, drawOffline);
      chip.headLocked = this._offsetFor(chip, XR.status[0], XR.status[1] + 0.035, XR.status[2]);
      chip.alpha = 0.85;
    }
    if (this.config.perf) {
      if (due(this, 2, now, '_perfT')) this._perfLine = perfLine();
      seen.add('perf');
      const chip = this._mesh('perf', this._perfLine || '', drawPerf);
      chip.headLocked = this._offsetFor(chip, ...XR.perf);
      chip.alpha = 0.8;
    }

    for (const [key, m] of this.meshes) {
      if (!seen.has(key)) {
        this._remove(m);
        this.meshes.delete(key);
        continue;
      }
      const progress = this.reducedMotion
        ? 1
        : Math.max(0, Math.min(1, (t - m.born) / 220));
      const ease = 1 - (1 - progress) ** 3;
      if (m.headLocked) {
        m.mesh.position.copy(m.headLocked).applyQuaternion(headQ).add(head);
        m.mesh.quaternion.copy(headQ);
      } else if (m.target) {
        if (!m.placed) {
          m.mesh.position.copy(m.target);
          m.placed = true;
        } else m.mesh.position.lerp(m.target, 0.15);
        m.mesh.lookAt(head);
      }
      m.mesh.scale.setScalar(0.96 + 0.04 * ease);
      m.mesh.material.opacity = (m.alpha ?? 1) * ease;
      m.mesh.updateMatrixWorld();
    }
    if (this.dev) {
      const anchor =
        this.meshes.get("detail:person") ||
        this.meshes.get("label:" + selected) ||
        [...this.meshes.values()].find((m) => m.key.startsWith("label:"));
      // Upstream XrDev expects card:* keys and a target; adapt our collapsed
      // labels and expanded detail without changing either renderer's state.
      const cards = anchor
        ? new Map([
            ["card:anchor", { ...anchor, target: anchor.mesh.position }],
          ])
        : new Map();
      safe('xr dev', () => this.dev.frame(head, headQ, cards, this.config.cardDistance));
      for (const m of Object.values(this.dev.meshes))
        m.mesh.updateMatrixWorld();
      this.dev.pv?.mesh.updateMatrixWorld();
    }
    if (this.input) safe('xr input apply', () => this.input.apply(head)); // user-placed panels, before Memorable reads ss
    if (show('memorable')) safe('xr memory', () => this.mem?.frame(head, headQ, this.dev)); else this.mem?._drop();
    safe('xr vision', () => this.vfx?.frame(this, head, headQ));
    if (show('swarm3d')) safe('xr swarm', () => this.swarm?.frame(head, headQ));
    const brainAnchor = this.meshes.get('detail:person') || this.meshes.get('label:' + selected) || [...this.meshes.values()].find(m => m.key.startsWith('label:'));
    const brainCards = brainAnchor ? new Map([['card:anchor', { ...brainAnchor, target: brainAnchor.mesh.position }]]) : new Map();
    if (show('brain')) safe('xr brain', () => this.brain?.frame(head, headQ, brainCards, this.dev));
    safe('xr captions', () => this.captions?.frame(head, headQ));
    safe('xr pointer', () => this._hover(frame, t));
    if (this.input) safe('xr input', () => {
      this.input.frame(frame, head);
      // XrPointers draws the beams (one solid beam per hand / controller); xrinput keeps the hover outline,
      // pinch-hold move and resize. Two lasers per hand would read as a bug.
      for (const src of this.input.srcs.values()) src.laser.visible = src.reticle.visible = false;
    });
    // Let Quest composite the real room through transparent pixels. A second
    // camera image cannot share the compositor's depth correction and pose.
    this.fluidGlass?.render(null, this.camera);
  }

  _toolPanels(panels, seen) {
    const slots = [-0.4, 0, 0.4];
    const used = new Set(),
      placed = [];
    const inverseHead = this._headQ.clone().invert();
    for (const panel of panels) {
      let slot = { left: 0, center: 1, right: 2 }[panel.position] ?? 1;
      if (used.has(slot)) slot = [0, 1, 2].find((index) => !used.has(index));
      used.add(slot);
      const key = "tool:" + panel.id;
      seen.add(key);
      const m = this._mesh(
        key,
        panel,
        drawToolPanel,
        `${panel.pendingAction?.requestId || ""}:${panel.result?.status || ""}`,
      );
      m.mesh.userData = { key, action: "tool", panelId: panel.id };
      const bbox =
        panel.anchor_track_id == null
          ? null
          : this.hud.bboxFor(panel.anchor_track_id);
      if (bbox) {
        m.headLocked = null;
        m.target = this._rayPoint(
          this._head,
          this._headQ,
          bbox[0] + bbox[2] / 2,
          bbox[1] + bbox[3] * 0.15,
          1.1,
        );
        m.target.add(
          this._offset.set(slots[slot], 0.05, 0).applyQuaternion(this._headQ),
        );
        const localY = m.target
          .clone()
          .sub(this._head)
          .applyQuaternion(inverseHead).y;
        if (localY < 0.05)
          m.target.add(
            this._offset.set(0, 0.05 - localY, 0).applyQuaternion(this._headQ),
          );
      } else {
        m.headLocked = this._offsetFor(m, slots[slot], 0.05, -1.1);
      }
      placed.push({
        m,
        slot,
        center:
          m.headLocked ||
          m.target.clone().sub(this._head).applyQuaternion(inverseHead),
      });
    }
    // Different tracked anchors can converge despite distinct requested slots.
    // Fall back to the stable row when projected panel bounds would overlap.
    const collision = placed.some((item, i) =>
      placed
        .slice(i + 1)
        .some(
          (other) =>
            Math.abs(item.center.x - other.center.x) < 0.394 &&
            Math.abs(item.center.y - other.center.y) < 0.3,
        ),
    );
    if (collision)
      for (const { m, slot } of placed)
        m.headLocked = this._offsetFor(m, slots[slot], 0.05, -1.1);
  }

  _toolTarget(hit) {
    const dev = hit.object.userData.dev;
    const local = hit.object.userData.action === 'detail';
    if (!dev && !local && hit.object.userData.action !== "tool") return null;
    const canvas = hit.object.material.map.image;
    const x = hit.uv.x * (hit.object.userData.logicalWidth || canvas.width / 2),
      y = (1 - hit.uv.y) * (hit.object.userData.logicalHeight || canvas.height / 2);
    const contains = (rect) =>
      rect &&
      x >= rect.x &&
      x <= rect.x + rect.w &&
      y >= rect.y &&
      y <= rect.y + rect.h;
    if (local) return (canvas.localActions || []).find(contains) || null;
    if (dev) return (canvas.hits || []).find(contains) || null;
    if (contains(canvas.panelDismiss))
      return { ...canvas.panelDismiss, dismiss: true };
    // Consult current state too: a second pinch can arrive before the next frame
    // replaces the canvas hit regions after an action becomes pending.
    const panelId = hit.object.userData.panelId;
    const panel = this.hud.panels.get(panelId) ||
      (panelId?.startsWith('live:') ? this.hud.surfacePanels().find(item => item.id === panelId) : null);
    if (
      !panel ||
      (panel.expiresAt != null && panel.expiresAt <= performance.now()) ||
      panel.pendingAction ||
      panel.result?.status === "received"
    )
      return null;
    return (canvas.panelActions || []).find(contains) || null;
  }

  _offsetFor(m, x, y, z) {
    return (m.headLocked || new THREE.Vector3()).set(x, y, z);
  }

  _rayPoint(head, headQ, u, v, dist) {
    const hfov = THREE.MathUtils.degToRad(this.config.hfov);
    const [fw, fh] = this.hud.frameSize;
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (fh / fw));
    return new THREE.Vector3(
      Math.tan(hfov / 2) * (u * 2 - 1),
      -Math.tan(vfov / 2) * (v * 2 - 1),
      -1,
    )
      .normalize()
      .applyQuaternion(headQ)
      .multiplyScalar(dist)
      .add(head);
  }

  _local(head, headQ, x, y, z) {
    return new THREE.Vector3(x, y, z).applyQuaternion(headQ).add(head);
  }

  _mesh(key, msg, draw, variant = "") {
    let m = this.meshes.get(key);
    if (m && m.msg === msg && m.variant === variant) return m;
    const canvas = draw(msg);
    const w = (canvas.width / 2) * M_PER_PX,
      h = (canvas.height / 2) * M_PER_PX;
    if (m) {
      m.mesh.material.map.image = canvas;
      m.mesh.material.map.needsUpdate = true;
      if (
        m.mesh.geometry.parameters.width !== w ||
        m.mesh.geometry.parameters.height !== h
      ) {
        m.mesh.geometry.dispose();
        m.mesh.geometry = new THREE.PlaneGeometry(w, h);
        if (m.fluid) this.fluidGlass.resizePanel(m.fluid, w, h);
      }
      Object.assign(m, { msg, variant });
      return m;
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.renderOrder = key.startsWith("toast:") ? 20 : 10;
    this.scene.add(mesh);
    m = { key, mesh, msg, variant, born: performance.now() };
    if (key !== "status" && this.fluidGlass) {
      m.fluid = this.fluidGlass.createPanel(w, h);
      m.fluid.position.z = -0.012;
      m.fluid.renderOrder = mesh.renderOrder - 1;
      mesh.add(m.fluid);
    }
    this.meshes.set(key, m);
    return m;
  }

  _remove(m) {
    if (m.fluid) {
      m.fluid.geometry.dispose();
      m.fluid.material.dispose();
    }
    this.scene.remove(m.mesh);
    m.mesh.geometry.dispose();
    m.mesh.material.map.dispose();
    m.mesh.material.dispose();
  }

  _setRay(frame, source) {
    const pose = frame.getPose(source.targetRaySpace, this.refSpace);
    if (!pose) return false;
    this._matrix.fromArray(pose.transform.matrix);
    this._origin.setFromMatrixPosition(this._matrix);
    this._direction.set(0, 0, -1).transformDirection(this._matrix);
    this.raycaster.set(this._origin, this._direction);
    return true;
  }

  _hit() {
    const targets = [...this.meshes.values()]
      .filter((m) => m.mesh.userData.action)
      .map((m) => m.mesh);
    for (const m of Object.values(this.dev?.meshes || {})) targets.push(m.mesh);
    if (this.dev?.pv) targets.push(this.dev.pv.mesh);
    return this.raycaster.intersectObjects(targets, false)[0];
  }

  _createCursor() {
    // Four restrained corner brackets, scaled to the actual target plane.
    const points = [];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        points.push(sx * 0.5, sy * 0.34, 0, sx * 0.5, sy * 0.5, 0);
        points.push(sx * 0.5, sy * 0.5, 0, sx * 0.38, sy * 0.5, 0);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(points, 3),
    );
    this.cursor = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.cursor.renderOrder = 30;
    this.cursor.visible = false;
    this.scene.add(this.cursor);
  }

  _hover(frame, time = performance.now()) {
    let hit = null;
    this.pointers ||= new XrPointers(this.scene);
    this.pointers.begin();
    // Pointer feedback follows targetRaySpace (controller or hand), never gaze.
    for (const source of this.session.inputSources) {
      if (
        source.targetRayMode !== "tracked-pointer" ||
        !this._setRay(frame, source)
      )
        continue;
      const candidate = this._hit();
      const actionable =
        candidate &&
        ((candidate.object.userData.action !== "tool" &&
          !candidate.object.userData.dev) ||
          this._toolTarget(candidate));
      this.pointers.update(
        source,
        this._origin,
        this._direction,
        candidate,
        this._headQ,
        !!actionable,
      );
      if (candidate && (!hit || candidate.distance < hit.distance))
        hit = candidate;
    }
    this.pointers.end();
    this.focused = hit?.object.userData.key || null;
    this.cursor.visible = !!hit;
    if (!hit) return;
    const mesh = hit.object;
    const toolTarget = this._toolTarget(hit);
    if (mesh.userData.action === "tool" || mesh.userData.dev) {
      this.cursor.visible = !!toolTarget;
      if (!toolTarget) return;
      const canvas = mesh.material.map.image;
      const width = mesh.userData.logicalWidth || canvas.width / 2,
        height = mesh.userData.logicalHeight || canvas.height / 2;
      const scale = (mesh.geometry.parameters.width / width) * mesh.scale.x;
      this._offset
        .set(
          (toolTarget.x + toolTarget.w / 2 - width / 2) * scale,
          (height / 2 - toolTarget.y - toolTarget.h / 2) * scale,
          0.003,
        )
        .applyQuaternion(mesh.quaternion);
      this.cursor.position.copy(mesh.position).add(this._offset);
      this.cursor.quaternion.copy(mesh.quaternion);
      this.cursor.scale.set(
        toolTarget.w * scale + 0.005,
        toolTarget.h * scale + 0.005,
        1,
      );
      return;
    }
    const isDock = mesh.userData.action === "dock";
    const segment = isDock ? Math.min(2, Math.floor(hit.uv.x * 3)) : 0;
    const width = mesh.geometry.parameters.width * mesh.scale.x;
    const height = mesh.geometry.parameters.height * mesh.scale.y;
    this.cursor.position.copy(mesh.position);
    this._offset
      .set(isDock ? ((segment - 1) * width) / 3 : 0, 0, 0.003)
      .applyQuaternion(mesh.quaternion);
    this.cursor.position.add(this._offset);
    this.cursor.quaternion.copy(mesh.quaternion);
    this.cursor.scale.set(
      (isDock ? width / 3 : width) + 0.008,
      height + 0.008,
      1,
    );
  }

  _onSelect(ev) {
    if (!this.refSpace || !this._setRay(ev.frame, ev.inputSource)) return;
    const hit = this._hit();
    if (hit) {
      if (hit.object.userData.dev) {
        this.dev.select(this.raycaster, ev.inputSource);
        return;
      }
      const { action, track } = hit.object.userData;
      if (action === "tool") {
        const target = this._toolTarget(hit);
        if (target?.dismiss) this.onPanelDismiss(hit.object.userData.panelId);
        else if (target?.id)
          this.onPanelAction(hit.object.userData.panelId, target.id);
      } else if (action === 'detail') {
        const target = this._toolTarget(hit);
        if (target?.action) this.hud.onPersonAction?.(track, target.action);
      } else if (action === "dock") {
        this.hud.setView(VIEWS[Math.min(2, Math.floor(hit.uv.x * 3))]);
      } else if (action === "select") {
        this.hud.select(track);
        this.hud.setView("person");
        this.onPinch(track);
      } else if (track != null) this.onPinch(track);
      return;
    }
    let best = null,
      bestAngle = THREE.MathUtils.degToRad(15);
    for (const [id] of this.hud.tracks) {
      const b = this.hud.bboxFor(id);
      if (!b) continue;
      const point = this._rayPoint(
        this._head,
        this._headQ,
        b[0] + b[2] / 2,
        b[1] + b[3] / 2,
        2,
      );
      const angle = this._direction.angleTo(
        point.sub(this._origin).normalize(),
      );
      if (angle < bestAngle) {
        bestAngle = angle;
        best = id;
      }
    }
    if (best != null) {
      this.hud.select(best);
      this.hud.setView("person");
    }
    this.onPinch(best);
  }
}
