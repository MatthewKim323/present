import test from "node:test";
import assert from "node:assert/strict";
import {
  createSpecularMaterial,
  updateSpecularMaterial,
} from "../src/components/specular-material.js";

test("actual Gaussian rim shader uses projected local UVs and premultiplied blending", () => {
  const material = createSpecularMaterial(640, 400);
  assert.equal(material.isShaderMaterial, true);
  assert.match(material.fragmentShader, /float sdRoundedRect/);
  assert.match(material.fragmentShader, /float gaussianLine/);
  assert.match(material.fragmentShader, /vUv \* uSize - uCenter/);
  assert.doesNotMatch(material.fragmentShader, /gl_FragCoord/);
  assert.match(material.vertexShader, /projectionMatrix \* modelViewMatrix/);
  assert.equal(material.premultipliedAlpha, true);
  assert.equal(material.depthWrite, false);
  assert.deepEqual(material.uniforms.uHalfSize.value.toArray(), [318, 198]);
  material.dispose();
});

test("material rejects invalid sizes and clamps ray UVs without NaN uniforms", () => {
  for (const size of [0, -1, 4, NaN, Infinity, "400"]) {
    assert.throws(() => createSpecularMaterial(size, 400), RangeError);
    assert.throws(() => createSpecularMaterial(400, size), RangeError);
  }
  const material = createSpecularMaterial(640, 400);
  const rest = material.uniforms.uAngle.value;
  updateSpecularMaterial(material, { hoverUv: { x: 50, y: -50 } });
  assert.ok(Math.abs(material.uniforms.uAngle.value - (rest + 0.15)) < 1e-10);
  assert.equal(material.uniforms.uIntensity.value, 1.15);
  updateSpecularMaterial(material, { hoverUv: { x: NaN, y: 0 } });
  assert.ok(Math.abs(material.uniforms.uAngle.value - rest) < 1e-10);
  assert.ok(Math.abs(material.uniforms.uIntensity.value - 0.65) < 1e-10);
  material.dispose();
});

test("resting light stays fixed and reduced motion provides immediate focus feedback", () => {
  const material = createSpecularMaterial(640, 400);
  const rest = material.uniforms.uAngle.value;
  updateSpecularMaterial(material, { time: 0 });
  updateSpecularMaterial(material, { time: 10000 });
  assert.equal(material.uniforms.uAngle.value, rest);
  updateSpecularMaterial(material, { hoverUv: [1, 1], time: 10016 });
  assert.ok(material.uniforms.uAngle.value > rest);
  assert.ok(
    material.uniforms.uIntensity.value > 0.65 &&
      material.uniforms.uIntensity.value < 1.15,
  );
  updateSpecularMaterial(material, {
    hoverUv: [1, 1],
    reducedMotion: true,
    time: 10032,
  });
  assert.ok(Math.abs(material.uniforms.uAngle.value - rest) < 1e-10);
  assert.equal(material.uniforms.uIntensity.value, 1.15);
  updateSpecularMaterial(material, { reducedMotion: true });
  assert.ok(Math.abs(material.uniforms.uIntensity.value - 0.65) < 1e-10);
  material.dispose();
});

test("incident light steers glass reflections without pointer input", () => {
  const material = createSpecularMaterial(320, 240);
  updateSpecularMaterial(material, { lightAngle: 0.7 });
  assert.ok(Math.abs(material.uniforms.uAngle.value - 0.7) < 1e-9);
  updateSpecularMaterial(material, { lightAngle: NaN });
  assert.ok(Number.isFinite(material.uniforms.uAngle.value));
  updateSpecularMaterial(material, { lightAngle: 2, reducedMotion: true });
  assert.ok(
    Math.abs(
      material.uniforms.uAngle.value - material.userData.specular.restingAngle,
    ) < 1e-9,
  );
  material.dispose();
});


test("XR fragment is verbatim React Bits shading with only host-coordinate substitutions", async () => {
  const { SPECULAR_BUTTON_FRAGMENT: original } = await import('../src/components/reactbits/specular-button-fragment.js');
  const m = createSpecularMaterial(320, 240);
  const expected = original.replace('#version 300 es\n', '')
    .replace('precision highp float;', 'precision highp float;\nvarying vec2 vUv;\nuniform vec2 uSize;')
    .replace('out vec4 fragColor;', '')
    .replace('gl_FragCoord.xy', 'vUv * uSize')
    .replace('fragColor =', 'gl_FragColor =');
  assert.equal(m.fragmentShader, expected);
  assert.doesNotMatch(m.fragmentShader, /softbox|innerEdge|sheen/);
  m.dispose();
});
