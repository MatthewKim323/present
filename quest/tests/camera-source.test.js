import test from "node:test";
import assert from "node:assert/strict";
import { Matrix4, Texture } from "three";
import { CameraSource } from "../src/camera-source.js";

const identity = new Matrix4().elements;
test("raw camera textures remain tied to the current eye and current frame", () => {
  const left = {},
    right = {},
    rawLeft = {},
    rawRight = {};
  const lt = new Texture(),
    rt = new Texture();
  const source = new CameraSource({
    allowApproximate: false,
    getFrame: () => {
      throw Error("raw must win");
    },
  });
  const renderer = {
    xr: {
      getCamera: () => ({ cameras: [left, right] }),
      getCameraTexture: (c) => (c === rawLeft ? lt : rt),
    },
  };
  const view = (camera) => ({
    camera,
    projectionMatrix: identity,
    transform: { inverse: { matrix: identity } },
  });
  source.beginFrame({ views: [view(rawLeft), view(rawRight)] }, renderer, 100);
  assert.equal(source.forEye(left).texture, lt);
  assert.equal(source.forEye(right).texture, rt);
  source.beginFrame(
    { views: [view(rawLeft), { ...view(null) }] },
    renderer,
    101,
  );
  assert.equal(
    source.forEye(left),
    null,
    "partial stereo coverage must disable both eyes",
  );
  assert.equal(
    source.forEye(right),
    null,
    "never reuse a missing eye or substitute left pixels",
  );
  let disposed = false;
  lt.addEventListener("dispose", () => {
    disposed = true;
  });
  source.dispose();
  assert.equal(disposed, false, "Three owns raw external textures");
});

test("mono fallback uploads fresh local frames and rejects stale or stopped camera pixels", (t) => {
  const old = globalThis.document;
  let draws = 0;
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {
          draws++;
        },
      }),
    }),
  };
  t.after(() => {
    globalThis.document = old;
  });
  let frame = { source: {}, width: 1280, height: 960, time: 100 };
  const source = new CameraSource({
    getFrame: () => frame,
    hfov: 80,
  });
  const pose = { views: [], transform: { matrix: identity } };
  source.beginFrame(pose, {}, 110);
  assert.equal(source.mode, "live camera · approximate");
  assert.equal(draws, 1);
  assert.equal(source.forEye({}).texture, source.texture);
  const projection = source.forEye({}).projectionMatrix.elements;
  assert.ok(
    Math.abs(projection[0] - 1 / Math.tan((40 * Math.PI) / 180)) < 1e-6,
  );
  source.beginFrame(pose, {}, 150);
  assert.equal(draws, 1);
  source.beginFrame(pose, {}, 601);
  assert.equal(source.forEye({}), null);
  frame = { ...frame, time: 602 };
  source.beginFrame(pose, {}, 603);
  assert.equal(draws, 2);
  assert.ok(source.forEye({}));
  frame = null;
  source.beginFrame(pose, {}, 604);
  assert.equal(source.forEye({}), null);
  source.dispose();
});

test("raw-only mode never samples the mono camera", () => {
  let calls = 0;
  const source = new CameraSource({
    allowApproximate: false,
    getFrame: () => {
      calls++;
      return {};
    },
  });
  source.beginFrame({ views: [], transform: { matrix: identity } }, {}, 100);
  assert.equal(calls, 0);
  assert.equal(source.forEye({}), null);
  assert.equal(source.mode, "clear · no aligned camera");
});

test("Quest camera pixels use measured lens projection and camera offset", (t) => {
  const old = globalThis.document;
  globalThis.document = { createElement: () => ({
    getContext: () => ({ drawImage() {} }),
  }) };
  t.after(() => { globalThis.document = old; });
  const source = new CameraSource({
    userAgent: "Quest 3 OculusBrowser/152",
    getFrame: () => ({ source: {}, width: 1280, height: 960, time: 100,
      cameraLabel: "camera 2, facing back" }),
  });
  source.beginFrame({ views: [], transform: { matrix: identity } }, {}, 110);
  const camera = source.forEye({});
  assert.equal(camera.calibrated, true);
  assert.ok(Math.abs(camera.projectionMatrix.elements[0] - 2 * 850.61334229 / 1280) < 1e-6);
  const cameraToHead = camera.viewMatrix.clone().invert();
  assert.ok(Math.abs(cameraToHead.elements[12] - 0.03163474) < 1e-6);
  assert.ok(Math.abs(cameraToHead.elements[14] + 0.07452503) < 1e-6);
  source.dispose();
});
