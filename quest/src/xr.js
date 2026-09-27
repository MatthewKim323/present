// WebXR immersive-ar HUD (Quest Browser passthrough). three.js, transparent
// background, small canvas-texture panels. Cards are anchored by projecting the
// perception bbox (from the passthrough camera frame) into a ray from the head
// and placing the card at a fixed distance. Crude but good enough for one person
// in front of you; tune with ?hfov= and ?dist=.
import * as THREE from 'three';
import { drawMemoryToast, drawAgentActivity, drawStatus, anyRunning } from './panels.js';
import { drawPersonCardPlus as drawPersonCard, deltasAnimating, XrDev } from './devpanels.js';
import { XrVision } from './visionfx.js';
import { XrSwarm } from './swarmviz.js';
import { XrMemory } from './memorypanel.js';

const M_PER_PX = 0.0012; // panel css px -> meters (300px card ~ 0.36 m)

export class XrHud {
  constructor({ hud, config, onPinch, statusLine }) {
    this.hud = hud;
    this.config = config;
    this.onPinch = onPinch;
    this.statusLine = statusLine;
    this.headPose = [0, 0, 0, 0, 0, 0, 1];
    this.meshes = new Map(); // key -> { mesh, msg, canvas, target }
    this.session = null;
  }

  static async supported() {
    return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar').catch(() => false)));
  }

  async start() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(devicePixelRatio);
    renderer.setSize(innerWidth, innerHeight);
    renderer.setClearColor(0x000000, 0);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local');
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 50);

    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local'],
      optionalFeatures: ['hand-tracking', 'local-floor'],
    });
    this.session = session;
    await renderer.xr.setSession(session);
    this.refSpace = renderer.xr.getReferenceSpace();
    this.dev = new XrDev(this.scene, session, this.hud); // GitHub + Claude Code panels
    this.vfx = new XrVision(this.scene, this.hud); // perception overlay on the face (visionfx.js)
    this.swarm = new XrSwarm(this.scene, this); // spatial QM swarm graph
    this.mem = new XrMemory(this.scene, this.hud); // Memorable stack under the QM SWARM panel

    // Hand pinch (and controller trigger) arrive as `select`.
    session.addEventListener('select', (ev) => this._onSelect(ev));
    session.addEventListener('end', () => { renderer.setAnimationLoop(null); this.session = null; this.onEnd && this.onEnd(); });

    this.raycaster = new THREE.Raycaster();
    renderer.setAnimationLoop((t, frame) => this._frame(t, frame));
  }

  end() { this.session && this.session.end(); }

  _frame(t, frame) {
    const pose = frame && frame.getViewerPose(this.refSpace);
    if (pose) {
      const p = pose.transform.position, o = pose.transform.orientation;
      this.headPose = [p.x, p.y, p.z, o.x, o.y, o.z, o.w];
    }
    // Head from the viewer pose directly (the three xr camera updates inside render()).
    const hm = pose ? new THREE.Matrix4().fromArray(pose.transform.matrix) : this.renderer.xr.getCamera().matrixWorld;
    const head = new THREE.Vector3().setFromMatrixPosition(hm);
    const headQ = new THREE.Quaternion().setFromRotationMatrix(hm);
    this._head = head; this._headQ = headQ;
    const seen = new Set();
    const hud = this.hud;
    let freeIdx = 0;

    // 1. person cards
    for (const [id, msg] of hud.cards) {
      const k = 'card:' + id;
      seen.add(k);
      const m = this._mesh(k, msg, drawPersonCard, deltasAnimating(msg));
      const b = hud.bboxFor(id);
      if (b) {
        // right of the person's head
        m.target = this._rayPoint(head, headQ, b[0] + b[2] + 0.02, b[1] + 0.12 * b[3], this.config.cardDistance);
        // the ray hits the face's right edge; shift by half the card so it sits beside the face, not over it
        m.target.add(new THREE.Vector3(m.mesh.geometry.parameters.width / 2, 0, 0).applyQuaternion(headQ));
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
        m.target = card.target.clone().add(new THREE.Vector3(0, -(ch / 2 + ah / 2 + 0.02), 0));
      } else if (!m.placed) {
        m.target = this._local(head, headQ, 0.32, -0.12 - 0.22 * freeIdx++, -this.config.cardDistance);
      }
      m.mesh.userData.track = id;
    }

    // 2. memory toasts: head-locked, low center, stacked
    let y = -0.28;
    for (const tst of hud.liveToasts().reverse()) {
      const k = 'toast:' + tst.t;
      seen.add(k);
      const m = this._mesh(k, tst, drawMemoryToast);
      m.headLocked = new THREE.Vector3(0, y, -1.2);
      m.mesh.material.opacity = tst.age < 0.08 ? tst.age / 0.08 : tst.age > 0.85 ? (1 - tst.age) / 0.15 : 1;
      y += m.mesh.geometry.parameters.height + 0.015;
    }

    // status strip (tiny, bottom) so cam/mic/ws can be checked inside the headset
    const line = this.statusLine();
    seen.add('status');
    const sm = this._mesh('status', line, drawStatus);
    sm.headLocked = new THREE.Vector3(0, -0.42, -1.2);
    sm.mesh.material.opacity = 0.7;

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
    this.dev.frame(head, headQ, this.meshes, this.config.cardDistance);
    this.mem.frame(head, headQ, this.dev);
    this.vfx.frame(this, head, headQ);
    this.swarm.frame(head, headQ);
    this.renderer.render(this.scene, this.camera);
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

  _mesh(k, msg, draw, animate = false) {
    let m = this.meshes.get(k);
    if (m && m.msg === msg && !animate) return m;
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
