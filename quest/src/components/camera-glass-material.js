import {
  Matrix4,
  ShaderMaterial,
  Vector2,
  SRGBColorSpace,
  LinearSRGBColorSpace,
} from "three";

// A camera-image distortion layer, not physically exact passthrough refraction.
// Place behind the transparent text/rim planes. Camera projection is supplied by
// the image source (and may differ from the eye currently rendering the panel).
const vertexShader = `
varying vec2 vPanelUv;
varying vec4 vCaptureClip;
uniform mat4 uCaptureViewProjection;
void main() {
  vPanelUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vCaptureClip = uCaptureViewProjection * world;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = `
precision highp float;
varying vec2 vPanelUv;
varying vec4 vCaptureClip;
uniform sampler2D uCameraTexture;
uniform vec2 uSize;
uniform float uRadius;
uniform float uHasSource;
uniform float uOpacity;
uniform float uStrength;
uniform float uDecodeSRGB;

float roundedBox(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}
float panelDistance(vec2 p) { return roundedBox(p, uSize * 0.5 - 1.5, uRadius); }
bool insideImage(vec2 p) { return all(greaterThanEqual(p, vec2(0.0))) && all(lessThanEqual(p, vec2(1.0))); }

void main() {
  if (uHasSource < 0.5 || uOpacity <= 0.0) discard;
  if (vCaptureClip.w <= 0.00001 || abs(vCaptureClip.z) > vCaptureClip.w) discard;
  // Camera UVs are normalized and bottom-up for both raw XR images and uploaded
  // CanvasTextures. Panel UV only defines the glass shape, never the image fit.
  vec2 cameraUv = vCaptureClip.xy / vCaptureClip.w * 0.5 + 0.5;
  if (!insideImage(cameraUv)) discard;
  vec2 p = (vPanelUv - 0.5) * uSize;
  float distance = panelDistance(p);
  float aa = max(fwidth(distance), 0.5);
  float alpha = 1.0 - smoothstep(-aa, aa, distance);
  if (alpha <= 0.0) discard;
  vec2 normal = vec2(panelDistance(p + vec2(1.0, 0.0)) - panelDistance(p - vec2(1.0, 0.0)),
                     panelDistance(p + vec2(0.0, 1.0)) - panelDistance(p - vec2(0.0, 1.0)));
  normal /= max(length(normal), 0.00001);

  // Derive the capture-image Jacobian from raster derivatives. This transforms
  // a local bevel normal into camera-image direction even on rotated planes.
  vec2 panelDx = dFdx(vPanelUv), panelDy = dFdy(vPanelUv);
  vec2 imageDx = dFdx(cameraUv), imageDy = dFdy(cameraUv);
  float determinant = panelDx.x * panelDy.y - panelDx.y * panelDy.x;
  vec2 direction = vec2(0.0);
  if (abs(determinant) > 0.0000000001) {
    vec2 imageDu = (imageDx * panelDy.y - imageDy * panelDx.y) / determinant;
    vec2 imageDv = (imageDy * panelDx.x - imageDx * panelDy.x) / determinant;
    direction = imageDu * normal.x / uSize.x + imageDv * normal.y / uSize.y;
    direction /= max(length(direction), 0.00001);
  }
  float bevelWidth = min(18.0, min(uSize.x, uSize.y) * 0.09);
  float inset = max(0.0, -distance);
  float bevel = 1.0 - smoothstep(0.0, bevelWidth, inset);
  // Center is compositor passthrough, not a second copy of the room. Fade the
  // sampled strip at both boundaries to avoid a cut-and-paste camera seam.
  float edgeBlend = smoothstep(0.0, max(aa * 2.0, 2.0), inset) * bevel;
  alpha *= edgeBlend;
  if (alpha <= 0.001) discard;
  vec2 sampleUv = cameraUv - direction * uStrength * edgeBlend;
  // Never clamp to a border texel: outside coverage stays genuinely transparent.
  if (!insideImage(sampleUv)) discard;
  vec4 camera = texture2D(uCameraTexture, sampleUv);
  if (uDecodeSRGB > 0.5) camera = sRGBTransferEOTF(camera);
  gl_FragColor = vec4(camera.rgb, alpha * uOpacity);
  #include <colorspace_fragment>
  #include <premultiplied_alpha_fragment>
}
`;

const validMatrix = (matrix) =>
  matrix?.isMatrix4 &&
  matrix.elements.every(Number.isFinite) &&
  Number.isFinite(matrix.determinant()) &&
  matrix.determinant() !== 0;

export function createCameraGlassMaterial(widthPx, heightPx) {
  if (
    ![widthPx, heightPx].every((value) => Number.isFinite(value) && value > 4)
  ) {
    throw new RangeError(
      "Camera glass dimensions must be finite and greater than 4 pixels",
    );
  }
  const material = new ShaderMaterial({
    name: "WorldCameraGlass",
    vertexShader,
    fragmentShader,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    uniforms: {
      uCameraTexture: { value: null },
      uCaptureViewProjection: { value: new Matrix4() },
      uSize: { value: new Vector2(widthPx, heightPx) },
      uRadius: { value: Math.min(24, widthPx / 2 - 1.5, heightPx / 2 - 1.5) },
      uHasSource: { value: 0 },
      uOpacity: { value: 0 },
      uStrength: { value: 0.025 },
      uDecodeSRGB: { value: 1 },
    },
  });
  material.userData.cameraGlass = true;
  return material;
}

/**
 * Source must expose normalized bottom-up UVs. Matrix inputs are Three Matrix4s;
 * viewMatrix maps world coordinates to the camera that captured this image.
 * Ordinary CanvasTextures tagged SRGBColorSpace are hardware-decoded by Three.
 * Raw externally owned RGBA camera textures should retain NoColorSpace: this
 * shader decodes their sRGB bytes. If a native image is already linear/hardware
 * decoded, set texture.userData.cameraGlassDecodeSRGB=false (never mutate the
 * external texture's storage here). Output uses Three's renderer color space,
 * without tone mapping or a second sRGB conversion. This does not own textures.
 */
export function updateCameraGlassMaterial(
  material,
  {
    texture = null,
    projectionMatrix,
    viewMatrix,
    opacity = 1,
    strength = 0.025,
  } = {},
) {
  if (!material?.userData?.cameraGlass)
    throw new TypeError("Expected a material from createCameraGlassMaterial");
  const uniforms = material.uniforms;
  const hasSource =
    !!texture?.isTexture &&
    validMatrix(projectionMatrix) &&
    validMatrix(viewMatrix);
  uniforms.uCameraTexture.value = hasSource ? texture : null;
  uniforms.uHasSource.value = hasSource ? 1 : 0;
  uniforms.uOpacity.value =
    hasSource && Number.isFinite(opacity)
      ? Math.max(0, Math.min(1, opacity))
      : 0;
  uniforms.uStrength.value = Number.isFinite(strength)
    ? Math.max(0, Math.min(0.12, strength))
    : 0.025;
  if (hasSource) {
    uniforms.uCaptureViewProjection.value.multiplyMatrices(
      projectionMatrix,
      viewMatrix,
    );
    const alreadyLinear =
      texture.colorSpace === SRGBColorSpace ||
      texture.colorSpace === LinearSRGBColorSpace;
    uniforms.uDecodeSRGB.value =
      (texture.userData?.cameraGlassDecodeSRGB ?? !alreadyLinear) ? 1 : 0;
  } else {
    uniforms.uCaptureViewProjection.value.identity();
    uniforms.uDecodeSRGB.value = 1;
  }
  return material;
}
