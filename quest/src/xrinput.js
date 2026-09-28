// XR pointing: hand / controller lasers, hover, click, move and resize for HUD panels.
//
// Gestures (Quest hand tracking: pinch = select; controllers: trigger = select, grip = squeeze):
//   point at a panel          thin ACCENT laser + reticle, the panel edge lights up
//   quick pinch               clicks it (GitHub buttons, preview, person card: the existing select path)
//   pinch-hold 250 ms + drag  grabs the panel; it follows the ray at its distance (push/pull the hand to change
//                             distance), release drops it world-locked. Controllers: grip grabs at once.
//   pinch the corner handle   (bottom-right L) and drag: resize. Or pinch the same panel with both hands and
//                             spread / squeeze them. 0.5x to 2.5x.
//   double-pinch empty space  resets every panel to the layout plan (layout.js)
// A pinch that hits no panel falls through to xr.js _onSelect (pinch a person -> entity adopt), unchanged.
//
// Modules don't know about any of this: xr.js registers a getter per panel (register()), and the placement
// overrides are applied after the modules place themselves each frame (apply()). User placement + scale persist
// per panel key in localStorage.
import * as THREE from 'three';
import { LITE } from './perf.js';

const ACCENT = 0x7cf0c5;
const HOLD_MS = 250;           // pinch-hold before a grab starts
const MOVE_EPS = 0.02;         // m: a grab that moved less than this is still a click
const S_MIN = 0.5, S_MAX = 2.5;
const DOUBLE_MS = 450;
const CORNER = 0.14;           // uv fraction of the bottom-right corner that is the resize handle
const STORE = 'world.xrPlace.v1';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function load() {
  try { const o = JSON.parse(localStorage.getItem(STORE) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
function save(map) {
  try {
    const o = {};
    for (const [k, r] of map) if (r.p || r.s !== 1) o[k] = { p: r.p ? r.p.toArray() : null, s: r.s };
    localStorage.setItem(STORE, JSON.stringify(o));
  } catch {}
}

// unit square outline + a corner L (the resize handle), in plane-local units (-0.5..0.5)
function outlineGeometry() {
  const c = 0.5, l = 0.12;
  const pts = [
    -c, -c, 0, c, -c, 0, c, -c, 0, c, c, 0, c, c, 0, -c, c, 0, -c, c, 0, -c, -c, 0,
    // handle, just outside the bottom-right corner
    c + 0.02, -c - 0.02 + l, 0, c + 0.02, -c - 0.02, 0, c + 0.02, -c - 0.02, 0, c + 0.02 - l, -c - 0.02, 0,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

export class XrInput {
  // xr: XrHud (scene, refSpace, session, config)
  constructor(xr) {
    this.xr = xr;
    this.scene = xr.scene;
    this.entries = [];            // { key, get, opts }
    this.place = new Map();       // key -> { p: Vector3|null, s, base, applied }
    for (const [k, v] of Object.entries(load())) {
      if (!v) continue;
      const p = Array.isArray(v.p) && v.p.length === 3 && v.p.every(Number.isFinite) ? new THREE.Vector3().fromArray(v.p) : null;
      const s = Number.isFinite(v.s) ? clamp(v.s, S_MIN, S_MAX) : 1;
      this.place.set(k, { p, s, base: null, applied: null });
    }
    this.press = new Map();       // XRInputSource -> press state
    this.ended = new Map();       // XRInputSource -> the press its last selectend closed
    this.srcs = new Map();        // XRInputSource -> { laser, reticle, outline, hover }
    this.rc = new THREE.Raycaster();
    this._o = new THREE.Vector3(); this._d = new THREE.Vector3(); this._m = new THREE.Matrix4();
    this._t = new THREE.Vector3(); this._t2 = new THREE.Vector3(); this._plane = new THREE.Plane(); this._n = new THREE.Vector3();
    this._hits = [];
    this._list = [];              // reused [key, obj, entry] triples
    this._lastEmpty = 0;
    this.outlineGeo = outlineGeometry();
    this.proxyGeo = new THREE.PlaneGeometry(1, 1);
    this.proxies = new Map();     // key -> invisible hit plane for groups
    const s = xr.session;
    const on = (type, fn) => s.addEventListener(type, (ev) => { try { fn(ev); } catch (e) { console.warn('[world] xrinput', type, e); } });
    on('selectstart', (ev) => this._start(ev, false));
    on('selectend', (ev) => this._end(ev, false));
    on('squeezestart', (ev) => this._start(ev, true));
    on('squeezeend', (ev) => this._end(ev, true));
    on('inputsourceschange', (ev) => { for (const src of ev.removed || []) this._dropSrc(src); });
    if (import.meta.env?.DEV) window.__xrInput = this; // headless checks
  }

  // get(): Object3D | null | array of [subKey, Object3D]. opts: { pass: true } = a click goes to xr.js _onSelect
  // (it owns the action), { grab: false } = not movable / resizable, { proxy: [x0, y0, x1, y1] } = group: hit a
  // plane over this local rect instead of its children.
  register(key, get, opts = {}) { this.entries.push({ key, get, opts }); }

  _collect() {
    const out = this._list; out.length = 0;
    for (const e of this.entries) {
      let r;
      try { r = e.get(); } catch { r = null; }
      if (!r) continue;
      if (Array.isArray(r)) { for (const [k, o] of r) if (o && o.parent) out.push([k, o, e]); }
      else if (r.parent && r.visible !== false) out.push([e.key, r, e]);
    }
    return out;
  }

  // the mesh to raycast / outline for obj (itself, or a proxy plane over a group's local rect)
  _hitMesh(key, obj, e) {
    const pr = e.opts.proxy;
    if (!pr) return obj;
    let m = this.proxies.get(key);
    if (!m) { m = new THREE.Mesh(this.proxyGeo, new THREE.MeshBasicMaterial({ visible: false })); m.matrixAutoUpdate = false; this.proxies.set(key, m); }
    obj.updateMatrixWorld(true);
    const [x0, y0, x1, y1] = pr;
    m.matrixWorld.copy(obj.matrixWorld).multiply(this._m.compose(this._t.set((x0 + x1) / 2, (y0 + y1) / 2, 0), m.quaternion, this._t2.set(x1 - x0, y1 - y0, 1)));
    return m;
  }

  _size(mesh) {
    const p = mesh.geometry && mesh.geometry.parameters;
    return p && p.width ? [p.width, p.height] : [1, 1];
  }

  // ray from an input source's targetRaySpace in `frame`; false if not tracked
  _ray(frame, src) {
    const ref = this.xr.refSpace;
    const pose = frame && src.targetRaySpace && frame.getPose(src.targetRaySpace, ref);
    if (!pose) return false;
    this._m.fromArray(pose.transform.matrix);
    this._o.setFromMatrixPosition(this._m);
    this._d.set(0, 0, -1).transformDirection(this._m);
    this.rc.set(this._o, this._d);
    return true;
  }

  // nearest registered panel under the current ray: { key, obj, entry, mesh, hit } or null
  _pick() {
    let best = null;
    for (const [key, obj, e] of this._collect()) {
      const mesh = this._hitMesh(key, obj, e);
      if (mesh === obj) mesh.updateMatrixWorld();
      this._hits.length = 0;
      mesh.raycast(this.rc, this._hits);
      for (const h of this._hits) if (!best || h.distance < best.hit.distance) best = { key, obj, entry: e, mesh, hit: h };
    }
    return best;
  }

  _rec(key) {
    let r = this.place.get(key);
    if (!r) this.place.set(key, (r = { p: null, s: 1, base: null, applied: null }));
    return r;
  }

  _start(ev, squeeze) {
    const src = ev.inputSource;
    this.ended.delete(src);
    if (!this._ray(ev.frame, src)) return;
    const pk = this._pick();
    if (!pk) return;
    const { key, obj, entry, hit } = pk;
    const rec = this._rec(key);
    const st = {
      key, obj, entry, t0: performance.now(), squeeze, moved: false, mode: squeeze && entry.opts.grab !== false ? 'grab' : 'press',
      dist: hit.distance, off: obj.position.clone().sub(hit.point), depth0: 0, s0: rec.s,
      corner: !!(hit.uv && hit.uv.x > 1 - CORNER && hit.uv.y < CORNER && entry.opts.grab !== false && !entry.opts.proxy),
      start: obj.position.clone(), r0: 0,
    };
    st.depth0 = this._depth(st);
    if (st.corner) {
      const c = obj.getWorldPosition(this._t);
      st.r0 = Math.max(0.02, hit.point.distanceTo(c));
    }
    this.press.set(src, st);
    // second hand on the same panel: two-hand resize
    for (const [o, other] of this.press) {
      if (o === src || other.key !== key || entry.opts.grab === false) continue;
      const a = this._origin(ev.frame, o), b = this._origin(ev.frame, src);
      if (!a || !b) continue;
      const d0 = Math.max(0.03, a.distanceTo(b));
      other.mode = st.mode = 'resize'; other.moved = st.moved = true;
      this.pair = { key, a: o, b: src, d0, s0: rec.s };
    }
  }

  _origin(frame, src) {
    const pose = frame && src.targetRaySpace && frame.getPose(src.targetRaySpace, this.xr.refSpace);
    if (!pose) return null;
    const p = pose.transform.position;
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  // hand distance from the head along the ray (push / pull adjusts grab distance)
  _depth() {
    const head = this.xr._head;
    return head ? this._t2.copy(this._o).sub(head).dot(this._d) : 0;
  }

  _end(ev, squeeze) {
    const src = ev.inputSource;
    const st = this.press.get(src);
    if (!st || st.squeeze !== squeeze) return;
    this.press.delete(src);
    this.ended.set(src, st); // `select` may arrive after `selectend` (IWER does this): consumeSelect still sees it
    if (this.pair && (this.pair.a === src || this.pair.b === src)) {
      const other = this.pair.a === src ? this.pair.b : this.pair.a;
      const o = this.press.get(other);
      if (o) o.mode = 'done'; // the other hand's release is a no-op, not a click
      this.pair = null;
    }
    if (st.moved) save(this.place);
  }

  // xr.js select handler asks first. true = handled here (grab / resize / non-clickable panel / reset).
  consumeSelect(ev) {
    const st = this.press.get(ev.inputSource) || this.ended.get(ev.inputSource);
    this.ended.delete(ev.inputSource);
    if (st && st.squeeze) return false; // (squeeze never makes a select; defensive)
    if (st) {
      if (st.moved || st.mode === 'resize' || st.mode === 'done') return true;
      return !st.entry.opts.pass; // pass panels: xr.js _onSelect runs the action (buttons, card pinch, preview)
    }
    // pinch on nothing: double-pinch resets the layout, a single one falls through (person pick)
    if (!this._ray(ev.frame, ev.inputSource) || this._pick()) return false;
    const t = performance.now();
    if (t - this._lastEmpty < DOUBLE_MS) { this._lastEmpty = 0; this.reset(); return true; }
    this._lastEmpty = t;
    return false;
  }

  reset() {
    for (const [key, r] of this.place) {
      const obj = this._find(key);
      if (obj && r.base != null) obj.scale.setScalar(r.base);
      if (obj && r.orig) obj.position.copy(r.orig);
    }
    this.place.clear();
    save(this.place);
  }

  _find(key) {
    for (const [k, o] of this._collect()) if (k === key) return o;
    return null;
  }

  // Placement overrides: after the modules placed themselves this frame. Cheap: only user-placed keys.
  apply(head) {
    if (!this.place.size) return;
    for (const [key, obj] of this._collect()) {
      const r = this.place.get(key);
      if (!r) continue;
      // scale: modules that set a scale every frame define the base; the rest keep the one we saw first
      const sx = obj.scale.x;
      if (r.applied == null || Math.abs(sx - r.applied) > 1e-6) r.base = sx;
      if (r.s !== 1 || r.applied != null) { r.applied = r.base * r.s; obj.scale.setScalar(r.applied); }
      if (r.p) {
        obj.position.copy(r.p);
        if (head) { if (obj.isMesh) obj.lookAt(head); else obj.lookAt(head.x, obj.position.y, head.z); }
      }
    }
  }

  _src(src) {
    let s = this.srcs.get(src);
    if (s) return s;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const col = new THREE.Color(ACCENT);
    lg.setAttribute('color', new THREE.BufferAttribute(new Float32Array([col.r, col.g, col.b, 0, col.r, col.g, col.b, LITE ? 0.7 : 0.9]), 4));
    const laser = new THREE.Line(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false }));
    laser.frustumCulled = false; laser.renderOrder = 40; laser.visible = false;
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.0035, 0.006, 20), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    reticle.renderOrder = 41; reticle.visible = false;
    if (!LITE) {
      const glow = new THREE.Mesh(new THREE.CircleGeometry(0.013, 20), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      glow.renderOrder = 40;
      reticle.add(glow);
    }
    const outline = new THREE.LineSegments(this.outlineGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
    outline.matrixAutoUpdate = false; outline.frustumCulled = false; outline.renderOrder = 39; outline.visible = false;
    this.scene.add(laser, reticle, outline);
    s = { laser, reticle, outline, hover: null };
    this.srcs.set(src, s);
    return s;
  }

  _dropSrc(src) {
    const s = this.srcs.get(src);
    if (!s) return;
    for (const o of [s.laser, s.reticle, s.outline]) {
      this.scene.remove(o);
      o.traverse((x) => { if (x.geometry && x.geometry !== this.outlineGeo) x.geometry.dispose(); if (x.material) x.material.dispose(); });
    }
    this.srcs.delete(src);
    this.press.delete(src);
  }

  // Once per XR frame, after every module placed itself.
  frame(frame, head) {
    const session = this.xr.session;
    if (!session) return;
    if (!frame) { this.apply(head); return; } // some loop ticks carry no XRFrame: keep the lasers as they were
    const now = performance.now();
    // grabs + resizes first (they write placements), then apply, then hover / lasers against the final poses
    for (const src of session.inputSources) {
      const st = this.press.get(src);
      if (!st || !this._ray(frame, src)) continue;
      const rec = this._rec(st.key);
      if (st.mode === 'press' && now - st.t0 > HOLD_MS && st.entry.opts.grab !== false) st.mode = st.corner ? 'corner' : 'grab';
      if (st.mode === 'grab') {
        const d = clamp(st.dist + (this._depth() - st.depth0) * 2.5, 0.3, 4);
        const p = this._t.copy(this._o).addScaledVector(this._d, d).add(st.off);
        if (!st.moved && p.distanceTo(st.start) > MOVE_EPS) st.moved = true;
        if (st.moved) (rec.p ||= new THREE.Vector3()).copy(p);
      } else if (st.mode === 'corner') {
        const c = st.obj.getWorldPosition(this._t2);
        this._n.set(0, 0, 1).applyQuaternion(st.obj.getWorldQuaternion(this._q ||= new THREE.Quaternion()));
        this._plane.setFromNormalAndCoplanarPoint(this._n, c);
        const hit = this.rc.ray.intersectPlane(this._plane, this._t);
        if (hit) {
          const s = clamp(st.s0 * hit.distanceTo(c) / st.r0, S_MIN, S_MAX);
          if (!st.moved && Math.abs(s - st.s0) > 0.03) st.moved = true;
          if (st.moved) rec.s = s;
        }
      }
    }
    if (this.pair) {
      const a = this._origin(frame, this.pair.a), b = this._origin(frame, this.pair.b);
      if (a && b) this._rec(this.pair.key).s = clamp(this.pair.s0 * a.distanceTo(b) / this.pair.d0, S_MIN, S_MAX);
    }
    this.apply(head);

    const live = new Set();
    for (const src of session.inputSources) {
      live.add(src);
      const s = this._src(src);
      if (!this._ray(frame, src)) {
        // untracked (hand down / out of view): hide after a short grace so one dropped pose doesn't flicker
        if (now - (s.seen || 0) > 150) { s.laser.visible = s.reticle.visible = s.outline.visible = false; s.hover = null; }
        continue;
      }
      s.seen = now;
      const st = this.press.get(src);
      let pk = null, end = null;
      if (st && st.mode !== 'press' && st.mode !== 'done') {
        // holding a panel: the laser ends on it
        end = (this._endV ||= new THREE.Vector3()).copy(st.obj.position);
        pk = { key: st.key, obj: st.obj, entry: st.entry, mesh: this._hitMesh(st.key, st.obj, st.entry) };
        const hk = this._pick();
        if (hk && hk.key === st.key) end = hk.hit.point;
      } else {
        pk = this._pick();
        if (pk) end = pk.hit.point;
      }
      if (!pk) { s.laser.visible = s.reticle.visible = s.outline.visible = false; s.hover = null; continue; }
      s.hover = pk.key;
      // laser: from just in front of the hand to the hit, fading in toward the panel
      const pos = s.laser.geometry.attributes.position;
      const len = this._o.distanceTo(end);
      const from = this._t2.copy(this._o).addScaledVector(this._d, Math.min(0.06, len * 0.2));
      pos.setXYZ(0, from.x, from.y, from.z); pos.setXYZ(1, end.x, end.y, end.z); pos.needsUpdate = true;
      s.laser.visible = true;
      s.reticle.position.copy(end);
      s.reticle.lookAt(this._o);
      s.reticle.scale.setScalar(st ? 0.7 : 1);
      s.reticle.visible = true;
      // hover edge (plane meshes and group proxies)
      const m = pk.mesh;
      if (m.isMesh) {
        if (m === pk.obj) m.updateMatrixWorld();
        const [w, h] = this._size(m);
        s.outline.matrix.copy(m.matrixWorld).multiply(this._m.makeScale(w, h, 1));
        s.outline.matrixWorld.copy(s.outline.matrix);
        s.outline.material.opacity = st && st.mode !== 'press' ? 1 : 0.7;
        s.outline.visible = true;
      } else s.outline.visible = false;
    }
    for (const src of [...this.srcs.keys()]) if (!live.has(src)) this._dropSrc(src);
  }
}
