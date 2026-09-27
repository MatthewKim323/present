import test from "node:test";
import assert from "node:assert/strict";
import {
  Matrix4,
  PerspectiveCamera,
  Texture,
  Vector4,
  SRGBColorSpace,
  LinearSRGBColorSpace,
} from "three";
import {
  createCameraGlassMaterial,
  updateCameraGlassMaterial,
} from "../src/components/camera-glass-material.js";

const uvFor = (material, point) => {
  const clip = new Vector4(...point, 1).applyMatrix4(
    material.uniforms.uCaptureViewProjection.value,
  );
  if (clip.w <= 0 || Math.abs(clip.z) > clip.w) return null;
  return [(clip.x / clip.w) * 0.5 + 0.5, (clip.y / clip.w) * 0.5 + 0.5];
};

test("camera sampling projects world points through capture pose, not card UV", () => {
  const material = createCameraGlassMaterial(640, 400);
  const capture = new PerspectiveCamera(90, 2, 0.1, 100);
  capture.position.set(2, 1, 0);
  capture.updateMatrixWorld();
  updateCameraGlassMaterial(material, {
    texture: new Texture(),
    projectionMatrix: capture.projectionMatrix,
    viewMatrix: capture.matrixWorldInverse,
  });
  assert.deepEqual(uvFor(material, [2, 1, -2]), [0.5, 0.5]);
  const topRight = uvFor(material, [4, 2, -2]);
  assert.ok(Math.abs(topRight[0] - 0.75) < 1e-9);
  assert.ok(Math.abs(topRight[1] - 0.75) < 1e-9);
  assert.equal(uvFor(material, [2, 1, 2]), null);
  capture.position.x = 20;
  capture.updateMatrixWorld();
  // Inputs are copied so a subsequently moving camera cannot silently change a frame.
  assert.deepEqual(uvFor(material, [2, 1, -2]), [0.5, 0.5]);
  assert.match(material.vertexShader, /uCaptureViewProjection \* world/);
  assert.match(
    material.fragmentShader,
    /texture2D\(uCameraTexture, sampleUv\)/,
  );
  assert.doesNotMatch(
    material.fragmentShader,
    /texture2D\(uCameraTexture, vPanelUv\)/,
  );
  material.dispose();
});

test("missing, invalid, or cleared camera state leaves no stale camera image", () => {
  const material = createCameraGlassMaterial(400, 300);
  const texture = new Texture(),
    projectionMatrix = new Matrix4(),
    viewMatrix = new Matrix4();
  updateCameraGlassMaterial(material, {
    texture,
    projectionMatrix,
    viewMatrix,
  });
  assert.equal(material.uniforms.uHasSource.value, 1);
  updateCameraGlassMaterial(material);
  assert.equal(material.uniforms.uHasSource.value, 0);
  assert.equal(material.uniforms.uOpacity.value, 0);
  assert.equal(material.uniforms.uCameraTexture.value, null);
  const invalid = new Matrix4();
  invalid.elements[3] = NaN;
  for (const matrix of [invalid, {}, new Matrix4().makeScale(0, 1, 1)]) {
    updateCameraGlassMaterial(material, {
      texture,
      projectionMatrix: matrix,
      viewMatrix,
    });
    assert.equal(material.uniforms.uHasSource.value, 0);
    assert.ok(
      material.uniforms.uCaptureViewProjection.value.elements.every(
        Number.isFinite,
      ),
    );
  }
  material.dispose();
});

test("validates sizes and bounds opacity/refraction without nonfinite uniforms", () => {
  for (const bad of [0, 4, -1, NaN, Infinity, "640"]) {
    assert.throws(() => createCameraGlassMaterial(bad, 400), RangeError);
    assert.throws(() => createCameraGlassMaterial(400, bad), RangeError);
  }
  const material = createCameraGlassMaterial(640, 400);
  const source = {
    texture: new Texture(),
    projectionMatrix: new Matrix4(),
    viewMatrix: new Matrix4(),
  };
  updateCameraGlassMaterial(material, { ...source, opacity: 50, strength: 8 });
  assert.equal(material.uniforms.uOpacity.value, 1);
  assert.equal(material.uniforms.uStrength.value, 0.12);
  updateCameraGlassMaterial(material, {
    ...source,
    opacity: NaN,
    strength: Infinity,
  });
  assert.equal(material.uniforms.uOpacity.value, 0);
  assert.equal(material.uniforms.uStrength.value, 0.025);
  material.dispose();
});

test("raw camera bytes decode once; uploaded sRGB and linear sources avoid double decoding", () => {
  const material = createCameraGlassMaterial(640, 400);
  const texture = new Texture(),
    projectionMatrix = new Matrix4(),
    viewMatrix = new Matrix4();
  const update = () =>
    updateCameraGlassMaterial(material, {
      texture,
      projectionMatrix,
      viewMatrix,
    });
  update();
  assert.equal(material.uniforms.uDecodeSRGB.value, 1);
  texture.colorSpace = SRGBColorSpace;
  update();
  assert.equal(material.uniforms.uDecodeSRGB.value, 0);
  texture.colorSpace = LinearSRGBColorSpace;
  update();
  assert.equal(material.uniforms.uDecodeSRGB.value, 0);
  texture.userData = { cameraGlassDecodeSRGB: true };
  update();
  assert.equal(material.uniforms.uDecodeSRGB.value, 1);
  assert.equal(material.toneMapped, false);
  assert.equal(material.premultipliedAlpha, true);
  assert.match(material.fragmentShader, /#include <colorspace_fragment>/);
  assert.match(
    material.fragmentShader,
    /if \(!insideImage\(sampleUv\)\) discard/,
  );
  material.dispose();
});
