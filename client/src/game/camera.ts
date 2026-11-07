import * as THREE from 'three';
import { clamp, damp } from '../util/math.ts';
import type { Input } from './input.ts';

/** Third-person orbit camera: drag (mouse/touch) or Q/E to orbit, wheel to zoom. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  private pitch = 0.22;
  private dist = 3.2;
  private tYaw = 0;
  private tPitch = 0.22;
  private tDist = 3.2;
  private readonly target = new THREE.Vector3(0, 0.58, 12);
  private readonly want = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.05, 600);
    let drag: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.tYaw -= (e.clientX - drag.x) * 0.006;
      this.tPitch = clamp(this.tPitch + (e.clientY - drag.y) * 0.004, -0.05, 1.25);
      drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => { drag = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.tDist = clamp(this.tDist * (1 + e.deltaY * 0.0012), 1.4, 14); }, { passive: false });
  }

  snapTo(p: THREE.Vector3): void { this.target.set(p.x, 0.58, p.z); }

  update(dt: number, input: Input, focus: THREE.Vector3, height: number, groundHeight: (x: number, z: number) => number): void {
    if (input.down('KeyQ')) this.tYaw += 1.8 * dt;
    if (input.down('KeyE')) this.tYaw -= 1.8 * dt;
    this.yaw = damp(this.yaw, this.tYaw, 10, dt);
    this.pitch = damp(this.pitch, this.tPitch, 10, dt);
    this.dist = damp(this.dist, this.tDist, 8, dt);
    this.target.lerp(this.want.set(focus.x, 0.58 + height * 0.5, focus.z), 1 - Math.exp(-8 * dt));
    const cp = Math.cos(this.pitch), c = this.camera;
    c.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    c.position.y = Math.max(c.position.y, groundHeight(c.position.x, c.position.z) + 0.25);
    c.lookAt(this.target);
  }

  resize(): void { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }
}
