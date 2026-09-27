import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);
const FREE_RAY_LENGTH = 1.5;

// Solid geometry works in stereo WebGL, where wide line primitives do not.
// One beam per targetRaySpace makes either hand/controller usable independently.
export class XrPointers {
  constructor(scene) {
    this.scene = scene;
    this.entries = new Map();
    this.active = new Set();
  }

  begin() {
    this.active.clear();
  }

  update(source, origin, direction, hit, headQuaternion, actionable = false) {
    this.active.add(source);
    let pointer = this.entries.get(source);
    if (!pointer) {
      const material = (opacity) =>
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity,
          depthTest: false,
          depthWrite: false,
        });
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0012, 0.0012, 1, 8),
        material(0.44),
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.0045, 0.006, 24),
        material(0.85),
      );
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.0018, 12),
        material(0.9),
      );
      for (const mesh of [beam, ring, dot]) {
        mesh.renderOrder = 40;
        this.scene.add(mesh);
      }
      pointer = { beam, ring, dot };
      this.entries.set(source, pointer);
    }
    const distance = hit?.distance ?? FREE_RAY_LENGTH;
    const start = Math.min(0.035, distance / 2);
    pointer.beam.position
      .copy(origin)
      .addScaledVector(direction, (start + distance) / 2);
    pointer.beam.quaternion.setFromUnitVectors(UP, direction);
    pointer.beam.scale.set(1, Math.max(0.001, distance - start), 1);
    pointer.beam.material.opacity = hit ? 0.58 : 0.3;
    // The endpoint remains visible with no panel hit, so aiming is discoverable.
    pointer.ring.position
      .copy(origin)
      .addScaledVector(direction, Math.max(0, distance - 0.002));
    pointer.ring.quaternion.copy(headQuaternion);
    pointer.ring.material.opacity = hit ? (actionable ? 1 : 0.65) : 0.35;
    pointer.ring.scale.setScalar(actionable ? 1.25 : 1);
    pointer.dot.position.copy(pointer.ring.position);
    pointer.dot.quaternion.copy(headQuaternion);
    pointer.dot.material.opacity = hit ? 0.95 : 0.4;
  }

  end() {
    for (const [source, pointer] of this.entries) {
      if (this.active.has(source)) continue;
      for (const mesh of [pointer.beam, pointer.ring, pointer.dot]) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      this.entries.delete(source);
    }
  }

  dispose() {
    this.begin();
    this.end();
  }
}
