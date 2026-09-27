import { ShaderMaterial, Vector2, Vector3 } from "three";

import { SPECULAR_BUTTON_FRAGMENT } from "./reactbits/specular-button-fragment.js";

// Only the host interface changes: GLSL version/output syntax and local plane
// coordinates instead of fullscreen framebuffer coordinates. Every shading
// equation remains verbatim upstream. Camera refraction is a separate material.
export function adaptSpecularFragmentForXR(source = SPECULAR_BUTTON_FRAGMENT) {
  return source
    .replace("#version 300 es\n", "")
    .replace("precision highp float;", "precision highp float;\nvarying vec2 vUv;\nuniform vec2 uSize;")
    .replace("out vec4 fragColor;", "")
    .replace("gl_FragCoord.xy", "vUv * uSize")
    .replace("fragColor =", "gl_FragColor =");
}

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = adaptSpecularFragmentForXR();

const REST_INTENSITY = 0.65;
const FOCUS_INTENSITY = 1.15;
const INSET = 2;

/** Pixel dimensions describe the plane's entire UV surface, including its rim. */
export function createSpecularMaterial(widthPx, heightPx) {
  if (![widthPx, heightPx].every((n) => Number.isFinite(n) && n > INSET * 2)) {
    throw new RangeError(
      "Specular material dimensions must be finite and greater than 4 pixels",
    );
  }
  const restingAngle = Math.atan2(2 / heightPx, -2 / widthPx);
  const material = new ShaderMaterial({
    name: "ReactBitsSpecularGlass",
    vertexShader,
    fragmentShader,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    uniforms: {
      uSize: { value: new Vector2(widthPx, heightPx) },
      uCenter: { value: new Vector2(widthPx / 2, heightPx / 2) },
      uHalfSize: {
        value: new Vector2(widthPx / 2 - INSET, heightPx / 2 - INSET),
      },
      uRadius: {
        value: Math.min(24, widthPx / 2 - INSET, heightPx / 2 - INSET),
      },
      uAngle: { value: restingAngle },
      uPx: { value: 1 },
      uLineColor: { value: new Vector3(1, 1, 1) },
      uBaseColor: { value: new Vector3(0.32, 0.32, 0.32) },
      uIntensity: { value: REST_INTENSITY },
      uShineSize: { value: (10 * Math.PI) / 180 },
      uShineFade: { value: (40 * Math.PI) / 180 },
      uThickness: { value: 1 },
      uBaseWidth: { value: 1 },
    },
  });
  material.userData.specular = { restingAngle, lastTime: null };
  return material;
}

/**
 * hoverUv is the ray intersection's normalized plane UV ({x,y} or [x,y]).
 * time is the XR animation-frame timestamp in milliseconds. Without a timestamp,
 * updates settle immediately. No idle sweep; reduced motion changes only light.
 */
export function updateSpecularMaterial(
  material,
  { hoverUv = null, time, reducedMotion = false, lightAngle } = {},
) {
  const state = material?.userData?.specular;
  if (!state)
    throw new TypeError("Expected a material from createSpecularMaterial");
  const rawX = Array.isArray(hoverUv) ? hoverUv[0] : hoverUv?.x;
  const rawY = Array.isArray(hoverUv) ? hoverUv[1] : hoverUv?.y;
  const focused = Number.isFinite(rawX) && Number.isFinite(rawY);
  const clamp = (n) => Math.min(1, Math.max(0, n));
  // This is upstream's over-button diagonal steering, using native bottom-up UVs.
  const targetAngle =
    (Number.isFinite(lightAngle) && !reducedMotion
      ? lightAngle
      : state.restingAngle) +
    (focused && !reducedMotion
      ? (clamp(rawX) * 2 - 1) * 0.3 + (clamp(rawY) * 2 - 1) * 0.15
      : 0);
  const targetIntensity = focused ? FOCUS_INTENSITY : REST_INTENSITY;
  const hasTime = Number.isFinite(time);
  const dt =
    hasTime && state.lastTime !== null
      ? Math.min(Math.max((time - state.lastTime) / 1000, 0), 0.05)
      : null;
  const angleT = reducedMotion || dt === null ? 1 : 1 - Math.exp(-dt * 7);
  const brightT = reducedMotion || dt === null ? 1 : 1 - Math.exp(-dt * 8);
  const uniforms = material.uniforms;
  const diff =
    ((targetAngle - uniforms.uAngle.value + Math.PI * 3) % (Math.PI * 2)) -
    Math.PI;
  uniforms.uAngle.value += diff * angleT;
  uniforms.uIntensity.value +=
    (targetIntensity - uniforms.uIntensity.value) * brightT;
  state.lastTime = hasTime ? time : null;
  return material;
}
