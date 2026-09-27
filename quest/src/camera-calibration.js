import { Matrix4, Quaternion, Vector3 } from "three";

// Unit-specific calibration read from the attached Quest 3S Camera2 metadata
// (dumpsys media.camera, 2026-09-27). This is a local demo profile, not a
// universal Quest calibration: browser UA cannot distinguish every Quest model.
// poseReference is GYROSCOPE; treating it as the WebXR viewer origin remains an
// approximation. This corrects measured optics/camera offset, not scene depth
// or passthrough's own reconstruction and latency.
export const QUEST_3S_LOCAL_PROFILE = {
  id: "local-quest-3s-2026-09-27",
  sensorWidth: 1280,
  sensorHeight: 1280,
  cameras: {
    1: {
      cameraId: "50",
      intrinsics: [851.86846924, 851.86846924, 638.02752686, 640.92468262],
      rotation: [-0.99846047, 0.00040285, -0.00167968, 0.0554405],
      translation: [-0.03208053, -0.01248248, -0.07489429],
    },
    2: {
      cameraId: "51",
      intrinsics: [850.61334229, 850.61334229, 639.41174316, 639.93048096],
      rotation: [-0.99864888, 0.00266368, 0.00166485, 0.05187009],
      translation: [0.03163474, -0.01252988, -0.07452503],
    },
  },
};

// frame dimensions are the actual delivered video size, before texture resize.
// Browser streams are assumed to be centered aspect crops of the active sensor.
// Unknown labels/devices deliberately return null rather than applying the wrong
// physical camera's extrinsics to a stream.
export function calibratedCamera(frame, userAgent = "") {
  if (!/OculusBrowser/i.test(userAgent) || !/Quest/i.test(userAgent)) return null;
  const match = /^camera ([12]), facing back$/i.exec(frame?.cameraLabel || "");
  if (
    !match ||
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) return null;

  const profile = QUEST_3S_LOCAL_PROFILE;
  const camera = profile.cameras[match[1]];
  const aspect = frame.width / frame.height;
  const cropWidth = Math.min(profile.sensorWidth, profile.sensorHeight * aspect);
  const cropHeight = Math.min(profile.sensorHeight, profile.sensorWidth / aspect);
  const cropX = (profile.sensorWidth - cropWidth) / 2;
  const cropY = (profile.sensorHeight - cropHeight) / 2;
  const sx = frame.width / cropWidth;
  const sy = frame.height / cropHeight;
  const [sensorFx, sensorFy, sensorCx, sensorCy] = camera.intrinsics;
  const fx = sensorFx * sx;
  const fy = sensorFy * sy;
  const cx = (sensorCx - cropX) * sx;
  const cy = (sensorCy - cropY) * sy;
  const near = 0.01;
  const far = 1000;
  const projectionMatrix = new Matrix4().makePerspective(
    (-cx * near) / fx,
    ((frame.width - cx) * near) / fx,
    (cy * near) / fy,
    (-(frame.height - cy) * near) / fy,
    near,
    far,
  );

  // Android optical axes: right/down/forward. Three camera: right/up/back.
  // Compose the axes conversion in camera-local coordinates, then the measured
  // optical-to-head quaternion. Translations are already in head coordinates.
  const rotation = new Quaternion().fromArray(camera.rotation).normalize();
  rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI));
  const cameraToHead = new Matrix4().compose(
    new Vector3().fromArray(camera.translation),
    rotation,
    new Vector3(1, 1, 1),
  );
  return {
    projectionMatrix,
    cameraToHead,
    profile: profile.id,
    cameraId: camera.cameraId,
    intrinsics: { fx, fy, cx, cy },
    crop: { x: cropX, y: cropY, width: cropWidth, height: cropHeight },
  };
}
