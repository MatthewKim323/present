import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { FluidGlassPass, createProjectedCameraBackground, setProjectedCameraSource } from "../src/fluid-glass-pass.js";

function setup(nativePassthrough = false) {
  const scene = new THREE.Scene();
  const left = new THREE.PerspectiveCamera(60, 1, 0.01, 10),
    right = left.clone();
  left.position.x = -0.032;
  right.position.x = 0.032;
  left.updateMatrixWorld();
  right.updateMatrixWorld();
  left.viewport = new THREE.Vector4(0, 0, 700, 700);
  right.viewport = new THREE.Vector4(700, 0, 700, 700);
  let target = null;
  const renders = [];
  const renderer = {
    xr: { enabled: true, getCamera: () => ({ cameras: [left, right] }) },
    getRenderTarget: () => target,
    setRenderTarget: (t) => (target = t),
    getClearColor: (c) => c.set(0),
    getClearAlpha: () => 0,
    getViewport: (v) => v.set(0, 0, 1400, 700),
    setViewport() {},
    setClearColor() {},
    clear() {},
    render(s, c) {
      renders.push({
        target,
        background: s.background,
        x: c.matrixWorld.elements[12],
        viewport: c.viewport,
      });
    },
  };
  const pass = Object.assign(Object.create(FluidGlassPass.prototype), {
    renderer,
    scene,
    geometry: new THREE.BoxGeometry(1, 1, 1),
    environment: { texture: new THREE.Texture(), dispose() {} },
    savedEnvironment: null,
    targets: new Map(),
    panels: new Set(),
    nativePassthrough,
  });
  const panel = pass.createPanel(0.4, 0.3);
  scene.add(panel);
  return { pass, panel, scene, renderer, renders, left, right };
}

test("native Quest passthrough glass never samples a replacement room image", () => {
  const { pass, panel, scene, renderer, renders, left } = setup(true);
  const source = { forEye: () => ({ texture: new THREE.Texture(), aligned: false }) };
  pass.render(source, left);
  assert.equal(renders.length, 0, "passthrough lives outside the WebGL framebuffer");
  assert.equal(scene.background, null);
  assert.equal(pass.cameraBackground, undefined);
  panel.onBeforeRender(renderer, scene, left);
  assert.equal(panel.material.buffer, undefined);
  const shader = { fragmentShader: "#include <opaque_fragment>" };
  panel.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /worldRim/);
  panel.geometry.dispose();
  panel.material.dispose();
  pass.dispose();
});

test("FluidGlass renders distinct full-frame buffers for each eye and binds matching texture", () => {
  const { pass, panel, scene, renderer, renders, left, right } = setup();
  const lt = new THREE.Texture(),
    rt = new THREE.Texture();
  pass.render({ forEye: (eye) => ({ texture: eye === left ? lt : rt }) }, left);
  assert.equal(renders.length, 2);
  assert.notEqual(renders[0].target, renders[1].target);
  assert.equal(renders[0].background, lt);
  assert.equal(renders[1].background, rt);
  assert.equal(renders[0].x, -0.032);
  assert.equal(renders[1].x, 0.032);
  assert.equal(
    renders[1].viewport,
    undefined,
    "atlas offset must not leak into single-eye buffer",
  );
  assert.equal(scene.background, null);
  assert.equal(panel.visible, true);
  assert.equal(renderer.xr.enabled, true);
  panel.onBeforeRender(renderer, scene, left);
  assert.equal(panel.material.buffer, pass.targets.get(left).texture);
  panel.onBeforeRender(renderer, scene, right);
  assert.equal(panel.material.buffer, pass.targets.get(right).texture);
  panel.geometry.dispose();
  panel.material.dispose();
  assert.equal(pass.panels.size, 0);
  pass.dispose();
});

test("FluidGlass restores XR rendering and hidden content even when capture fails", () => {
  const { pass, panel, scene, renderer, left } = setup();
  renderer.render = () => {
    throw Error("capture failed");
  };
  assert.throws(() => pass.render(null, left), /capture failed/);
  assert.equal(renderer.xr.enabled, true);
  assert.equal(panel.visible, true);
  assert.equal(scene.background, null);
  assert.equal(renderer.getRenderTarget(), null);
  panel.geometry.dispose();
  panel.material.dispose();
  pass.dispose();
});

function projectedUv(mesh, uv) {
  const u = mesh.material.uniforms;
  const ray = new THREE.Vector4(uv.x * 2 - 1, uv.y * 2 - 1, 1, 1)
    .applyMatrix4(u.eyeProjectionInverse.value);
  ray.divideScalar(ray.w);
  const point = new THREE.Vector4(
    ray.x * u.projectionDepth.value / -ray.z,
    ray.y * u.projectionDepth.value / -ray.z,
    -u.projectionDepth.value,
    1,
  ).applyMatrix4(u.captureFromEye.value);
  return new THREE.Vector2(point.x / point.w * 0.5 + 0.5, point.y / point.w * 0.5 + 0.5);
}

test("mono camera projection corrects FOV, stereo eye offset and capture pose", () => {
  const mesh = createProjectedCameraBackground();
  const eye = new THREE.PerspectiveCamera(90, 1, 0.01, 10);
  const capture = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
  eye.position.x = -0.032;
  eye.updateMatrixWorld();
  capture.updateMatrixWorld();
  const source = {
    texture: new THREE.Texture(),
    projectionMatrix: capture.projectionMatrix,
    viewMatrix: capture.matrixWorldInverse,
  };
  setProjectedCameraSource(mesh, source, eye);
  const left = projectedUv(mesh, new THREE.Vector2(0.5, 0.5));
  assert.ok(Math.abs(left.x - (0.5 - 0.032 / 2 * Math.sqrt(3) / 2)) < 1e-6);
  eye.position.x = 0.032;
  eye.updateMatrixWorld();
  setProjectedCameraSource(mesh, source, eye);
  const right = projectedUv(mesh, new THREE.Vector2(0.5, 0.5));
  assert.ok(right.x > 0.5 && left.x < 0.5, "eyes must not receive identical stretched pixels");
  assert.ok(projectedUv(mesh, new THREE.Vector2(1, 0.5)).x > 1, "camera FOV edges must stay outside instead of stretching");
  capture.position.x = 0.5;
  capture.updateMatrixWorld();
  setProjectedCameraSource(mesh, source, eye);
  assert.ok(projectedUv(mesh, new THREE.Vector2(0.5, 0.5)).x < left.x, "capture pose must affect reprojection");
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test("fallback camera is projected into each FBO and removed from the main scene", () => {
  const { pass, scene, renderer, left } = setup();
  const source = {
    aligned: false,
    texture: new THREE.Texture(),
    projectionMatrix: left.projectionMatrix.clone(),
    viewMatrix: new THREE.Matrix4(),
  };
  const offsets = [];
  renderer.render = (s) => {
    assert.equal(s.background, null);
    assert.equal(pass.cameraBackground.parent, scene);
    offsets.push(projectedUv(pass.cameraBackground, new THREE.Vector2(0.5, 0.5)).x);
  };
  pass.render({ forEye: () => source }, left);
  assert.ok(offsets[0] < 0.5 && offsets[1] > 0.5);
  assert.equal(pass.cameraBackground.parent, null);
  renderer.render = () => { throw Error("projection failed"); };
  assert.throws(() => pass.render({ forEye: () => source }, left), /projection failed/);
  assert.equal(pass.cameraBackground.parent, null);
  assert.equal(renderer.xr.enabled, true);
  pass.dispose();
});


test("transmission capture uses this frame's XR world matrices, not the previous pose", () => {
  const { pass, renderer, renders, left, right } = setup();
  // Match WebXRManager: local matrices are current but world matrices remain
  // from the prior render until updateCamera runs.
  left.matrix.makeTranslation(0.968, 0, 0);
  right.matrix.makeTranslation(1.032, 0, 0);
  let updates = 0;
  const applicationCamera = new THREE.PerspectiveCamera();
  renderer.xr.updateCamera = (camera) => {
    assert.equal(camera, applicationCamera);
    updates++;
    for (const eye of [left, right]) {
      eye.matrixWorld.copy(eye.matrix);
      eye.matrixWorldInverse.copy(eye.matrixWorld).invert();
    }
  };
  pass.render(null, applicationCamera);
  assert.equal(updates, 1);
  assert.equal(renders[0].x, 0.968);
  assert.equal(renders[1].x, 1.032);
  pass.dispose();
});


test("room and glass reuse the same camera projection per eye without double capture", () => {
  const { pass, scene, renderer, left, right } = setup();
  const texture = new THREE.Texture();
  const source = { aligned:false, texture, projectionMatrix:left.projectionMatrix.clone(), viewMatrix:new THREE.Matrix4() };
  const captured = [];
  renderer.render = () => {
    assert.equal(pass.roomBackground.visible, false, 'main room must not duplicate into the FBO');
    captured.push(pass.cameraBackground.material.uniforms.captureFromEye.value.clone());
  };
  pass.render({ forEye: () => source }, left, { cameraRoom: true });
  assert.equal(pass.roomBackground.visible, true);
  for (const [i, eye] of [left, right].entries()) {
    pass.roomBackground.onBeforeRender(renderer, scene, eye);
    const uniforms = pass.roomBackground.material.uniforms;
    assert.equal(uniforms.cameraImage.value, texture);
    assert.deepEqual(uniforms.captureFromEye.value.elements, captured[i].elements);
    assert.equal(uniforms.opaqueOutside.value, 1, 'no native passthrough mismatch at uncovered camera edges');
  }
  renderer.render = () => {};
  pass.render({ forEye: () => null }, left, { cameraRoom: true });
  pass.roomBackground.onBeforeRender(renderer, scene, left);
  assert.equal(pass.roomBackground.material.uniforms.cameraPresent.value, 0, 'lost camera never freezes the old room');
  const room = pass.roomBackground;
  pass.dispose();
  assert.equal(room.parent, null);
});

test("camera room stays available with no panels and binds raw images separately per eye", () => {
  const { pass, scene, renderer, left, right } = setup();
  pass.panels.clear();
  const lt = new THREE.Texture(), rt = new THREE.Texture();
  pass.render({forEye: eye => ({aligned:true,texture:eye===left?lt:rt})}, left, { cameraRoom: true });
  pass.roomBackground.onBeforeRender(renderer,scene,left);
  assert.equal(pass.roomBackground.material.uniforms.cameraImage.value,lt);
  assert.equal(pass.roomBackground.material.uniforms.alignedCamera.value,1);
  pass.roomBackground.onBeforeRender(renderer,scene,right);
  assert.equal(pass.roomBackground.material.uniforms.cameraImage.value,rt);
  pass.dispose();
});


test("normal AR preserves compositor passthrough instead of replacing the surrounding room", () => {
  const { pass, scene, left } = setup();
  const source = { aligned:false, texture:new THREE.Texture(), projectionMatrix:left.projectionMatrix, viewMatrix:new THREE.Matrix4() };
  pass.render({forEye: () => source}, left);
  assert.equal(pass.roomBackground, undefined);
  assert.equal(scene.background, null);
  assert.equal(pass.cameraBackground.parent, null);
  pass.dispose();
});
