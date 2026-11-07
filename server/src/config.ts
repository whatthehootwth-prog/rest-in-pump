import path from 'node:path';
import type { LogLevel } from './log.ts';

export interface Config {
  port: number;
  host: string;
  /** Max players per room (includes players briefly disconnected and holding their slot). */
  roomCapacity: number;
  /** Max number of rooms open at once. */
  maxRooms: number;
  /** How long a dropped player keeps their slot and identity so a reconnect/refresh can resume. */
  reconnectGraceMs: number;
  /** Browser origins allowed to open a WebSocket. null = development mode (localhost only). */
  allowedOrigins: string[] | null;
  /** Directory with the built client (dist/client). null = don't serve static files. */
  staticDir: string | null;
  logLevel: LogLevel;
  snapshotHz: number;
  /** Trust X-Forwarded-For (only when running behind your own reverse proxy). */
  trustProxy: boolean;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}="${raw}" (expected an integer ${min}-${max})`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const origins = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (production && origins.length === 0) {
    throw new Error('ALLOWED_ORIGINS must be set in production (e.g. https://restinpump.com)');
  }
  const level = (env.LOG_LEVEL ?? (production ? 'info' : 'debug')) as LogLevel;
  if (!['debug', 'info', 'warn', 'error'].includes(level)) throw new Error(`Invalid LOG_LEVEL="${env.LOG_LEVEL}"`);
  // the built client (npm run build). Set STATIC_DIR="" to disable, e.g. when a CDN serves the files.
  const staticDir = env.STATIC_DIR === undefined ? 'dist/client' : env.STATIC_DIR || null;
  return {
    port: int(env, 'PORT', 8787, 0, 65535),
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    roomCapacity: int(env, 'ROOM_CAPACITY', 50, 1, 200),
    // one shared graveyard by default; raise only if the world is ever split into instances
    maxRooms: int(env, 'MAX_ROOMS', 1, 1, 999),
    reconnectGraceMs: int(env, 'RECONNECT_GRACE_MS', 20000, 0, 300000),
    allowedOrigins: origins.length ? origins : null,
    staticDir: staticDir ? path.resolve(staticDir) : null,
    logLevel: level,
    snapshotHz: int(env, 'SNAPSHOT_HZ', 15, 1, 60),
    trustProxy: env.TRUST_PROXY === '1',
  };
}
