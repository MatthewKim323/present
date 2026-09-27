import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ShaderLib, ShaderChunk, Texture, UniformsUtils, REVISION } from 'three';
import { createFluidGlassMaterial, MeshTransmissionMaterialImpl } from '../src/components/fluid-glass-material.js';

const root = new URL('../src/components/vendor/fluid-glass/', import.meta.url);
const compile = material => {
  const shader = { uniforms: UniformsUtils.clone(ShaderLib.physical.uniforms), defines: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
  material.onBeforeCompile(shader);
  return shader;
};

test('vendored GLSL is byte-identical to pinned actual Drei source', () => {
  const original = readFileSync(new URL('MeshTransmissionMaterial.upstream.tsx', root), 'utf8');
  const vendor = readFileSync(new URL('MeshTransmissionMaterial.js', root), 'utf8');
  const glsl = text => [...text.matchAll(/\/\*glsl\*\/\s*`([\s\S]*?)`/g)].map(match => match[1]);
  assert.equal(glsl(original).length, 3);
  assert.deepEqual(glsl(vendor), glsl(original));
  const digest = createHash('sha256').update(original).digest('hex');
  assert.ok(readFileSync(new URL('PROVENANCE.md', root), 'utf8').includes(digest));
  assert.match(readFileSync(new URL('LICENSE', root), 'utf8'), /MIT License/);
});

test('factory uses real upstream material and React Bits FluidGlass settings', () => {
  const buffer = new Texture();
  const material = createFluidGlassMaterial({ buffer });
  assert.ok(material instanceof MeshTransmissionMaterialImpl);
  assert.equal(material.isMeshPhysicalMaterial, true);
  assert.equal(material.buffer, buffer);
  assert.equal(material.ior, 1.15);
  assert.equal(material.thickness, 5);
  assert.equal(material.anisotropicBlur, .01);
  assert.equal(material.anisotropy, 0);
  assert.equal(material.chromaticAberration, 0);
  assert.equal(material.transmission, 0);
  assert.equal(material._transmission, 1);
  assert.equal(material.transparent, true);
  const replacement = new Texture();
  material.buffer = replacement;
  assert.equal(material.uniforms.buffer.value, replacement);
  material.dispose(); buffer.dispose(); replacement.dispose();
});

test('actual Three physical shader hooks inject refraction and separate alpha coverage', () => {
  assert.equal(REVISION, '186');
  const material = createFluidGlassMaterial({ thickness: .045, samples: 4 });
  const shader = compile(material);
  assert.equal(shader.uniforms.thickness.value, .045);
  assert.equal(shader.defines.USE_TRANSMISSION, '');
  assert.doesNotMatch(shader.fragmentShader, /#include <transmission_pars_fragment>|#include <transmission_fragment>/);
  assert.match(shader.fragmentShader, /vec3 refractionVector = refract\( - v, n, 1.0 \/ ior \)/);
  assert.match(shader.fragmentShader, /i < 4\.0/);
  assert.match(shader.fragmentShader, /if \(chromaticAberration == 0\.0\)/);
  assert.match(shader.fragmentShader, /projectionMatrix \* viewMatrix \* vec4\(vWorldPosition, 1\.0\)/);
  assert.match(shader.fragmentShader, /diffuseColor\.a \*= max\(worldCoverage, worldReflectionCoverage\)/);
  assert.ok(shader.fragmentShader.indexOf('diffuseColor.a *= max') < shader.fragmentShader.indexOf('#include <opaque_fragment>'));
  // Compatibility checks use the installed Three chunks, not copied assumptions.
  assert.match(ShaderChunk.common, /#define inverseTransformDirection/);
  for (const field of ['diffuseColor', 'specularColor', 'transmissionAlpha']) assert.ok(ShaderChunk.lights_physical_pars_fragment.includes(field));
  material.dispose();
});

test('upstream alpha remains opt-in adaptable and shader variants never alias', () => {
  const native = createFluidGlassMaterial({ preserveBufferAlpha: false });
  const covered = createFluidGlassMaterial();
  const fewer = createFluidGlassMaterial({ samples: 2 });
  assert.doesNotMatch(compile(native).fragmentShader, /worldCoverageClip/);
  assert.equal(new Set([native, covered, fewer].map(m => m.customProgramCacheKey())).size, 3);
  for (const material of [native, covered, fewer]) material.dispose();
});

test('rejects invalid physical options before injecting GLSL', () => {
  for (const options of [{buffer:{}}, {thickness:-1}, {thickness:NaN}, {ior:.9}, {ior:Infinity}, {anisotropy:2}, {samples:1.5}, {samples:0}, {samples:17}]) assert.throws(() => createFluidGlassMaterial(options));
});
