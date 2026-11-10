import * as THREE from 'three';
import { PLOTS } from '../../../shared/graves.ts';
import { createOwl, type Owl } from '../owl/owl.ts';
import { NameTag } from '../ui/nametag.ts';
import { damp, lerpAngle } from '../util/math.ts';
import { resolveCollisions, type Colliders } from '../world/collision.ts';
import type { GraveField } from '../world/graves.ts';

/**
 * Nameless NPC owls, purely cosmetic and local to each player's screen. There are always enough of them that the
 * graveyard holds about TOTAL owls: NPCs = TOTAL - real players in your graveyard (they walk in and out as players
 * come and go).
 *
 * Each picks something to do, does it for a while, then picks again:
 *   wander     stroll to a random spot
 *   mourn      cry in front of a real grave (never an empty plot)
 *   club       come over and club next to you
 *   tagalong   follow you around for a while
 *   hop / roll bounce or roll around
 * And they react to you:
 *   join       when you do an emote, nearby NPCs come over and do it with you
 *   greet      walk up to an idle NPC and it turns to you, hops and says something
 * Now and then they say something in a speech bubble.
 */

// TEMPORARY: 30 for a test (normally 10)
export const TOTAL = 30;
const RADIUS = 0.3;
const GRAVITY = 12.5;
const HOP_VELOCITY = 4.4;
const WALK = 1.25;
const EMOTE = { dance: 1, club: 2, pray: 3, cry: 4, roll: 5 } as const;

const LINES = {
  greet: ['gm', 'gm fren', 'rip ser', 'ngmi', 'wagmi?', 'f', 'o7', "we're so back", "it's so over", 'wen moon', 'i bought the top', 'hodl', 'nice walk', 'you again?', 'hoot hoot'],
  mourn: ['gone too soon', 'rip', 'it was a good pump', 'never selling', 'why', 'f in chat', 'i was early...', 'one more candle'],
  club: ['push your hands up!', 'lfg', 'pump it', 'party at the grave', 'dance with me'],
  join: ['same', 'felt', 'lfg', 'me too', 'together'],
  tag: ["i'm with you fren", 'wait for me', 'where are we going?', 'lead the way'],
} as const;

type Kind = 'wander' | 'mourn' | 'club' | 'tagalong' | 'hop' | 'roll' | 'idle' | 'join' | 'greet';
interface Npc {
  owl: Owl;
  tag: NameTag;
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
  phase: number;
  y: number; vy: number; grounded: boolean; land: number;
  emote: number;
  kind: Kind;
  target: THREE.Vector3 | null;
  faceYaw: number | null;
  until: number;
  walkUntil: number;
  nextHop: number;
  /** Which grave it is mourning (so it stops if the grave is gone). */
  graveId: number | null;
  /** Time it may next greet / speak. */
  nextGreet: number;
  nextTalk: number;
  /** Slot around the player (so several NPCs don't stand on the same spot). */
  slot: number;
  /** Leaving: walks out of the gate, then is removed. */
  leaving: boolean;
  /** Own animation clock offset, so NPCs never move in perfect sync. */
  tOff: number;
  /** The emote it copies from the player (it switches to a new one only after its own delay). */
  joinEmote: number;
  /** When it will react to the player's latest emote change; whether it joins that emote at all. */
  reactAt: number;
  joins: boolean;
  /** Its place in a row formation (0, 1, 2... alternating sides). */
  rowIndex: number;
}

/** viewYaw: the camera's yaw (the direction the player is looking at the scene). */
export interface PlayerView { pos: THREE.Vector3; emote: number; entered: boolean; viewYaw: number }

const rr = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];
const GATE = new THREE.Vector3(0, 0, 15.5);

export class Npcs {
  private readonly list: Npc[] = [];
  private readonly scene: THREE.Scene;
  private readonly colliders: Colliders;
  private readonly graves: GraveField;
  private target: number;
  private slots = 0;
  /** The player's emote last frame (to notice changes). */
  private lastEmote = 0;

  constructor(scene: THREE.Scene, colliders: Colliders, graves: GraveField, count = TOTAL - 1) {
    this.scene = scene; this.colliders = colliders; this.graves = graves;
    this.target = count;
    for (let i = 0; i < count; i++) this.spawn(this.randomSpot());
  }

  /** How many real players are in this graveyard (you included): NPCs fill up to TOTAL. */
  setPlayers(n: number) { this.target = Math.max(0, TOTAL - Math.max(1, n)); }

  positions(out: THREE.Vector3[]) { for (const n of this.list) out.push(n.pos); }

  private spawn(at: THREE.Vector3) {
    const owl = createOwl();
    owl.setWalk(Math.floor(Math.random() * 9));
    const tag = new NameTag('');
    this.scene.add(owl.root, owl.blob, tag.sprite);
    this.list.push({
      owl, tag, pos: at.clone(), yaw: rr(-Math.PI, Math.PI), speed: 0, phase: rr(0, 10), y: 0, vy: 0, grounded: true, land: 0,
      emote: 0, kind: 'idle', target: null, faceYaw: null, until: rr(0.5, 3), walkUntil: 0, nextHop: 0, graveId: null,
      nextGreet: 0, nextTalk: rr(3, 15), slot: this.slots++ % 8, leaving: false,
      tOff: rr(0, 30), joinEmote: 0, reactAt: 0, joins: false, rowIndex: 0,
    });
  }

  private remove(n: Npc) {
    this.scene.remove(n.owl.root, n.owl.blob);
    n.tag.dispose();
    this.list.splice(this.list.indexOf(n), 1);
  }

  private randomSpot(): THREE.Vector3 {
    for (let i = 0; i < 20; i++) {
      const x = rr(-15, 15), z = rr(-10.5, 11);
      if (!PLOTS.some((p) => Math.abs(x - p.x) < 1.1 && Math.abs(z - p.z) < 1.5)) return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(rr(-1.5, 1.5), 0, rr(-6, 10));
  }

  private say(n: Npc, t: number, lines: readonly string[], chance = 1) {
    if (t < n.nextTalk || Math.random() > chance) return;
    n.tag.say(pick(lines));
    n.nextTalk = t + rr(7, 16);
  }

  /** A spot near the player for this NPC (a ring of slots, so they don't pile up). */
  private nearPlayer(n: Npc, p: THREE.Vector3, r: number) {
    const a = (n.slot / 8) * Math.PI * 2 + 0.4;
    return new THREE.Vector3(p.x + Math.sin(a) * r, 0, p.z + Math.cos(a) * r);
  }

  /**
   * Where a joining NPC stands, and which way it faces. Cry: a row in front of the player, facing the camera (you see
   * their faces). Pray: a row beside the player, facing the way the camera looks. Roll: a row beside the player.
   * Dance / club: a ring around the player.
   */
  private formation(n: Npc, pl: PlayerView): { at: THREE.Vector3; face: number } {
    const fx = -Math.sin(pl.viewYaw), fz = -Math.cos(pl.viewYaw);   // camera forward (into the scene)
    const rx = Math.cos(pl.viewYaw), rz = -Math.sin(pl.viewYaw);    // camera right
    const k = n.rowIndex, side = k % 2 ? -1 : 1, step = Math.ceil((k + 1) / 2);
    const faceCamera = pl.viewYaw, faceAway = pl.viewYaw + Math.PI;
    const row = (ahead: number, spacing: number, offsets: number) => new THREE.Vector3(
      pl.pos.x + fx * ahead + rx * side * offsets * spacing, 0, pl.pos.z + fz * ahead + rz * side * offsets * spacing);
    if (n.joinEmote === EMOTE.cry) {
      // centre slot first, then left / right: k=0 -> 0, 1 -> +1, 2 -> -1 ...
      const off = k === 0 ? 0 : Math.ceil(k / 2);
      const sd = k % 2 ? 1 : -1;
      return { at: new THREE.Vector3(pl.pos.x + fx * 2.0 + rx * sd * off * 1.15, 0, pl.pos.z + fz * 2.0 + rz * sd * off * 1.15), face: faceCamera };
    }
    if (n.joinEmote === EMOTE.pray) return { at: row(0.1, 1.05, step), face: faceAway };
    if (n.joinEmote === EMOTE.roll) return { at: row(0.2, 1.5, step), face: faceCamera };
    const at = this.nearPlayer(n, pl.pos, 1.6);
    return { at, face: Math.atan2(pl.pos.x - at.x, pl.pos.z - at.z) };
  }

  private choose(n: Npc, t: number, pl: PlayerView) {
    n.emote = 0; n.faceYaw = null; n.target = null; n.graveId = null;
    const near = pl.entered && n.pos.distanceTo(pl.pos) < 16;
    const graves = this.graves.graves();
    const r = Math.random();
    let kind: Kind = near && r < 0.18 ? 'club' : near && r < 0.3 ? 'tagalong' : r < 0.55 ? 'mourn' : r < 0.67 ? 'hop' : r < 0.77 ? 'roll' : 'wander';
    if (kind === 'mourn' && !graves.length) kind = 'wander';   // only real graves get mourners
    n.kind = kind;
    n.walkUntil = t + 14;
    if (kind === 'wander') { n.target = this.randomSpot(); n.until = t + 25; }
    else if (kind === 'mourn') {
      const g = pick(graves), plot = PLOTS[g.plot - 1];
      n.graveId = g.id;
      n.target = new THREE.Vector3(plot.x + rr(-0.5, 0.5), 0, plot.z + rr(1.65, 1.95));
      n.faceYaw = Math.PI;
      n.until = t + rr(9, 16);
    } else if (kind === 'club') { n.until = t + rr(10, 16); this.say(n, t, LINES.club, 0.6); }
    else if (kind === 'tagalong') { n.until = t + rr(14, 24); this.say(n, t, LINES.tag, 0.7); }
    else if (kind === 'hop') n.until = t + rr(3, 6);
    else if (kind === 'roll') n.until = t + rr(4, 7);
  }

  update(dt: number, t: number, pl: PlayerView): void {
    // keep the head count: send extra NPCs out of the gate, bring new ones in through it
    const staying = this.list.filter((n) => !n.leaving);
    if (staying.length > this.target) {
      const far = staying.sort((a, b) => b.pos.distanceTo(pl.pos) - a.pos.distanceTo(pl.pos))[0];
      far.leaving = true; far.kind = 'wander'; far.target = GATE.clone(); far.emote = 0; far.until = t + 60; far.walkUntil = t + 40;
    } else if (staying.length < this.target) {
      this.spawn(GATE.clone().add(new THREE.Vector3(rr(-1, 1), 0, 0)));
    }

    const emoteChanged = pl.emote !== this.lastEmote;
    this.lastEmote = pl.emote;
    let row = 0;
    for (const n of this.list) if (n.kind === 'join') n.rowIndex = row++;

    for (const n of [...this.list]) {
      const dPlayer = n.pos.distanceTo(pl.pos);
      if (n.leaving) {
        if (n.pos.distanceTo(GATE) < 0.8 || t > n.walkUntil) { this.remove(n); continue; }
      } else {
        // react to the player's emote: nearby NPCs come and do it with you
        if (emoteChanged) { n.reactAt = t + rr(0.4, 2.2); n.joins = Math.random() < 0.75; }
        if (t >= n.reactAt && n.reactAt > 0) {
          n.reactAt = 0;
          if (pl.entered && pl.emote && n.joins && (n.kind === 'join' || dPlayer < 10)) {
            if (n.kind !== 'join') { n.kind = 'join'; n.graveId = null; n.until = t + 999; this.say(n, t, LINES.join, 0.4); }
            n.joinEmote = pl.emote; n.walkUntil = t + 10;
          } else if (n.kind === 'join') n.until = t;   // you stopped (or it lost interest): back to its own business
        }
        // greet: walk up to an idle / wandering NPC
        if (pl.entered && !pl.emote && dPlayer < 2.4 && t >= n.nextGreet && (n.kind === 'wander' || n.kind === 'idle' || n.kind === 'hop')) {
          n.kind = 'greet'; n.target = null; n.emote = 0; n.until = t + 2.6; n.nextGreet = t + 25;
          n.vy = HOP_VELOCITY * 0.8; n.grounded = false;
          this.say(n, t, LINES.greet);
        }
        if (n.kind === 'mourn' && n.graveId !== null && !this.graves.grave(n.graveId)) n.until = t;   // grave gone
        if (t >= n.until) this.choose(n, t, pl);
      }

      // moving targets that follow the player
      if (!n.leaving && pl.entered) {
        if (n.kind === 'join') {
          const fm = this.formation(n, pl);
          n.target = fm.at; n.faceYaw = fm.face;
        } else if (n.kind === 'club') {
          n.target = this.nearPlayer(n, pl.pos, 1.3);
          n.faceYaw = Math.atan2(pl.pos.x - n.pos.x, pl.pos.z - n.pos.z);
        } else if (n.kind === 'tagalong') {
          n.target = dPlayer > 2.2 ? this.nearPlayer(n, pl.pos, 1.8) : null;
          n.faceYaw = Math.atan2(pl.pos.x - n.pos.x, pl.pos.z - n.pos.z);
        } else if (n.kind === 'greet') {
          n.faceYaw = Math.atan2(pl.pos.x - n.pos.x, pl.pos.z - n.pos.z);
        }
      } else if (n.kind === 'club' || n.kind === 'join' || n.kind === 'tagalong') n.until = t;

      // walk
      let moving = false;
      if (n.target) {
        const dx = n.target.x - n.pos.x, dz = n.target.z - n.pos.z, d = Math.hypot(dx, dz);
        if (d > 0.3 && t < n.walkUntil) {
          moving = true;
          n.yaw = lerpAngle(n.yaw, Math.atan2(dx, dz), 1 - Math.exp(-8 * dt));
          const fast = (n.kind === 'club' || n.kind === 'join' || n.kind === 'tagalong') && d > 4;
          n.speed = damp(n.speed, fast ? WALK * 1.7 : WALK, 6, dt);
          n.pos.x += Math.sin(n.yaw) * n.speed * dt;
          n.pos.z += Math.cos(n.yaw) * n.speed * dt;
          resolveCollisions(n.pos, RADIUS, this.colliders);
        } else if (n.kind === 'wander' && !n.leaving) {
          n.until = Math.min(n.until, t + rr(0.5, 2.5));
          n.target = null;
        }
      }
      if (!moving) n.speed = damp(n.speed, 0, 10, dt);

      // what to do once there
      n.emote = 0;
      if (!moving && !n.leaving) {
        if (n.faceYaw !== null) n.yaw = lerpAngle(n.yaw, n.faceYaw, 1 - Math.exp(-6 * dt));
        if (n.kind === 'mourn' && n.target) { n.emote = EMOTE.cry; this.say(n, t, LINES.mourn, dt * 0.15); }
        else if (n.kind === 'club') n.emote = EMOTE.club;
        else if (n.kind === 'join') n.emote = n.joinEmote;
        else if (n.kind === 'roll') n.emote = EMOTE.roll;
        else if (n.kind === 'hop' && n.grounded && t >= n.nextHop) {
          n.vy = HOP_VELOCITY * rr(0.75, 1.05); n.grounded = false; n.nextHop = t + rr(0.15, 0.45);
          n.yaw += rr(-1.2, 1.2);
        }
      }

      if (!n.grounded) {
        n.vy -= GRAVITY * dt; n.y += n.vy * dt;
        if (n.y <= 0) { n.y = 0; n.vy = 0; n.grounded = true; n.land = 1; }
      }
      n.land = damp(n.land, 0, 9, dt);

      n.owl.root.position.set(n.pos.x, n.y, n.pos.z);
      n.owl.root.rotation.y = n.yaw;
      if (n.grounded) n.phase += n.speed * dt * 8;
      n.owl.animate(dt, t + n.tOff, { emote: n.emote, speed: n.speed, phase: n.phase, air: !n.grounded, vy: n.vy, land: n.land });
      n.tag.sprite.position.set(n.pos.x, n.y + 1.0, n.pos.z);
      n.tag.tick(performance.now());
    }
  }
}
