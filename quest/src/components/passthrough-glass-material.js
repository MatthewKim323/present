import * as THREE from "three";

// WebXR passthrough is composited after our WebGL frame. Its pixels are not in
// the framebuffer, so sampling a second camera here creates a misregistered
// copy of the room. Keep the interior almost clear and shade only the surface.
export function createPassthroughGlassMaterial(environment) {
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    envMap: environment,
    envMapIntensity: 1.5,
    metalness: 0,
    roughness: 0.035,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  material.name = "CompositorPassthroughGlass";
  material.onBeforeCompile = (shader) => {
    if (!shader.fragmentShader.includes("#include <opaque_fragment>"))
      throw new Error("Three opaque_fragment hook unavailable for passthrough glass");
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `
      float worldFacing = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
      float worldRim = pow(1.0 - worldFacing, 3.0);
      diffuseColor.a *= 0.018 + 0.24 * worldRim;
      #include <opaque_fragment>
      `,
    );
  };
  material.customProgramCacheKey = () => "world-compositor-passthrough-glass-v1";
  return material;
}
