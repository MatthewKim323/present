import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { XrHud } from "../src/xr.js";
import { HudState } from "../src/hud.js";
import { DEV_SCRIPT, setDevSender } from "../src/devpanels.js";

function setup(t) {
  const drawnText = [];
  const ctx = new Proxy(
    {
      fillText: (s) => drawnText.push(String(s)),
      measureText: (s) => ({ width: String(s).length * 7 }),
      createLinearGradient: () => ({ addColorStop() {} }),
    },
    { get: (o, k) => (k in o ? o[k] : () => {}) },
  );
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
  t.after(() => {
    globalThis.document = previous;
  });
  const hud = new HudState(),
    pinches = [];
  hud.apply({ kind: "person_card", anchor_track_id: "1", name: "Alex" });
  const xr = new XrHud({
    hud,
    config: { hfov: 90, cardDistance: 0.9 },
    onPinch: (id) => pinches.push(id),
    statusLine: () => "connected",
  });
  xr.scene = new THREE.Scene();
  xr.camera = new THREE.PerspectiveCamera();
  xr.renderer = { render() {}, setAnimationLoop() {}, dispose() {} };
  // Test the XR/pass ownership contract without creating a WebGL context.
  xr.fluidGlass = {
    createPanel(w, h) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, .016), new THREE.MeshPhysicalMaterial({ transmission: 1 })); },
    resizePanel(mesh, w, h) { mesh.geometry.dispose(); mesh.geometry = new THREE.BoxGeometry(w, h, .016); },
    render() {}, dispose() {},
  };
  xr.refSpace = {};
  const input = { targetRaySpace: {}, targetRayMode: "tracked-pointer" };
  const sessionListeners = new Map();
  xr.session = { inputSources: [input],
    addEventListener(type, listener) { sessionListeners.set(type, listener); },
    removeEventListener(type) { sessionListeners.delete(type); },
  };
  xr._createCursor();
  const ray = { x: 0, y: -0.23 };
  const frame = {
    getViewerPose: () => ({
      transform: {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    }),
    getPose: () => ({
      transform: {
        matrix: new THREE.Matrix4().makeTranslation(ray.x, ray.y, 0).elements,
      },
    }),
  };
  const render = () => xr._frame(performance.now() + 300, frame);
  const select = () => xr._onSelect({ frame, inputSource: input });
  t.after(() => xr._dispose());
  return { xr, hud, pinches, input, ray, render, select, frame, drawnText };
}

test("real Three.js rays switch dock views and select a person once", (t) => {
  const { xr, hud, pinches, ray, render, select } = setup(t);
  render();
  assert.equal(xr.focused, "dock");
  select();
  assert.equal(hud.view, "memories");
  render();
  assert.ok(xr.meshes.has("detail:memories"));
  ray.x = 0.12;
  select();
  assert.equal(hud.view, "agents");
  render();
  assert.ok(xr.meshes.has("detail:agents"));
  ray.x = 0.24;
  ray.y = 0.1;
  select();
  assert.equal(hud.selectedTrack, "1");
  assert.equal(hud.view, "person");
  assert.deepEqual(pinches, ["1"]);
  render();
  assert.ok(xr.meshes.has("detail:person"));
  const texture = xr.meshes.get("detail:person").mesh.material.map;
  const version = texture.version;
  render();
  assert.equal(
    texture.version,
    version,
    "unchanged panels should not upload textures every frame",
  );
  xr._dispose();
  assert.equal(xr.meshes.size, 0);
  assert.equal(xr.renderer, null);
});

test("expanded content stays above dock and suppresses toast overlap", (t) => {
  const { xr, hud, render } = setup(t);
  hud.apply({ kind: "memory_event", text: "first memory" });
  hud.apply({ kind: "memory_event", text: "latest memory" });
  render();
  assert.equal(
    [...xr.meshes.keys()].filter((k) => k.startsWith("toast:")).length,
    1,
  );
  hud.apply({
    kind: "person_card",
    anchor_track_id: "1",
    name: "Alex",
    role: "Founder",
    company: "Example",
    last_topic: "A very long conversation about onboarding and retention",
    owes_you: ["A summary of all decisions", "A detailed proposal"],
    you_owe: ["A complete review"],
  });
  hud.select("1");
  render();
  assert.equal(
    [...xr.meshes.keys()].filter((k) => k.startsWith("toast:")).length,
    0,
  );
  const detail = xr.meshes.get("detail:person"),
    dock = xr.meshes.get("dock");
  const detailBottom =
    detail.headLocked.y - detail.mesh.geometry.parameters.height / 2;
  const dockTop = dock.headLocked.y + dock.mesh.geometry.parameters.height / 2;
  assert.ok(detailBottom >= dockTop + 0.03);
  assert.equal(hud.memoryHistory.length, 2);
});

test("gaze does not drive hover and reduced motion skips entrance scaling", (t) => {
  const { xr, input, render } = setup(t);
  input.targetRayMode = "gaze";
  xr.reducedMotion = true;
  render();
  assert.equal(xr.focused, null);
  assert.equal(xr.cursor.visible, false);
  assert.equal(xr.meshes.get("dock").mesh.scale.x, 1);
  assert.equal(xr.cursor.material.color.getHex(), 0xffffff);
});

test("custom panels dispatch only action or dismissal intents from actual hit regions", (t) => {
  const { xr, hud, ray, render, select, pinches } = setup(t);
  const actions = [],
    dismissals = [];
  xr.onPanelAction = (...args) => actions.push(args);
  xr.onPanelDismiss = (id) => dismissals.push(id);
  xr.reducedMotion = true;
  hud.apply({
    kind: "panel",
    op: "show",
    id: "approval-1",
    type: "approval",
    title: "Review draft",
    actions: [{ id: "review", label: "Review" }],
  });
  hud.select("1");
  hud.apply({ kind: "memory_event", text: "a memory" });
  render();
  assert.ok(xr.meshes.has("tool:approval-1"));
  assert.equal(xr.meshes.has("detail:person"), false);
  assert.equal(
    [...xr.meshes.keys()].some((key) => key.startsWith("toast:")),
    false,
  );
  const entry = xr.meshes.get("tool:approval-1");
  assert.equal(entry.fluid.isMesh, true);
  assert.equal(entry.fluid.material.transmission, 1);
  assert.equal(entry.fluid.parent, entry.mesh);
  assert.equal(entry.fluid.position.z, -.012);
  const panel = entry.mesh,
    canvas = panel.material.map.image;
  function aim(rect) {
    ray.x =
      panel.position.x + (rect.x + rect.w / 2 - canvas.width / 4) * 0.0012;
    ray.y =
      panel.position.y + (canvas.height / 4 - rect.y - rect.h / 2) * 0.0012;
  }
  aim(canvas.panelActions[0]);
  render();
  select();
  assert.deepEqual(actions, [["approval-1", "review"]]);
  assert.deepEqual(pinches, []);
  aim(canvas.panelDismiss);
  select();
  assert.deepEqual(dismissals, ["approval-1"]);
  ray.x = panel.position.x;
  ray.y = panel.position.y;
  select();
  assert.equal(actions.length, 1, "panel body does not execute an action");
  assert.equal(hud.beginPanelAction("approval-1", "review", "request-1"), true);
  aim(canvas.panelActions[0]);
  select();
  assert.equal(
    actions.length,
    1,
    "pending state blocks duplicate pinches even before canvas redraw",
  );
  render();
  assert.deepEqual(entry.mesh.material.map.image.panelActions, []);
  hud.apply({
    kind: "panel_result",
    panel_id: "approval-1",
    action_id: "review",
    request_id: "request-1",
    status: "rejected",
  });
  render();
  assert.equal(
    entry.mesh.material.map.image.panelActions.length,
    1,
    "rejected actions remain retryable",
  );
  select();
  assert.equal(actions.length, 2);
  assert.equal(hud.beginPanelAction("approval-1", "review", "request-2"), true);
  hud.apply({
    kind: "panel_result",
    panel_id: "approval-1",
    action_id: "review",
    request_id: "request-2",
    status: "received",
  });
  render();
  assert.deepEqual(
    xr.meshes.get("tool:approval-1").mesh.material.map.image.panelActions,
    [],
  );
  let disposed = 0;
  entry.fluid.geometry.addEventListener("dispose", () => disposed++);
  entry.fluid.material.addEventListener("dispose", () => disposed++);
  xr._dispose();
  assert.equal(
    disposed,
    2,
    "transmission resources are disposed with the tool panel",
  );
});

test("three panels requesting the same slot receive distinct positions", (t) => {
  const { xr, hud, render } = setup(t);
  for (const id of ["a", "b", "c"])
    hud.apply({
      kind: "panel",
      op: "show",
      id,
      type: "note",
      title: id,
      position: "center",
    });
  render();
  const panels = [...xr.meshes]
    .filter(([key]) => key.startsWith("tool:"))
    .map(([, item]) => item);
  assert.equal(panels.length, 3);
  assert.equal(new Set(panels.map((item) => item.headLocked.x)).size, 3);
  for (const item of panels) {
    assert.equal(item.mesh.material.map.image.width / 2, 320);
    assert.equal(item.mesh.material.map.image.height / 2, 240);
  }
});

test("each tracked input has its own visible solid beam and accurate hit endpoint", (t) => {
  const { xr, input, frame, render } = setup(t);
  const second = {
    targetRaySpace: {},
    targetRayMode: "tracked-pointer",
    handedness: "right",
  };
  const gaze = { targetRaySpace: {}, targetRayMode: "gaze" };
  input.hand = {};
  input.handedness = "left";
  xr.session.inputSources = [input, second, gaze];
  frame.getPose = (space) => ({
    transform: {
      matrix: new THREE.Matrix4().makeTranslation(
        space === input.targetRaySpace ? 0 : 2,
        -0.23,
        0,
      ).elements,
    },
  });
  render();
  assert.equal(xr.pointers.entries.size, 2, "gaze never gets a laser");
  const hand = xr.pointers.entries.get(input),
    controller = xr.pointers.entries.get(second);
  assert.equal(hand.beam.geometry.type, "CylinderGeometry");
  assert.ok(hand.beam.geometry.parameters.radiusTop >= 0.001);
  assert.ok(
    Math.abs(hand.ring.position.z + 0.898) < 0.001,
    "hand endpoint matches the dock hit",
  );
  assert.ok(
    Math.abs(controller.ring.position.z + 1.498) < 0.001,
    "misses still have a visible 1.5m aiming beam",
  );
  assert.equal(controller.ring.position.x, 2);
  assert.ok(controller.beam.material.opacity > 0);
  assert.ok(hand.ring.material.opacity > controller.ring.material.opacity);
  assert.equal(hand.beam.material.color.getHex(), 0xffffff);
  const beamDirection = new THREE.Vector3(0, 1, 0).applyQuaternion(
    hand.beam.quaternion,
  );
  assert.ok(beamDirection.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6);
});

test("pointer geometry is cleaned up on pose loss, disconnect, and session disposal", (t) => {
  const { xr, input, frame, render } = setup(t);
  render();
  let disposed = 0;
  const watch = (pointer) => {
    for (const mesh of [pointer.beam, pointer.ring, pointer.dot]) {
      mesh.geometry.addEventListener("dispose", () => disposed++);
      mesh.material.addEventListener("dispose", () => disposed++);
    }
  };
  watch(xr.pointers.entries.get(input));
  const original = frame.getPose;
  frame.getPose = () => null;
  render();
  assert.equal(xr.pointers.entries.size, 0);
  assert.equal(disposed, 6);
  frame.getPose = original;
  render();
  watch(xr.pointers.entries.get(input));
  xr.session.inputSources = [];
  render();
  assert.equal(xr.pointers.entries.size, 0);
  assert.equal(disposed, 12);
  xr.session.inputSources = [input];
  render();
  watch(xr.pointers.entries.get(input));
  xr._dispose();
  assert.equal(xr.pointers, null);
  assert.equal(disposed, 18);
});

test("viewer tracking loss clears pointers instead of leaving stale rays in space", (t) => {
  const { xr, frame, render } = setup(t);
  render();
  assert.equal(xr.pointers.entries.size, 1);
  frame.getViewerPose = () => null;
  render();
  assert.equal(xr.pointers.entries.size, 0);
  assert.equal(xr.cursor.visible, false);
});


test("upstream developer panels share accurate laser hits, actions, and disposal", t => {
  const { xr, hud, input, ray, render, select } = setup(t);
  const sent = [];
  setDevSender(message => { sent.push(message); return true; });
  t.after(() => setDevSender(() => false));
  hud.devGithub = DEV_SCRIPT.find(([, message]) => message.kind === "dev_github")[1];
  hud.devSession = { ...DEV_SCRIPT.find(([, message]) => message.kind === "dev_session")[1], _rx: performance.now() };
  xr._initDev(); render();
  assert.equal(hud.xrActive, true);
  assert.ok(xr.dev.meshes.gh && xr.dev.meshes.ss);
  const github = xr.dev.meshes.gh;
  const action = github.canvas.hits.find(hit => hit.action === "approve");
  assert.ok(action);
  const scale = github.w / (github.canvas.width / 2);
  const point = new THREE.Vector3(
    (action.x + action.w / 2 - github.canvas.width / 4) * scale,
    (github.canvas.height / 4 - action.y - action.h / 2) * scale, 0,
  ).applyMatrix4(github.mesh.matrixWorld);
  ray.x = point.x; ray.y = point.y; render();
  assert.equal(xr._hit().object.userData.dev, "gh");
  assert.equal(xr.cursor.visible, true);
  const endpoint = xr.pointers.entries.get(input).ring.position;
  assert.ok(Math.abs(endpoint.z - point.z) < .005);
  select(); assert.equal(sent[0].action, "approve");
  let disposed = 0;
  for (const entry of Object.values(xr.dev.meshes)) {
    entry.mesh.geometry.addEventListener("dispose", () => disposed++);
    entry.mesh.material.addEventListener("dispose", () => disposed++);
    entry.mesh.material.map.addEventListener("dispose", () => disposed++);
  }
  xr._end();
  assert.equal(hud.xrActive, false); assert.equal(xr.dev, null); assert.equal(disposed, 6);
});

test("selected person detail retains upstream context deltas and animation updates", t => {
  const { xr, hud, render, frame } = setup(t);
  hud.select("1"); render();
  const baseHeight = xr.meshes.get("detail:person").mesh.geometry.parameters.height;
  const msg = hud.cards.get("1");
  hud.cards.set("1", { ...msg, _deltas: [{ text: "+ prefers async", t: performance.now(), kind: "preference" }] });
  render();
  const detail = xr.meshes.get("detail:person");
  assert.ok(detail.mesh.geometry.parameters.height > baseHeight);
  assert.equal(detail.fluid.geometry.parameters.height, detail.mesh.geometry.parameters.height);
  const version = detail.mesh.material.map.version;
  xr._frame(performance.now() + 450, frame);
  assert.ok(detail.mesh.material.map.version > version);
});


test("transmission pass renders before scene and disposes after panel resources", t => {
  const { xr, render } = setup(t);
  const calls = [];
  xr.fluidGlass.render = (source, camera) => { assert.equal(source, null); assert.equal(camera, xr.camera); calls.push("glass"); };
  xr.renderer.render = () => calls.push("scene");
  render(); assert.deepEqual(calls, ["glass", "scene"]);
  const dock = xr.meshes.get("dock");
  dock.fluid.geometry.addEventListener("dispose", () => calls.push("panel"));
  xr.fluidGlass.dispose = () => calls.push("pass-dispose");
  xr._dispose();
  assert.ok(calls.indexOf("panel") < calls.indexOf("pass-dispose"));
  assert.equal(xr.fluidGlass, null);
});

test("headless rendering works without a transmission pass", t => {
  const { xr, render } = setup(t);
  xr.fluidGlass = null; render();
  assert.ok(xr.meshes.get("dock"));
  assert.equal(xr.meshes.get("dock").fluid, undefined);
});


test("preview screenshot is laser reachable, scrolls on pinch, holds to close, and disposes", t => {
  const { xr, hud, input, ray, render, select } = setup(t);
  hud.previewShot = {
    job_id: "build-1", pr: 7, title: "Real build preview", w: 1280, h: 2400,
    _rx: performance.now() - 1000, _key: "build-1:7", _v: 1,
    scroll: 0, _user: null,
  };
  xr._initDev();
  assert.equal(xr._devListeners[0][0], "selectstart", "adapter forwards pinch start");
  ray.x = 0; ray.y = -.08; render();
  const preview = xr.dev.pv.mesh;
  assert.equal(xr._hit().object, preview);
  assert.equal(xr.cursor.visible, true);
  const close = preview.material.map.image.hits.find(h => h.action === "close");
  const target = xr._toolTarget({ object: preview, uv: {
    x: (close.x + close.w / 2) / preview.userData.logicalWidth,
    y: 1 - (close.y + close.h / 2) / preview.userData.logicalHeight,
  }});
  assert.equal(target.action, "close", "2.4x preview canvas maps to logical hit coordinates");
  xr._devListeners[0][1]({ inputSource: input });
  select();
  assert.ok(hud.previewShot._user, "short pinch starts scrolling");
  assert.equal(hud.previewShot._out, undefined);
  xr.dev.presses.set(input, performance.now() - 600);
  select();
  assert.ok(hud.previewShot._out, "long pinch dismisses");
  let disposed = 0;
  for (const resource of [preview.geometry, preview.material, preview.material.map])
    resource.addEventListener("dispose", () => disposed++);
  xr._dispose();
  assert.equal(disposed, 3);
  assert.equal(xr._devListeners.length, 0);
  assert.equal(preview.parent, null);
});


test("person detail displays relationship and previous encounter from GBrain", t => {
  const { hud, render, drawnText } = setup(t);
  hud.apply({ kind: "person_card", anchor_track_id: "1", name: "Matthew",
    relationship: "Early Opal user", here: "YC hackathon",
    seen_before: { when: "2026-09-20", ago: "one week ago", where: "San Francisco" },
  });
  hud.select("1"); render();
  for (const value of ["RELATIONSHIP", "Early Opal user", "LAST SEEN", "HERE", "YC hackathon"])
    assert.ok(drawnText.includes(value), `renders ${value}`);
  assert.ok(drawnText.some(value => value.includes("one week ago")));
});
