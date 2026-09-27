// WebXR immersive-ar HUD (Quest Browser passthrough). three.js, transparent
// background, small canvas-texture panels. Cards are anchored by projecting the
// perception bbox (from the passthrough camera frame) into a ray from the head
// and placing the card at a fixed distance. Crude but good enough for one person
// in front of you; tune with ?hfov= and ?dist=.
import * as THREE from 'three';
import { drawMemoryToast, drawAgentActivity, drawStatus, anyRunning } from './panels.js';
import { drawPersonCardPlus as drawPersonCard, deltasAnimating, XrDev } from './devpanels.js';
import { XrVision, hideCard } from './visionfx.js';
import { XrSwarm } from './swarmviz.js';
import { XrBrain } from './brainpanel.js';
import { XrCaptions } from './captions.js';
import { XrMemory } from './memorypanel.js';
import { ANIM_HZ, due, safe, frameBegin, frameEnd, perfLine, drawPerf, drawOffline, offlineText } from './perf.js';
import { XR, xrFrame, xrAt, show } from './layout.js';
import { XrInput } from './xrinput.js';

const M_PER_PX = 0.0012; // panel css px -> meters (300px card ~ 0.36 m)

// One renderer (one WebGL context) for the page's lifetime. A new one per AR entry leaked a context each
// time; browsers cap live contexts (~16) and Quest Browser loses the oldest, so re-entering AR would die.
let sharedRenderer = null;
function getRenderer(config) {
  if (sharedRenderer) return sharedRenderer;
  const renderer = new THREE.WebGLRenderer({ antialias: !config.lite, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  if (config.lite) renderer.xr.setFramebufferScaleFactor(0.85); // fewer pixels per eye; must be set before setSession
  return (sharedRenderer = renderer);
}

// Free every GPU resource under obj (geometry, material, textures) and detach it.
export function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u.value && u.value.isTexture) u.value.dispose();
      m.dispose();
    }
  });
  obj.clear();
}

export class XrHud {
  constructor({ hud, config, onPinch, statusLine }) {
    this.hud = hud;
    this.config = config;
    this.onPinch = onPinch;
    this.statusLine = statusLine;
    this.headPose = [0, 0, 0, 0, 0, 0, 1];
    this.meshes = new Map(); // key -> { mesh, msg, canvas, target }
    this.session = null;
    this._v = new THREE.Vector3(); // scratch
  }

  static async supported() {
    return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)));
  }

  async start() {
    const renderer = getRenderer(this.config);
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 50);

    // Quest Browser: 'local' is always granted for immersive sessions; hand-tracking gives pinch as `select`
    // without controllers; dom-overlay is optional (not in Quest Browser today, harmless to ask).
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
    await renderer.xr.setSession(session);
    if (this.config.hz && session.updateTargetFrameRate && [...(session.supportedFrameRates || [])].includes(this.config.hz)) {
      session.updateTargetFrameRate(this.config.hz).catch(() => {});
    }
    this.refSpace = renderer.xr.getReferenceSpace();
    this.dev = new XrDev(this.scene, session, this.hud); // GitHub + Claude Code panels
    this.vfx = new XrVision(this.scene, this.hud); // perception overlay on the face (visionfx.js)
    this.swarm = new XrSwarm(this.scene, this); // spatial QM swarm graph
    this.brain = new XrBrain(this.scene, this.hud); // GBRAIN live feed
    this.captions = new XrCaptions(this.scene, this.hud); // live transcript strip
    this.mem = new XrMemory(this.scene, this.hud); // Memorable stack under the QM SWARM panel

    // Lasers, hover, click, move, resize (xrinput.js). Getters, not meshes: modules rebuild meshes when sizes change.
    safe('xr input init', () => {
      const I = (this.input = new XrInput(this));
      const cards = [];
      I.register('card', () => { cards.length = 0; for (const [k, m] of this.meshes) if (k.startsWith('card:')) cards.push([k, m.mesh]); return cards; }, { pass: true });
      I.register('gh', () => this.dev.meshes.gh?.mesh, { pass: true });
      I.register('ss', () => this.dev.meshes.ss?.mesh);
      I.register('memorable', () => this.mem.m?.mesh);
      I.register('brain', () => this.brain.m?.mesh);
      I.register('graph', () => (this.swarm.group.visible ? this.swarm.group : null), { proxy: [-0.6, -0.62, 0.66, 0.16] });
      I.register('preview', () => this.dev.pv?.mesh, { pass: true, grab: false });
    });

    // Hand pinch (and controller trigger) arrive as `select`. xrinput.js gets first say (grab / resize / panel);
    // a pinch on nothing, a card, a GitHub button or the preview runs the original path.
    session.addEventListener('select', (ev) => {
      let used = false;
      if (this.input) safe('xr input select', () => { used = this.input.consumeSelect(ev); });
      if (!used) this._onSelect(ev);
    });
    session.addEventListener('end', () => {
      renderer.setAnimationLoop(null);
      this.session = null;
      // free everything this session built (cards, face planes, swarm graph, dev panels); the renderer stays
      safe('xr dispose', () => { disposeTree(this.scene); this.meshes.clear(); renderer.renderLists.dispose(); });
      this.onEnd && this.onEnd();
    });

    this.raycaster = new THREE.Raycaster();
    renderer.setAnimationLoop((t, frame) => this._frame(t, frame));
  }

  end() { this.session && this.session.end(); }

  // What the session actually got, for ?diag=1.
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

  // Never let one bad frame (or one bad layer) end the loop: three.js stops scheduling frames if this throws.
  _frame(t, frame) {
    const t0 = frameBegin();
    safe('xr frame', () => this._frameInner(t, frame));
    safe('xr render', () => this.renderer.render(this.scene, this.camera));
    frameEnd(t0, this.renderer);
  }

  _frameInner(t, frame) {
    const pose = frame && frame.getViewerPose(this.refSpace);
    if (pose) {
      const p = pose.transform.position, o = pose.transform.orientation;
      this.headPose = [p.x, p.y, p.z, o.x, o.y, o.z, o.w];
    }
    // Head from the viewer pose directly (the three xr camera updates inside render()). Reused objects: no per-frame garbage.
    const hm = pose ? (this._hm ||= new THREE.Matrix4()).fromArray(pose.transform.matrix) : this.renderer.xr.getCamera().matrixWorld;
    const head = (this._head ||= new THREE.Vector3()).setFromMatrixPosition(hm);
    const headQ = (this._headQ ||= new THREE.Quaternion()).setFromRotationMatrix(hm);
    const seen = new Set();
    const hud = this.hud;
    let freeIdx = 0;
    // layout.js person frame (face center at ?dist=, right, up): every layer places itself relative to it
    safe('xr layout', () => xrFrame(hud, this, head, headQ));

    // 1. person cards
    for (const [id, msg] of hud.cards) {
      if (hideCard(hud, id, msg)) continue; // unknown background faces: no floating card (visionfx.js)
      const k = 'card:' + id;
      seen.add(k);
      const m = this._mesh(k, msg, drawPersonCard, deltasAnimating(msg));
      const b = hud.bboxFor(id);
      if (b) {
        // right of the person's head
        m.target = this._rayPoint(head, headQ, b[0] + b[2] + 0.02, b[1] + 0.12 * b[3], this.config.cardDistance);
        // the ray hits the face's right edge; shift by half the card so it sits beside the face, not over it
        m.target.add(this._v.set(m.mesh.geometry.parameters.width / 2, 0, 0).applyQuaternion(headQ));
      } else if (!m.placed) {
        m.target = this._local(head, headQ, 0.32, 0.05 - 0.22 * freeIdx++, -this.config.cardDistance);
      }
      m.mesh.userData.track = id;
    }

    // 3. agent activity, under the matching card
    for (const [id, msg] of hud.activity) {
      const k = 'act:' + id;
      seen.add(k);
      const m = this._mesh(k, msg, drawAgentActivity, anyRunning(msg));
      const card = this.meshes.get('card:' + id);
      if (card && card.target) {
        const ch = card.mesh.geometry.parameters.height, ah = m.mesh.geometry.parameters.height;
        m.target = (m.target && m.target !== card.target ? m.target.copy(card.target) : card.target.clone()).add(this._v.set(0, -(ch / 2 + ah / 2 + 0.02), 0));
      } else if (!m.placed) {
        m.target = this._local(head, headQ, 0.32, -0.12 - 0.22 * freeIdx++, -this.config.cardDistance);
      }
      m.mesh.userData.track = id;
    }

    // 2. memory toasts: top center over the person's head, one line at a time (layout.js)
    let y = XR.toast[1];
    for (const tst of hud.liveToasts().reverse()) {
      const k = 'toast:' + tst.t;
      seen.add(k);
      const m = this._mesh(k, tst, drawMemoryToast);
      const L = hud.lx;
      if (L && L.has) { m.headLocked = null; m.target = xrAt(L, 0, L.halfH + XR.toastAbove + m.mesh.geometry.parameters.height / 2, m.target || new THREE.Vector3()); }
      else (m.headLocked ||= new THREE.Vector3()).set(XR.toast[0], y, XR.toast[2]);
      m.mesh.material.opacity = tst.age < 0.08 ? tst.age / 0.08 : tst.age > 0.85 ? (1 - tst.age) / 0.15 : 1;
      y += m.mesh.geometry.parameters.height + 0.015;
    }

    // status strip (tiny, bottom) so cam/mic/ws can be checked inside the headset. Text refreshed at 2 Hz.
    const now = performance.now();
    if (due(this, 2, now, '_statusT')) this._statusLine = this.statusLine();
    seen.add('status');
    const sm = this._mesh('status', this._statusLine, drawStatus);
    (sm.headLocked ||= new THREE.Vector3()).set(...XR.status);
    sm.mesh.material.opacity = 0.7;

    // OFFLINE chip (world service unreachable), just above the status strip. Subtle, not an alarm.
    const off = offlineText(hud.net, now);
    if (off) {
      seen.add('offline');
      const om = this._mesh('offline', off, drawOffline);
      (om.headLocked ||= new THREE.Vector3()).set(XR.status[0], XR.status[1] + 0.035, XR.status[2]);
      om.mesh.material.opacity = 0.85;
    }

    // ?perf=1: fps / frame ms / draw calls / textures, head-locked top-left, 2 Hz
    if (this.config.perf) {
      if (due(this, 2, now, '_perfT')) this._perfLine = perfLine();
      seen.add('perf');
      const pm = this._mesh('perf', this._perfLine || '', drawPerf);
      (pm.headLocked ||= new THREE.Vector3()).set(...XR.perf);
      pm.mesh.material.opacity = 0.8;
    }

    // place + face the viewer
    for (const [k, m] of this.meshes) {
      if (!seen.has(k)) {
        this.scene.remove(m.mesh);
        m.mesh.geometry.dispose(); m.mesh.material.map.dispose(); m.mesh.material.dispose();
        this.meshes.delete(k);
        continue;
      }
      if (m.headLocked) {
        m.mesh.position.copy(m.headLocked).applyQuaternion(headQ).add(head);
        m.mesh.quaternion.copy(headQ);
      } else if (m.target) {
        if (!m.placed) { m.mesh.position.copy(m.target); m.placed = true; }
        else m.mesh.position.lerp(m.target, 0.15);
        m.mesh.lookAt(head); // Object3D.lookAt points +z at the target: plane front faces the viewer
      }
    }
    safe('xr dev', () => this.dev.frame(head, headQ, this.meshes, this.config.cardDistance));
    if (this.input) safe('xr input apply', () => this.input.apply(head)); // user-placed panels, before Memorable reads ss
    if (show('memorable')) safe('xr memory', () => this.mem.frame(head, headQ, this.dev)); else this.mem._drop();
    safe('xr vision', () => this.vfx.frame(this, head, headQ));
    if (show('swarm3d')) safe('xr swarm', () => this.swarm.frame(head, headQ));
    if (show('brain')) safe('xr brain', () => this.brain.frame(head, headQ, this.meshes, this.dev));
    safe('xr captions', () => this.captions.frame(head, headQ));
    if (this.input) safe('xr input', () => this.input.frame(frame, head));
  }

  // Normalized camera-frame coords -> world point at `dist` along the ray.
  // Assumes the passthrough camera is roughly aligned with the head's forward axis.
  _rayPoint(head, headQ, u, v, dist) {
    const hfov = THREE.MathUtils.degToRad(this.config.hfov);
    const [fw, fh] = this.hud.frameSize;
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) * (fh / fw));
    const x = Math.tan(hfov / 2) * (u * 2 - 1);
    const y = -Math.tan(vfov / 2) * (v * 2 - 1);
    const dir = new THREE.Vector3(x, y, -1).normalize().applyQuaternion(headQ);
    return head.clone().addScaledVector(dir, dist);
  }

  _local(head, headQ, x, y, z) {
    return new THREE.Vector3(x, y, z).applyQuaternion(headQ).add(head);
  }

  // animate: redraw even when msg is unchanged, capped at ANIM_HZ (each redraw is a texture upload).
  _mesh(k, msg, draw, animate = false) {
    let m = this.meshes.get(k);
    if (m && m.msg === msg && (!animate || !due(m, ANIM_HZ))) return m;
    if (m && animate) m._drawT = performance.now();
    const canvas = draw(msg);
    const w = (canvas.width / 2) * M_PER_PX, h = (canvas.height / 2) * M_PER_PX;
    if (m && Math.abs(m.mesh.geometry.parameters.width - w) < 1e-6 && Math.abs(m.mesh.geometry.parameters.height - h) < 1e-6) {
      m.mesh.material.map.image = canvas;
      m.mesh.material.map.needsUpdate = true;
      m.msg = msg;
      return m;
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.renderOrder = 10;
    if (m) {
      mesh.position.copy(m.mesh.position);
      this.scene.remove(m.mesh);
      m.mesh.geometry.dispose(); m.mesh.material.map.dispose(); m.mesh.material.dispose();
    }
    this.scene.add(mesh);
    const next = { ...(m || {}), mesh, msg };
    this.meshes.set(k, next);
    return next;
  }

  _onSelect(ev) {
    const pose = ev.frame.getPose(ev.inputSource.targetRaySpace, this.refSpace);
    if (!pose) return;
    const mtx = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(mtx);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(mtx);
    this.raycaster.set(origin, dir);
    if (this.dev.select(this.raycaster)) return;
    const targets = [...this.meshes.values()].filter((m) => m.mesh.userData.track != null).map((m) => m.mesh);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (hit) { this.onPinch(hit.object.userData.track); return; }
    // No panel hit: pick the tracked person closest to the ray direction.
    let best = null, bestAng = THREE.MathUtils.degToRad(15);
    for (const [id] of this.hud.tracks) {
      const b = this.hud.bboxFor(id);
      if (!b) continue;
      if (!this._head) break;
      const p = this._rayPoint(this._head, this._headQ, b[0] + b[2] / 2, b[1] + b[3] / 2, 2);
      const ang = dir.angleTo(p.sub(origin).normalize());
      if (ang < bestAng) { bestAng = ang; best = id; }
    }
    this.onPinch(best);
  }
}
