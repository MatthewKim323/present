import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createFluidGlassMaterial } from "./components/fluid-glass-material.js";
import { createPassthroughGlassMaterial } from "./components/passthrough-glass-material.js";

// A mono headset camera has a different FOV and pose from either XR eye.
// Reproject onto a plane two metres away rather than stretching its pixels to
// the eye viewport. Raw XR camera textures bypass this approximation entirely.
export function createProjectedCameraBackground() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      cameraImage: { value: null },
      cameraPresent: { value: 1 },
      opaqueOutside: { value: 0 },
      alignedCamera: { value: 0 },
      eyeProjectionInverse: { value: new THREE.Matrix4() },
      captureFromEye: { value: new THREE.Matrix4() },
      projectionDepth: { value: 2 },
    },
    vertexShader: `
      varying vec2 imageUv;
      void main() {
        imageUv = uv;
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D cameraImage;
      uniform float cameraPresent;
      uniform float opaqueOutside;
      uniform float alignedCamera;
      uniform mat4 eyeProjectionInverse;
      uniform mat4 captureFromEye;
      uniform float projectionDepth;
      varying vec2 imageUv;
      void main() {
        if (cameraPresent < 0.5) discard;
        if (alignedCamera > 0.5) {
          gl_FragColor = texture2D(cameraImage, imageUv);
        } else {
        vec4 eyeRay = eyeProjectionInverse * vec4(imageUv * 2.0 - 1.0, 1.0, 1.0);
        vec3 direction = eyeRay.xyz / eyeRay.w;
        vec3 eyePoint = direction * (projectionDepth / max(-direction.z, 0.00001));
        vec4 captureClip = captureFromEye * vec4(eyePoint, 1.0);
        vec2 uv = captureClip.xy / max(captureClip.w, 0.00001) * 0.5 + 0.5;
        if (captureClip.w <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
          if (opaqueOutside > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          discard;
        }
        gl_FragColor = texture2D(cameraImage, uv);
        }
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

export function setProjectedCameraSource(mesh, source, eye) {
  const uniforms = mesh.material.uniforms;
  uniforms.cameraPresent.value = source?.texture ? 1 : 0;
  if (!source?.texture) return;
  uniforms.cameraImage.value = source.texture;
  uniforms.alignedCamera.value = source.aligned === true ? 1 : 0;
  if (source.aligned === true) return;
  uniforms.eyeProjectionInverse.value.copy(eye.projectionMatrixInverse);
  uniforms.captureFromEye.value
    .copy(source.projectionMatrix)
    .multiply(source.viewMatrix)
    .multiply(eye.matrixWorld);
}

// React Bits FluidGlass ModeWrapper, adapted from React useFBO/createPortal to
// the existing native WebXR renderer. Same bar asset and transmission material.
// https://reactbits.dev/r/FluidGlass-JS-CSS
// One render target per eye is essential: the upstream desktop FBO is mono.
export class FluidGlassPass {
  static async create(renderer, scene, { nativePassthrough = false } = {}) {
    const model = await new GLTFLoader().loadAsync("/fluidglass/bar.glb");
    let source;
    model.scene.traverse((object) => {
      if (object.isMesh && (!source || object.name === "Cube")) source = object;
    });
    if (!source) throw new Error("FluidGlass bar geometry is missing");
    const geometry = source.geometry.clone();
    geometry.rotateX(Math.PI / 2);
    geometry.center();
    geometry.computeBoundingBox();
    const size = geometry.boundingBox.getSize(new THREE.Vector3());
    geometry.scale(1 / size.x, 1 / size.y, 1 / size.z);
    model.scene.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material))
        object.material.forEach((m) => m.dispose());
      else object.material?.dispose();
    });
    return new FluidGlassPass(renderer, scene, geometry, { nativePassthrough });
  }

  constructor(renderer, scene, geometry, { nativePassthrough = false } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.geometry = geometry;
    this.nativePassthrough = nativePassthrough;
    this.panels = new Set();
    this.targets = new Map();
    this.cameraBackground = createProjectedCameraBackground();
    this.savedEnvironment = scene.environment;
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromScene(room);
    room.dispose();
    pmrem.dispose();
    scene.environment = this.environment.texture;
  }

  createPanel(width, height) {
    const material = this.nativePassthrough
      ? createPassthroughGlassMaterial(this.environment.texture)
      : createFluidGlassMaterial({ thickness: 0.045, samples: 6 });
    if (!this.nativePassthrough) {
      material.envMap = this.environment.texture;
      material.envMapIntensity = 1.2;
    }
    material.depthWrite = false;
    material.depthTest = false;
    const mesh = new THREE.Mesh(this.geometry.clone(), material);
    this.resizePanel(mesh, width, height);
    mesh.onBeforeRender = (_renderer, _scene, eye) => {
      if (!this.nativePassthrough) material.buffer = this.targets.get(eye)?.texture || null;
      material.opacity = mesh.parent?.material?.opacity ?? 1;
    };
    material.addEventListener("dispose", () => this.panels.delete(mesh));
    this.panels.add(mesh);
    return mesh;
  }

  resizePanel(mesh, width, height) {
    // Bake physical dimensions into vertices: upstream thickness is multiplied
    // by model scale in GLSL, so nonuniform slab scale would distort refraction.
    mesh.geometry.dispose();
    mesh.geometry = this.geometry.clone();
    mesh.geometry.scale(width, height, 0.018);
    mesh.geometry.computeBoundingBox();
  }

  render(cameraSource, camera, { cameraRoom = false } = {}) {
    // Quest composites its own passthrough after WebGL. A second camera image
    // cannot register to that image, so native panels stay nearly clear.
    if (this.nativePassthrough) return;
    // Keep projected camera rendering available for synthetic GPU fixtures.
    if (cameraRoom && cameraSource) {
      this.roomBackground ||= createProjectedCameraBackground();
      this.roomBackground.material.uniforms.opaqueOutside.value = 1;
      this.roomBackground.onBeforeRender = (_renderer, _scene, eye) => {
        setProjectedCameraSource(this.roomBackground, cameraSource.forEye(eye), eye);
        this.roomBackground.material.uniformsNeedUpdate = true;
      };
      this.scene.add(this.roomBackground);
    } else this.roomBackground?.removeFromParent();
    if (!this.panels.size) return;
    const renderer = this.renderer;
    // WebXRManager updates eye-local matrices before the animation callback,
    // but refreshes matrixWorld only in renderer.render(). Our offscreen pass
    // runs first, so explicitly sync now or it samples the previous head pose.
    if (renderer.xr.enabled) renderer.xr.updateCamera?.(camera);
    const eyes = renderer.xr.enabled
      ? renderer.xr.getCamera().cameras
      : [camera];
    const keep = new Set(eyes);
    for (const [eye, target] of this.targets)
      if (!keep.has(eye)) {
        target.dispose();
        this.targets.delete(eye);
      }
    const wasXR = renderer.xr.enabled;
    const oldTarget = renderer.getRenderTarget();
    const oldBackground = this.scene.background;
    const oldColor = renderer.getClearColor(new THREE.Color());
    const oldAlpha = renderer.getClearAlpha();
    const oldViewport = renderer.getViewport(new THREE.Vector4());
    const hidden = new Map();
    if (this.roomBackground) {
      hidden.set(this.roomBackground, this.roomBackground.visible);
      this.roomBackground.visible = false;
    }
    for (const panel of this.panels) {
      const object =
        panel.parent && panel.parent !== this.scene ? panel.parent : panel;
      hidden.set(object, object.visible);
      object.visible = false;
    }
    this.scene.traverse((object) => {
      if (object.renderOrder >= 30) {
        hidden.set(object, object.visible);
        object.visible = false;
      }
    });
    try {
      renderer.xr.enabled = false;
      renderer.setClearColor(0x000000, 0);
      for (const eye of eyes) {
        const aspect = eye.viewport
          ? eye.viewport.z / eye.viewport.w
          : eye.aspect || 1;
        const width = 768,
          height = Math.max(1, Math.round(width / aspect));
        let target = this.targets.get(eye);
        if (!target) {
          target = new THREE.WebGLRenderTarget(width, height, {
            type: THREE.HalfFloatType,
          });
          this.targets.set(eye, target);
        } else if (target.width !== width || target.height !== height)
          target.setSize(width, height);
        const captureEye = eye.clone();
        // Do not use XR atlas viewport offsets while rendering a single eye FBO.
        delete captureEye.viewport;
        captureEye.matrixAutoUpdate = false;
        captureEye.matrix.copy(eye.matrixWorld);
        captureEye.matrixWorld.copy(eye.matrixWorld);
        captureEye.matrixWorldInverse.copy(eye.matrixWorldInverse);
        captureEye.projectionMatrix.copy(eye.projectionMatrix);
        captureEye.projectionMatrixInverse.copy(eye.projectionMatrixInverse);
        const source = cameraSource?.forEye(eye);
        if (source?.aligned === false && source.projectionMatrix && source.viewMatrix) {
          this.cameraBackground ||= createProjectedCameraBackground();
          setProjectedCameraSource(this.cameraBackground, source, captureEye);
          this.scene.add(this.cameraBackground);
          this.scene.background = null;
        } else {
          this.cameraBackground?.removeFromParent();
          this.scene.background = source?.texture || oldBackground;
        }
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(this.scene, captureEye);
      }
    } finally {
      this.cameraBackground?.removeFromParent();
      this.scene.background = oldBackground;
      for (const [object, visible] of hidden) object.visible = visible;
      renderer.setRenderTarget(oldTarget);
      renderer.setViewport(oldViewport);
      renderer.setClearColor(oldColor, oldAlpha);
      renderer.xr.enabled = wasXR;
    }
  }

  dispose() {
    for (const target of this.targets.values()) target.dispose();
    this.targets.clear();
    this.panels.clear();
    this.roomBackground?.removeFromParent();
    this.roomBackground?.geometry.dispose();
    this.roomBackground?.material.dispose();
    this.cameraBackground?.removeFromParent();
    this.cameraBackground?.geometry.dispose();
    this.cameraBackground?.material.dispose();
    this.geometry.dispose();
    this.environment.dispose();
    this.scene.environment = this.savedEnvironment;
  }
}
