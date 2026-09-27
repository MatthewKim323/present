import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import { calibratedCamera, QUEST_3S_LOCAL_PROFILE } from "../src/camera-calibration.js";

const ua = "Mozilla/5.0 (Linux; Android 12; Quest 3) OculusBrowser/42.0.0";
const frame = { cameraLabel: "Camera 1, facing back", width: 1280, height: 960 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("measured intrinsics use the 4:3 center crop and an off-axis principal point", () => {
  const result = calibratedCamera(frame, ua);
  assert.deepEqual(result.crop, { x: 0, y: 160, width: 1280, height: 960 });
  close(result.intrinsics.fx, 851.86846924);
  close(result.intrinsics.cy, 480.92468262);
  const center = new Vector3(0, 0, -1).applyMatrix4(result.projectionMatrix);
  close(center.x, 2 * result.intrinsics.cx / frame.width - 1);
  close(center.y, 1 - 2 * result.intrinsics.cy / frame.height);
  const hfov = 2 * Math.atan(640 / result.intrinsics.fx) * 180 / Math.PI;
  assert.ok(hfov > 73.8 && hfov < 74, `measured horizontal FOV ${hfov}`);
});

test("stream resize preserves rays and portrait aspect crops sensor horizontally", () => {
  const full = calibratedCamera(frame, ua);
  const half = calibratedCamera({ ...frame, width: 640, height: 480 }, ua);
  full.projectionMatrix.elements.forEach((v, i) => close(v, half.projectionMatrix.elements[i]));
  const portrait = calibratedCamera({ ...frame, width: 960, height: 1280 }, ua);
  assert.deepEqual(portrait.crop, { x: 160, y: 0, width: 960, height: 1280 });
  close(portrait.intrinsics.cx, 478.02752686);
});

test("each browser camera gets its own translation and optical-to-Three rotation", () => {
  for (const number of [1, 2]) {
    const result = calibratedCamera({ ...frame, cameraLabel: `Camera ${number}, facing back` }, ua);
    const metadata = QUEST_3S_LOCAL_PROFILE.cameras[number];
    assert.equal(result.cameraId, metadata.cameraId);
    assert.deepEqual(new Vector3().setFromMatrixPosition(result.cameraToHead).toArray(), metadata.translation);
    const forward = new Vector3(0, 0, -1).transformDirection(result.cameraToHead);
    const opticalForward = new Vector3(0, 0, 1).applyQuaternion(new Quaternion().fromArray(metadata.rotation).normalize());
    close(forward.distanceTo(opticalForward), 0);
    assert.ok(forward.z < -0.99, "forward must point into the scene, not behind the viewer");
  }
});

test("unknown cameras and non-Quest browsers never receive the local calibration", () => {
  assert.equal(calibratedCamera(frame, "Chrome"), null);
  assert.equal(calibratedCamera(frame, "OculusBrowser"), null);
  assert.equal(calibratedCamera({ ...frame, cameraLabel: "environment" }, ua), null);
  assert.equal(calibratedCamera({ ...frame, cameraLabel: "Camera 0, facing back" }, ua), null);
  assert.equal(calibratedCamera({ ...frame, width: 0 }, ua), null);
  assert.equal(calibratedCamera({ ...frame, height: NaN }, ua), null);
  assert.equal(calibratedCamera(null, ua), null);
});
