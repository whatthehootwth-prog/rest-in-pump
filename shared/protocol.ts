/**
 * Wire protocol shared by the game client and the game server.
 *
 * Every message is a small JSON object with a `t` (type) field. Messages coming FROM clients are
 * untrusted: the server only acts on what `parseClientMessage` returns, never on raw JSON.
 * Bump PROTOCOL_VERSION whenever a message shape changes incompatibly; old clients are then told
 * to reload instead of misbehaving.
 */

import type { GraveInfo } from './graves.ts';

export const PROTOCOL_VERSION = 2;

/** Players are kept inside this circle around the world origin (metres). */
export const WORLD_RADIUS = 33;
/** Run speed of the owl (m/s). The server rejects movement faster than this (with some slack). */
export const MAX_SPEED = 3.6;
/** Highest a hop can reach (m). */
export const MAX_HOP_HEIGHT = 2;
/** Number of walk styles. Each player is given one at random when they join and keeps it. */
export const WALK_STYLE_COUNT = 9;
/** Emotes: 0 = none, 1 dance, 2 club, 3 pray, 4 cry, 5 roll. */
export const EMOTE_COUNT = 5;
/** Chat message length limit (characters, after trimming). */
export const CHAT_MAX = 140;
/** How often clients send their own state, and how often the server broadcasts room snapshots. */
export const STATE_SEND_HZ = 15;
export const NAME_MIN = 2;
export const NAME_MAX = 16;
/** Hard cap on any single client message (bytes of JSON). */
export const MAX_CLIENT_MESSAGE_BYTES = 1024;
/** Where new players appear (just inside the gate). */
export const SPAWN = { x: 0, z: 12, spread: 1.6 } as const;

export const ROOM_ID_PATTERN = /^graveyard-(\d{1,3})$/;

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  /** Facing angle in radians. */
  yaw: number;
  /** Horizontal speed in m/s (drives the walk animation). */
  speed: number;
  /** True while hopping. */
  air: boolean;
  /** Walk style index (assigned by the server, fixed for the session). */
  walk: number;
  /** Current emote, 0 = none. */
  emote: number;
}

export interface PlayerInfo {
  id: string;
  name: string;
  /** False while the player is briefly disconnected and may still come back. */
  connected: boolean;
  state: PlayerState;
}

export interface RoomSummary {
  id: string;
  players: number;
  capacity: number;
}

export type ErrorCode =
  | 'bad_version'
  | 'bad_message'
  | 'not_joined'
  | 'already_joined'
  | 'room_full'
  | 'server_full'
  | 'unknown_room'
  | 'bad_name'
  | 'rate_limited'
  | 'bad_chat'
  | 'chat_too_fast';

// ------------------------------------------------------------------ client -> server

export type ClientMessage =
  | { t: 'hello'; v: number; name: string | null; resume: string | null; room: string | null }
  | { t: 'state'; s: PlayerState }
  | { t: 'rename'; name: string }
  | { t: 'join_room'; room: string }
  | { t: 'list_rooms' }
  | { t: 'chat'; text: string }
  | { t: 'ping'; n: number };

// ------------------------------------------------------------------ server -> client

/** Compact per-player entry in a snapshot: id, x, y, z, yaw, speed, air (0/1), walk, emote. */
export type SnapshotEntry = [string, number, number, number, number, number, 0 | 1, number, number];

export type ServerMessage =
  | {
      t: 'welcome';
      v: number;
      you: string;
      session: string;
      resumed: boolean;
      room: RoomSummary;
      players: PlayerInfo[];
    }
  | { t: 'player_joined'; p: PlayerInfo }
  | { t: 'player_left'; id: string }
  | { t: 'presence'; id: string; connected: boolean }
  | { t: 'renamed'; id: string; name: string }
  | { t: 'snapshot'; ts: number; s: SnapshotEntry[] }
  | { t: 'online'; total: number; room: number }
  | { t: 'rooms'; rooms: RoomSummary[] }
  | { t: 'chat'; id: string; name: string; text: string; ts: number }
  | { t: 'grave_added'; grave: GraveInfo }
  /** A grave got a new offering. levelUp: it just reached a new memorial level. */
  | { t: 'grave_updated'; grave: GraveInfo; offering: { item: string; payer: string; levelUp: boolean } }
  | { t: 'plots_reserved'; reserved: number[] }
  | { t: 'error'; code: ErrorCode; message: string; fatal: boolean }
  | { t: 'pong'; n: number };

// ------------------------------------------------------------------ validation helpers

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optionalString = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && v.length <= max ? v : undefined;
};

/** Normalises a display name, or returns null if it is not acceptable. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) return null;
  // letters/digits from any script, plus a few separators — no control or zero-width characters
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u.test(name)) return null;
  return name;
}

/** Cleans a chat message: no control/zero-width characters, collapsed whitespace, 1..CHAT_MAX chars. */
export function sanitizeChat(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > CHAT_MAX * 4) return null;
  const text = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (text.length < 1 || [...text].length > CHAT_MAX) return null;
  return text;
}

export function isRoomId(v: unknown): v is string {
  return typeof v === 'string' && ROOM_ID_PATTERN.test(v);
}

export function roomNumber(id: string): number {
  const m = ROOM_ID_PATTERN.exec(id);
  return m ? Number(m[1]) : NaN;
}

/** Validates a player state sent by a client. Values are range-checked later by the server. */
export function parseState(v: unknown): PlayerState | null {
  if (!isObject(v)) return null;
  const { x, y, z, yaw, speed, air, walk, emote } = v;
  if (![x, y, z, yaw, speed].every(isFiniteNumber)) return null;
  if (typeof air !== 'boolean') return null;
  if (!Number.isInteger(walk) || (walk as number) < 0 || (walk as number) >= WALK_STYLE_COUNT) return null;
  if (!Number.isInteger(emote) || (emote as number) < 0 || (emote as number) > EMOTE_COUNT) return null;
  return { x: x as number, y: y as number, z: z as number, yaw: yaw as number, speed: speed as number, air, walk: walk as number, emote: emote as number };
}

/** Parses and validates one raw client message. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'hello': {
      if (!Number.isInteger(v.v)) return null;
      const name = optionalString(v.name, 64);
      const resume = optionalString(v.resume, 64);
      const room = optionalString(v.room, 32);
      if (name === undefined || resume === undefined || room === undefined) return null;
      return { t: 'hello', v: v.v as number, name, resume, room };
    }
    case 'state': {
      const s = parseState(v.s);
      return s ? { t: 'state', s } : null;
    }
    case 'rename':
      return typeof v.name === 'string' && v.name.length <= 64 ? { t: 'rename', name: v.name } : null;
    case 'join_room':
      return typeof v.room === 'string' && v.room.length <= 32 ? { t: 'join_room', room: v.room } : null;
    case 'list_rooms':
      return { t: 'list_rooms' };
    case 'chat':
      return typeof v.text === 'string' && v.text.length <= CHAT_MAX * 4 ? { t: 'chat', text: v.text } : null;
    case 'ping':
      return isFiniteNumber(v.n) ? { t: 'ping', n: v.n } : null;
    default:
      return null;
  }
}

/** Human-readable room label, e.g. "graveyard-2" -> "Graveyard 2". */
export function roomLabel(id: string): string {
  const n = roomNumber(id);
  return Number.isNaN(n) ? id : `Graveyard ${n}`;
}
