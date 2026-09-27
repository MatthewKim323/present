import { calibratedCamera } from "./camera-calibration.js";
import {
  CanvasTexture,
  LinearFilter,
  Matrix4,
  PerspectiveCamera,
  SRGBColorSpace,
} from "three";

// Raw XR images are view-aligned. getUserMedia is a mono fallback: its FOV and
// capture pose are estimates, not calibrated passthrough/depth reconstruction.
export class CameraSource {
  constructor({
    getFrame = () => null,
    hfov = 80,
    allowApproximate = true,
    userAgent = globalThis.navigator?.userAgent || "",
  } = {}) {
    this.getFrame = getFrame;
    this.userAgent = userAgent;
    this.hfov = hfov;
    this.allowApproximate = allowApproximate;
    this.views = new Map();
    this.mode = "unavailable";
    this.fallback = null;
    this.lastFrame = null;
    this.projection = new PerspectiveCamera();
  }

  beginFrame(pose, renderer, now = performance.now()) {
    this.views.clear();
    this.mode = "unavailable";
    const eyes = renderer.xr?.getCamera?.()?.cameras || [];
    for (let i = 0; i < (pose.views || []).length; i++) {
      const view = pose.views[i];
      const texture =
        view.camera && renderer.xr?.getCameraTexture?.(view.camera);
      if (texture && eyes[i]) {
        this.views.set(eyes[i], {
          texture,
          aligned: true,
          projectionMatrix: new Matrix4().fromArray(view.projectionMatrix),
          viewMatrix: new Matrix4().fromArray(view.transform.inverse.matrix),
        });
      }
    }
    if (
      eyes.length > 0 &&
      this.views.size === eyes.length &&
      this.views.size === (pose.views || []).length
    ) {
      this.mode = "aligned camera";
      // Never substitute a different camera for a missing raw eye.
      this.fallback = null;
      return;
    }
    // Prefer complete raw stereo. Otherwise project the same local camera into
    // both eye buffers; never mix raw and estimated registration across eyes.
    this.views.clear();
    if (!this.allowApproximate) {
      this.fallback = null;
      this.mode = "clear · no aligned camera";
      return;
    }
    const frame = this.getFrame();
    if (
      !frame ||
      !frame.width ||
      !frame.height ||
      !Number.isFinite(frame.time) ||
      now - frame.time > 500
    ) {
      this.fallback = null;
      return;
    }
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.context = this.canvas.getContext("2d", { alpha: false });
      this.texture = new CanvasTexture(this.canvas);
      this.texture.colorSpace = SRGBColorSpace;
      this.texture.minFilter = this.texture.magFilter = LinearFilter;
      this.texture.generateMipmaps = false;
    }
    if (this.lastFrame !== frame.time) {
      const width = Math.min(frame.width, 1280);
      const height = Math.round((width * frame.height) / frame.width);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      try {
        this.context.drawImage(frame.source, 0, 0, width, height);
      } catch {
        this.fallback = null;
        return;
      }
      this.texture.needsUpdate = true;
      this.lastFrame = frame.time;
      const aspect = frame.width / frame.height;
      const hfov = Math.max(20, Math.min(150, this.hfov || 80));
      this.projection.fov =
        (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / aspect) * 180) /
        Math.PI;
      this.projection.aspect = aspect;
      this.projection.updateProjectionMatrix();
      const calibration = calibratedCamera(frame, this.userAgent);
      const cameraToWorld = new Matrix4().fromArray(pose.transform.matrix);
      if (calibration) cameraToWorld.multiply(calibration.cameraToHead);
      const captureView = cameraToWorld.invert();
      this.fallback = {
        texture: this.texture,
        aligned: false,
        projectionMatrix: calibration?.projectionMatrix || this.projection.projectionMatrix.clone(),
        calibrated: !!calibration,
        viewMatrix: captureView,
      };
    }
    // A formerly stale source must not resurrect without a fresh frame.
    if (this.fallback) this.mode = this.fallback.calibrated
      ? "live camera · calibrated lens"
      : "live camera · approximate";
  }

  forEye(camera) {
    return this.views.get(camera) || this.fallback;
  }

  dispose() {
    this.texture?.dispose();
    this.views.clear();
    this.texture = this.canvas = this.context = this.fallback = null;
    this.lastFrame = null;
    this.mode = "unavailable";
  }
}
