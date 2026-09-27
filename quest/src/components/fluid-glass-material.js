import { MeshTransmissionMaterialImpl } from "./vendor/fluid-glass/MeshTransmissionMaterial.js";

// Host coverage integration only. Refraction, volume transmission, Fresnel,
// anisotropic sampling and BRDF remain the actual upstream Drei implementation.
const bufferCoverage = `
  // WORLD: preserve transparent areas of the eye's scene buffer for passthrough.
  vec4 worldCoverageClip = projectionMatrix * viewMatrix * vec4(vWorldPosition, 1.0);
  float worldCoverage = 0.0;
  if (worldCoverageClip.w > 0.00001) {
    vec2 worldCoverageUv = worldCoverageClip.xy / worldCoverageClip.w * 0.5 + 0.5;
    if (all(greaterThanEqual(worldCoverageUv, vec2(0.0))) && all(lessThanEqual(worldCoverageUv, vec2(1.0)))) {
      worldCoverage = texture2D(buffer, worldCoverageUv).a;
    }
  }
  // Retain a small amount of genuine environment reflection at empty pixels:
  // 1.5% facing the viewer, rising to 6% at grazing angles. No fake background.
  float worldFresnel = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 5.0);
  float worldReflectionCoverage = 0.06 * (0.25 + 0.75 * worldFresnel);
  diffuseColor.a *= max(worldCoverage, worldReflectionCoverage);
`;

/**
 * Actual material behind React Bits FluidGlass, without adding a second R3F
 * renderer. Caller owns the FBO, geometry, environment, source texture and render
 * loop. Render the scene WITHOUT the glass into buffer using the same camera/eye
 * projection as the glass render. Use linear, non-tone-mapped FBO content; let
 * Three perform output conversion once. Set material.buffer for each eye.
 *
 * Defaults match FluidGlass Lens (ior 1.15, thickness 5, anisotropy alias .01),
 * except chromaticAberration is deliberately zero. Thickness uses geometry-local
 * units and upstream multiplies by model scale; for a metre-sized slab without
 * scaled geometry, use thickness .045. No camera source is assumed or stretched.
 *
 * Upstream drops sampled alpha. preserveBufferAlpha adds a separate host adapter
 * with projected buffer coverage and a small reflection floor. It is coverage at
 * the current fragment, not exact refracted-ray alpha or physical passthrough.
 */
export function createFluidGlassMaterial({
  buffer = null,
  thickness = 5,
  ior = 1.15,
  anisotropy = 0.01,
  samples = 6,
  preserveBufferAlpha = true,
} = {}) {
  if (buffer != null && !buffer.isTexture)
    throw new TypeError("FluidGlass buffer must be a Three texture or null");
  if (!Number.isFinite(thickness) || thickness < 0)
    throw new RangeError("FluidGlass thickness must be finite and nonnegative");
  if (!Number.isFinite(ior) || ior < 1 || ior > 2.333)
    throw new RangeError("FluidGlass ior must be between 1 and 2.333");
  if (!Number.isFinite(anisotropy) || anisotropy < 0 || anisotropy > 1)
    throw new RangeError("FluidGlass anisotropy must be between 0 and 1");
  if (!Number.isInteger(samples) || samples < 1 || samples > 16)
    throw new RangeError("FluidGlass samples must be an integer from 1 to 16");
  const material = new MeshTransmissionMaterialImpl(samples, false);
  material.name = "ReactBitsFluidGlass";
  material.buffer = buffer;
  material.thickness = thickness;
  material.ior = ior;
  // This is how Drei's React wrapper maps its legacy anisotropy prop.
  // Do not enable MeshPhysicalMaterial's separate surface-anisotropy feature.
  material.anisotropicBlur = anisotropy;
  material.chromaticAberration = 0;
  material.roughness = 0;
  material._transmission = 1;
  material.transmission = 0; // upstream avoids Three's redundant transmission pass
  material.transparent = true;
  material.depthWrite = false;
  material.toneMapped = false;
  material.color.set("#ffffff");
  material.attenuationColor.set("#ffffff");
  material.userData.fluidGlass = { samples, preserveBufferAlpha };
  const upstreamCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    shader.defines ||= {};
    upstreamCompile(shader, renderer);
    if (preserveBufferAlpha) {
      if (!shader.fragmentShader.includes("#include <opaque_fragment>"))
        throw new Error(
          "Three opaque_fragment hook unavailable for FluidGlass coverage",
        );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <opaque_fragment>",
        bufferCoverage + "\n#include <opaque_fragment>",
      );
    }
  };
  // Upstream captures sample count in its compile closure. Make it explicit in
  // Three's cache key so materials with different sample counts cannot alias.
  material.customProgramCacheKey = () =>
    `world-fluid-glass-v1:${samples}:${preserveBufferAlpha ? "coverage" : "opaque"}`;
  return material;
}

export { MeshTransmissionMaterialImpl };
