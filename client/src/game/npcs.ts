import * as THREE from 'three';
import { PLOTS } from '../../../shared/graves.ts';
import { createOwl, type Owl } from '../owl/owl.ts';
import { damp, lerpAngle } from '../util/math.ts';
import { resolveCollisions, type Colliders } from '../world/collision.ts';
import type { GraveField } from '../world/graves.ts';

/**
 * A few nameless NPC owls that live in the graveyard, purely cosmetic and local to each player's screen.
 * Each one picks something to do, does it for a while, then picks again:
 *   wander     stroll to a random spot
 *   mourn      walk to a grave (a real one if there are any) and cry in front of it
 *   club       walk up to the player and club next to them
 *   hop        bounce around on the spot
 *   roll       roll around on the ground
 */

const RADIUS = 0.3;
const GRAVITY = 12.5;
const HOP_VELOCITY = 4.4;
const WALK = 1.25;
const EMOTE = { dance: 1, club: 2, pray: 3, cry: 4, roll: 5 } as const;

type Kind = 'wander' | 'mourn' | 'club' | 'hop' | 'roll' | 'idle';
interface Npc {
  owl: Owl;
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
  phase: number;
  y: number; vy: number; grounded: boolean; land: number;
  emote: number;
  kind: Kind;
  /** Where it is walking to (null = staying put). */
  target: THREE.Vector3 | null;
  /** Yaw to face once it arrives (e.g. towards the grave). */
  faceYaw: number | null;
  /** When the current activity ends (s). */
  until: number;
  /** Give up walking to the target after this time (stuck behind something). */
  walkUntil: number;
  nextHop: number;
}

const rr = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

export class Npcs {
  private readonly list: Npc[] = [];
  private readonly scene: THREE.Scene;
  private readonly colliders: Colliders;
  private readonly graves: GraveField;

  constructor(scene: THREE.Scene, colliders: Colliders, graves: GraveField, count = 3 + Math.floor(Math.random() * 3)) {
    this.scene = scene; this.colliders = colliders; this.graves = graves;
    for (let i = 0; i < count; i++) {
      const owl = createOwl();
      owl.setWalk(Math.floor(Math.random() * 9));
      const pos = this.randomSpot();
      scene.add(owl.root, owl.blob);
      this.list.push({
        owl, pos, yaw: rr(-Math.PI, Math.PI), speed: 0, phase: rr(0, 10), y: 0, vy: 0, grounded: true, land: 0,
        emote: 0, kind: 'idle', target: null, faceYaw: null, until: rr(0.5, 3), walkUntil: 0, nextHop: 0,
      });
    }
  }

  /** NPC positions (they bend the grass too). */
  positions(out: THREE.Vector3[]) { for (const n of this.list) out.push(n.pos); }

  /** A walkable spot on the paths between the plots. */
  private randomSpot(): THREE.Vector3 {
    for (let i = 0; i < 20; i++) {
      const x = rr(-15, 15), z = rr(-10.5, 11);
      if (!PLOTS.some((p) => Math.abs(x - p.x) < 1.1 && Math.abs(z - p.z) < 1.5)) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(rr(-1.5, 1.5), 0, rr(-6, 10));   // the main path
  }

  /** Picks the next activity. `playerIn`: the player has entered the world (so NPCs may come and club with them). */
  private choose(n: Npc, t: number, player: THREE.Vector3, playerIn: boolean) {
    n.emote = 0; n.faceYaw = null; n.target = null;
    const near = playerIn && n.pos.distanceTo(player) < 14;
    const r = Math.random();
    const kind: Kind = near && r < 0.22 ? 'club' : r < 0.45 ? 'mourn' : r < 0.6 ? 'hop' : r < 0.72 ? 'roll' : 'wander';
    n.kind = kind;
    if (kind === 'wander') {
      n.target = this.randomSpot(); n.until = t + 25;
    } else if (kind === 'mourn') {
      const graves = this.graves.graves();
      const plot = graves.length && Math.random() < 0.85 ? PLOTS[pick(graves).plot - 1] : pick(PLOTS);
      // stand at the foot of the grave, facing the stone
      n.target = new THREE.Vector3(plot.x + rr(-0.4, 0.4), 0, plot.z + 1.75);
      n.faceYaw = Math.PI;
      n.until = t + rr(9, 16);
    } else if (kind === 'club') {
      n.until = t + rr(10, 16);
    } else if (kind === 'hop') {
      n.until = t + rr(3, 6);
    } else if (kind === 'roll') {
      n.until = t + rr(4, 7);
    }
    n.walkUntil = t + 12;
  }

  update(dt: number, t: number, player: THREE.Vector3, playerIn: boolean): void {
    for (const n of this.list) {
      if (t >= n.until) this.choose(n, t, player, playerIn);

      // follow the player while clubbing (keep a little distance, stay on their side)
      if (n.kind === 'club') {
        if (!playerIn) { n.until = t; continue; }
        const away = n.pos.clone().sub(player); away.y = 0;
        if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
        n.target = player.clone().addScaledVector(away.normalize(), 1.3);
        n.faceYaw = Math.atan2(player.x - n.pos.x, player.z - n.pos.z);
      }

      // walk towards the target
      let moving = false;
      if (n.target) {
        const dx = n.target.x - n.pos.x, dz = n.target.z - n.pos.z, d = Math.hypot(dx, dz);
        const arrive = n.kind === 'club' ? 0.35 : 0.2;
        if (d > arrive && t < n.walkUntil) {
          moving = true;
          n.yaw = lerpAngle(n.yaw, Math.atan2(dx, dz), 1 - Math.exp(-8 * dt));
          n.speed = damp(n.speed, n.kind === 'club' && d > 4 ? WALK * 1.6 : WALK, 6, dt);
          n.pos.x += Math.sin(n.yaw) * n.speed * dt;
          n.pos.z += Math.cos(n.yaw) * n.speed * dt;
          resolveCollisions(n.pos, RADIUS, this.colliders);
        } else if (n.kind === 'wander') {
          n.until = Math.min(n.until, t + rr(0.5, 2.5));   // got there: idle a moment, then something new
          n.target = null;
        }
      }
      if (!moving) n.speed = damp(n.speed, 0, 10, dt);

      // what to do once there
      const there = !moving;
      n.emote = 0;
      if (there) {
        if (n.faceYaw !== null) n.yaw = lerpAngle(n.yaw, n.faceYaw, 1 - Math.exp(-6 * dt));
        if (n.kind === 'mourn' && n.target) n.emote = EMOTE.cry;
        else if (n.kind === 'club') n.emote = EMOTE.club;
        else if (n.kind === 'roll') n.emote = EMOTE.roll;
        else if (n.kind === 'hop' && n.grounded && t >= n.nextHop) {
          n.vy = HOP_VELOCITY * rr(0.75, 1.05); n.grounded = false; n.nextHop = t + rr(0.15, 0.45);
          n.yaw += rr(-1.2, 1.2);
        }
      }

      // gravity
      if (!n.grounded) {
        n.vy -= GRAVITY * dt; n.y += n.vy * dt;
        if (n.y <= 0) { n.y = 0; n.vy = 0; n.grounded = true; n.land = 1; }
      }
      n.land = damp(n.land, 0, 9, dt);

      n.owl.root.position.set(n.pos.x, n.y, n.pos.z);
      n.owl.root.rotation.y = n.yaw;
      if (n.grounded) n.phase += n.speed * dt * 8;
      n.owl.animate(dt, t, { emote: n.emote, speed: n.speed, phase: n.phase, air: !n.grounded, vy: n.vy, land: n.land });
    }
  }

  dispose() { for (const n of this.list) this.scene.remove(n.owl.root, n.owl.blob); }
}
