import { randomBytes, randomUUID } from 'node:crypto';
import {
  MAX_HOP_HEIGHT, MAX_SPEED, SPAWN, WALK_STYLE_COUNT, WORLD_RADIUS, isRoomId, roomNumber,
  type ErrorCode, type PlayerInfo, type PlayerState, type RoomSummary,
} from '../../shared/protocol.ts';

/**
 * Room bookkeeping, kept free of sockets so it can be unit-tested directly.
 *
 * - Rooms are named graveyard-1 .. graveyard-N and are opened on demand (graveyard-1 always exists).
 * - A player who drops keeps their slot, id and name for `graceMs` so a refresh or a flaky
 *   network can resume the same identity with the session token.
 * - Positions sent by clients are range-checked and speed-limited here.
 */

export interface Player {
  id: string;
  name: string;
  session: string;
  roomId: string;
  connected: boolean;
  disconnectedAt: number | null;
  state: PlayerState;
  lastStateAt: number;
}

export interface RoomOptions {
  capacity: number;
  maxRooms: number;
  graceMs: number;
}

export type JoinResult = { ok: true; player: Player } | { ok: false; code: ErrorCode };
export type MoveResult = { ok: true; from: string; to: string } | { ok: false; code: ErrorCode };

const FIRST_ROOM = 'graveyard-1';

export class RoomManager {
  private readonly rooms = new Map<string, Map<string, Player>>();
  private readonly byId = new Map<string, Player>();
  private readonly bySession = new Map<string, Player>();
  private readonly opts: RoomOptions;
  private readonly random: () => number;

  constructor(opts: RoomOptions, random: () => number = Math.random) {
    this.opts = opts;
    this.random = random;
    this.rooms.set(FIRST_ROOM, new Map());
  }

  get capacity(): number { return this.opts.capacity; }

  /** Adds a brand-new player, to `preferred` if given, otherwise to the first room with space. */
  join(name: string, preferred: string | null, now: number): JoinResult {
    const roomId = preferred ? this.resolvePreferred(preferred) : this.findOpenRoom();
    if (typeof roomId !== 'string') return { ok: false, code: roomId.code };
    const player: Player = {
      id: randomUUID(),
      name,
      session: randomBytes(24).toString('base64url'),
      roomId,
      connected: true,
      disconnectedAt: null,
      state: this.spawnState(),
      lastStateAt: now,
    };
    this.roomMap(roomId).set(player.id, player);
    this.byId.set(player.id, player);
    this.bySession.set(player.session, player);
    return { ok: true, player };
  }

  /** Re-attaches a dropped player by session token. Returns null if unknown, expired or still connected. */
  resume(session: string, now: number): Player | null {
    const p = this.bySession.get(session);
    if (!p || p.connected) return null;
    if (p.disconnectedAt !== null && now - p.disconnectedAt > this.opts.graceMs) return null;
    p.connected = true;
    p.disconnectedAt = null;
    p.lastStateAt = now;
    return p;
  }

  markDisconnected(id: string, now: number): Player | null {
    const p = this.byId.get(id);
    if (!p) return null;
    p.connected = false;
    p.disconnectedAt = now;
    if (this.opts.graceMs === 0) this.remove(id);
    return p;
  }

  /** Removes players whose grace period ran out. Returns them so the caller can notify rooms. */
  sweep(now: number): Player[] {
    const gone: Player[] = [];
    for (const p of this.byId.values()) {
      if (!p.connected && p.disconnectedAt !== null && now - p.disconnectedAt > this.opts.graceMs) gone.push(p);
    }
    for (const p of gone) this.remove(p.id);
    return gone;
  }

  remove(id: string): Player | null {
    const p = this.byId.get(id);
    if (!p) return null;
    this.byId.delete(id);
    this.bySession.delete(p.session);
    const room = this.rooms.get(p.roomId);
    room?.delete(id);
    if (room && room.size === 0 && p.roomId !== FIRST_ROOM) this.rooms.delete(p.roomId);
    return p;
  }

  /** Moves a player to another room (creating it if allowed). Their position resets to the spawn. */
  move(id: string, roomId: string, now: number): MoveResult {
    const p = this.byId.get(id);
    if (!p) return { ok: false, code: 'not_joined' };
    if (p.roomId === roomId) return { ok: true, from: roomId, to: roomId };
    const target = this.resolvePreferred(roomId);
    if (typeof target !== 'string') return { ok: false, code: target.code };
    const from = p.roomId;
    const old = this.rooms.get(from);
    old?.delete(id);
    if (old && old.size === 0 && from !== FIRST_ROOM) this.rooms.delete(from);
    p.roomId = target;
    p.state = this.spawnState();
    p.lastStateAt = now;
    this.roomMap(target).set(id, p);
    return { ok: true, from, to: target };
  }

  rename(id: string, name: string): Player | null {
    const p = this.byId.get(id);
    if (!p) return null;
    p.name = name;
    return p;
  }

  /**
   * Accepts a state update from a client after clamping it to what is physically possible:
   * inside the world, no faster than the run speed (plus slack for network jitter), sane hop height.
   */
  applyState(id: string, s: PlayerState, now: number): PlayerState | null {
    const p = this.byId.get(id);
    if (!p || !p.connected) return null;
    const dt = Math.min(Math.max((now - p.lastStateAt) / 1000, 0.001), 1);
    let x = s.x, z = s.z;
    const dx = x - p.state.x, dz = z - p.state.z, dist = Math.hypot(dx, dz);
    const maxStep = MAX_SPEED * dt * 1.6 + 0.35;
    if (dist > maxStep) { x = p.state.x + (dx / dist) * maxStep; z = p.state.z + (dz / dist) * maxStep; }
    const r = Math.hypot(x, z);
    if (r > WORLD_RADIUS) { x *= WORLD_RADIUS / r; z *= WORLD_RADIUS / r; }
    p.state = {
      x, z,
      y: Math.min(Math.max(s.y, 0), MAX_HOP_HEIGHT),
      yaw: Math.atan2(Math.sin(s.yaw), Math.cos(s.yaw)),
      speed: Math.min(Math.max(s.speed, 0), MAX_SPEED * 1.1),
      air: s.air,
      walk: Math.min(Math.max(Math.trunc(s.walk), 0), WALK_STYLE_COUNT - 1),
    };
    p.lastStateAt = now;
    return p.state;
  }

  get(id: string): Player | undefined { return this.byId.get(id); }

  playersIn(roomId: string): Player[] { return [...(this.rooms.get(roomId)?.values() ?? [])]; }

  info(p: Player): PlayerInfo { return { id: p.id, name: p.name, connected: p.connected, state: { ...p.state } }; }

  summary(roomId: string): RoomSummary {
    return { id: roomId, players: this.rooms.get(roomId)?.size ?? 0, capacity: this.opts.capacity };
  }

  /** All open rooms, plus the next room that could be opened (so players can pick a quiet one). */
  summaries(): RoomSummary[] {
    const list = [...this.rooms.keys()].sort((a, b) => roomNumber(a) - roomNumber(b)).map((id) => this.summary(id));
    const next = this.nextRoomId();
    if (next) list.push({ id: next, players: 0, capacity: this.opts.capacity });
    return list;
  }

  connectedCount(roomId?: string): number {
    let n = 0;
    for (const p of this.byId.values()) if (p.connected && (!roomId || p.roomId === roomId)) n++;
    return n;
  }

  roomIds(): string[] { return [...this.rooms.keys()]; }

  // ------------------------------------------------------------------ internals

  private roomMap(id: string): Map<string, Player> {
    let r = this.rooms.get(id);
    if (!r) { r = new Map(); this.rooms.set(id, r); }
    return r;
  }

  private resolvePreferred(id: string): string | { code: ErrorCode } {
    if (!isRoomId(id) || roomNumber(id) < 1 || roomNumber(id) > this.opts.maxRooms) return { code: 'unknown_room' };
    const room = this.rooms.get(id);
    if (room) return room.size < this.opts.capacity ? id : { code: 'room_full' };
    if (this.rooms.size >= this.opts.maxRooms) return { code: 'server_full' };
    return id;
  }

  private findOpenRoom(): string | { code: ErrorCode } {
    const ids = [...this.rooms.keys()].sort((a, b) => roomNumber(a) - roomNumber(b));
    for (const id of ids) if ((this.rooms.get(id)?.size ?? 0) < this.opts.capacity) return id;
    return this.nextRoomId() ?? { code: 'server_full' };
  }

  private nextRoomId(): string | null {
    if (this.rooms.size >= this.opts.maxRooms) return null;
    for (let n = 1; n <= this.opts.maxRooms; n++) if (!this.rooms.has(`graveyard-${n}`)) return `graveyard-${n}`;
    return null;
  }

  private spawnState(): PlayerState {
    const a = this.random() * Math.PI * 2, r = Math.sqrt(this.random()) * SPAWN.spread;
    return { x: SPAWN.x + Math.cos(a) * r, y: 0, z: SPAWN.z + Math.sin(a) * r, yaw: 0, speed: 0, air: false, walk: 0 };
  }
}
