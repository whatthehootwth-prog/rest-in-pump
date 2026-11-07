import * as THREE from 'three';
import type { PlayerInfo, PlayerState, SnapshotEntry } from '../../../shared/protocol.ts';
import { createOwl, type Owl } from '../owl/owl.ts';
import { clamp, damp, lerp, lerpAngle } from '../util/math.ts';
import { NameTag } from '../ui/nametag.ts';

/** How far behind the newest server snapshot remote players are drawn, to smooth out network jitter. */
const INTERP_DELAY_MS = 120;
const MAX_EXTRAPOLATE_MS = 250;

interface Sample { ts: number; s: PlayerState }

interface Remote {
  id: string;
  name: string;
  connected: boolean;
  owl: Owl;
  tag: NameTag;
  samples: Sample[];
  phase: number;
  lastY: number;
  vy: number;
  land: number;
  wasAir: boolean;
  shown: PlayerState;
}

/** Every other real, connected player in the room — created only from server messages. */
export class RemotePlayers {
  private readonly scene: THREE.Scene;
  private readonly players = new Map<string, Remote>();
  private clockOffset: number | null = null;   // server time minus local time (ms), lowest-latency estimate
  private selfId: string | null = null;

  constructor(scene: THREE.Scene) { this.scene = scene; }

  get count(): number { return this.players.size; }

  /** Replace everyone (on welcome / room change). */
  reset(players: PlayerInfo[], selfId: string): void {
    for (const id of [...this.players.keys()]) this.remove(id);
    this.selfId = selfId;
    this.clockOffset = null;
    for (const p of players) if (p.id !== selfId) this.add(p);
  }

  clear(): void { for (const id of [...this.players.keys()]) this.remove(id); }

  add(p: PlayerInfo): void {
    if (p.id === this.selfId || this.players.has(p.id)) return;
    const owl = createOwl();
    owl.setWalk(p.state.walk);
    owl.root.position.set(p.state.x, p.state.y, p.state.z);
    owl.root.rotation.y = p.state.yaw;
    const tag = new NameTag(p.name);
    this.scene.add(owl.root, owl.blob, tag.sprite);
    const r: Remote = {
      id: p.id, name: p.name, connected: p.connected, owl, tag, samples: [{ ts: 0, s: { ...p.state } }],
      phase: 0, lastY: p.state.y, vy: 0, land: 0, wasAir: p.state.air, shown: { ...p.state },
    };
    tag.setStatus(p.connected ? null : 'reconnecting');
    this.players.set(p.id, r);
  }

  remove(id: string): void {
    const r = this.players.get(id);
    if (!r) return;
    r.owl.dispose();
    r.tag.dispose();
    this.players.delete(id);
  }

  setConnected(id: string, connected: boolean): void {
    const r = this.players.get(id);
    if (!r) return;
    r.connected = connected;
    r.tag.setStatus(connected ? null : 'reconnecting');
    if (!connected) r.samples = [{ ts: 0, s: { ...r.shown, speed: 0, air: false, emote: 0 } }];   // freeze in place
  }

  name(id: string): string | null { return this.players.get(id)?.name ?? null; }

  say(id: string, text: string): void { this.players.get(id)?.tag.say(text); }

  rename(id: string, name: string): void {
    const r = this.players.get(id);
    if (r) { r.name = name; r.tag.setName(name); }
  }

  applySnapshot(ts: number, entries: SnapshotEntry[]): void {
    const now = performance.now();
    const est = ts - now;
    // keep the estimate from the fastest-arriving snapshots, but let it drift so clock skew can't stick
    this.clockOffset = this.clockOffset === null || est > this.clockOffset ? est : this.clockOffset - 0.05;
    for (const [id, x, y, z, yaw, speed, air, walk, emote] of entries) {
      const r = this.players.get(id);
      if (!r || !r.connected) continue;
      // the untimed starting sample (from welcome/presence) gets a time just before the first real one
      if (r.samples.length === 1 && r.samples[0].ts === 0) r.samples[0].ts = ts - 70;
      if (r.samples.length && r.samples[r.samples.length - 1].ts >= ts) continue;
      r.samples.push({ ts, s: { x, y, z, yaw, speed, air: air === 1, walk, emote } });
      if (r.samples.length > 30) r.samples.splice(0, r.samples.length - 30);
    }
  }

  update(dt: number, t: number): void {
    const now = performance.now();
    const renderTs = performance.now() + (this.clockOffset ?? 0) - INTERP_DELAY_MS;
    for (const r of this.players.values()) {
      const s = this.sample(r, renderTs);
      r.shown = s;
      r.owl.setWalk(s.walk);
      r.owl.root.position.set(s.x, s.y, s.z);
      r.owl.root.rotation.y = s.yaw;
      r.vy = dt > 0 ? damp(r.vy, (s.y - r.lastY) / dt, 20, dt) : r.vy;
      r.lastY = s.y;
      if (r.wasAir && !s.air) r.land = 1;
      r.wasAir = s.air;
      r.land = damp(r.land, 0, 9, dt);
      if (!s.air) r.phase += s.speed * dt * 8;
      r.owl.animate(dt, t, { emote: s.emote, speed: s.speed, phase: r.phase, air: s.air, vy: r.vy, land: r.land });
      r.tag.sprite.position.set(s.x, s.y + 1.0, s.z);
      r.tag.tick(now);
    }
  }

  /** Positions of all remote owls (for grass bending). */
  positions(out: THREE.Vector3[] = []): THREE.Vector3[] {
    for (const r of this.players.values()) out.push(r.owl.root.position);
    return out;
  }

  /** Interpolates between the two snapshots around renderTs (briefly extrapolating if the next is late). */
  private sample(r: Remote, renderTs: number): PlayerState {
    const S = r.samples;
    while (S.length > 2 && S[1].ts <= renderTs) S.shift();
    if (S.length < 2) return S[0].s;
    const a = S[0], b = S[1];
    const span = Math.max(1, b.ts - a.ts);
    const k = clamp((renderTs - a.ts) / span, 0, 1 + MAX_EXTRAPOLATE_MS / span);
    const kk = Math.min(k, 1);
    return {
      x: lerp(a.s.x, b.s.x, k), y: lerp(a.s.y, b.s.y, kk), z: lerp(a.s.z, b.s.z, k),
      yaw: lerpAngle(a.s.yaw, b.s.yaw, kk), speed: lerp(a.s.speed, b.s.speed, kk),
      air: kk < 0.5 ? a.s.air : b.s.air, walk: b.s.walk, emote: b.s.emote,
    };
  }
}
