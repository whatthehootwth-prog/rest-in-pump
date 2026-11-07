import * as THREE from 'three';
import { MAX_SPEED, type PlayerState } from '../../../shared/protocol.ts';
import { clamp, damp, lerpAngle } from '../util/math.ts';
import { resolveCollisions, type Colliders } from '../world/collision.ts';
import type { Input } from './input.ts';
import type { Owl } from '../owl/owl.ts';

const WALK_SPEED = 1.8;
const RUN_SPEED = MAX_SPEED;
const RADIUS = 0.3;
const HOP_VELOCITY = 4.8;
const GRAVITY = 12.5;

/** The player's own owl: reads input, moves with collisions, animates, and reports its state for the network. */
export class LocalPlayer {
  readonly pos = new THREE.Vector3(0, 0, 12);
  yaw = 0;
  speed = 0;
  private readonly dir = new THREE.Vector3(0, 0, 1);
  private y = 0;
  private vy = 0;
  private grounded = true;
  private phase = 0;
  private land = 0;
  private readonly fwd = new THREE.Vector3();
  private readonly rgt = new THREE.Vector3();
  private readonly mv = new THREE.Vector3();
  readonly owl: Owl;

  constructor(owl: Owl) { this.owl = owl; }

  /** Puts the owl somewhere (spawn, room change, server correction). */
  place(s: Pick<PlayerState, 'x' | 'y' | 'z' | 'yaw'>): void {
    this.pos.set(s.x, 0, s.z);
    this.y = 0; this.vy = 0; this.grounded = true; this.speed = 0;
    this.yaw = s.yaw;
  }

  update(dt: number, t: number, input: Input, cameraYaw: number, colliders: Colliders): void {
    this.fwd.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
    this.rgt.set(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
    const iz = (input.down('ArrowUp', 'KeyW') ? 1 : 0) - (input.down('ArrowDown', 'KeyS') ? 1 : 0);
    const ix = (input.down('ArrowRight', 'KeyD') ? 1 : 0) - (input.down('ArrowLeft', 'KeyA') ? 1 : 0);
    this.mv.set(0, 0, 0).addScaledVector(this.fwd, iz).addScaledVector(this.rgt, ix);
    const moving = this.mv.lengthSq() > 0;
    const running = input.down('ShiftLeft', 'ShiftRight');
    if (moving) {
      this.mv.normalize(); this.dir.copy(this.mv);
      this.yaw = lerpAngle(this.yaw, Math.atan2(this.mv.x, this.mv.z), 1 - Math.exp(-11 * dt));
    }
    this.speed = damp(this.speed, moving ? (running ? RUN_SPEED : WALK_SPEED) : 0, moving ? 7 : 10, dt);
    this.pos.addScaledVector(this.dir, this.speed * dt);
    resolveCollisions(this.pos, RADIUS, colliders);

    if (input.down('Space') && this.grounded) { this.vy = HOP_VELOCITY; this.grounded = false; }
    if (!this.grounded) {
      this.vy -= GRAVITY * dt; this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; this.grounded = true; this.land = 1; }
    }
    this.land = damp(this.land, 0, 9, dt);

    this.owl.root.position.set(this.pos.x, this.y, this.pos.z);
    this.owl.root.rotation.y = this.yaw;
    if (this.grounded) this.phase += this.speed * dt * 8;
    this.owl.animate(dt, t, { speed: this.speed, phase: this.phase, air: !this.grounded, vy: this.vy, land: this.land });
  }

  get height(): number { return this.y; }

  state(): PlayerState {
    return {
      x: this.pos.x, y: clamp(this.y, 0, 2), z: this.pos.z, yaw: this.yaw,
      speed: this.speed < 0.02 ? 0 : this.speed, air: !this.grounded, walk: this.owl.walk,
    };
  }
}
