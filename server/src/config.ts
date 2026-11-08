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
  /** SQLite file for graves and payments. */
  dbPath: string;
  nearRpcUrls: string[];
  /** Account that receives the NEAR for graves and offerings. */
  treasury: string;
  /** USD price to create a grave, and the minimum offering in USD (paid in NEAR at the live price). */
  gravePriceUsd: string;
  offeringMinUsd: string;
  /** How long a plot + meme stay reserved (and an offering stays open) while the player pays. */
  holdMinutes: number;
  /** Memorial NFTs. Minting runs only when all three are set; otherwise memorials queue until it is. */
  nftContract: string | null;
  minterAccountId: string | null;
  /** ed25519:... key of minterAccountId. Never logged. */
  minterPrivateKey: string | null;
  /** Public origin of the game, e.g. https://restinpump.com (the NFT contract's base_uri is <this>/nft). */
  publicBaseUrl: string | null;
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
  for (const old of ['GRAVE_PRICES_WTH', 'GRAVE_PRICE_WTH', 'OFFERING_MIN_WTH', 'WTH_CONTRACT', 'WTH_DECIMALS']) {
    if (env[old]) throw new Error(`${old} is no longer used: graves and offerings are paid in NEAR (set GRAVE_PRICE_USD / OFFERING_MIN_USD)`);
  }
  const usd = (key: string, def: string) => {
    const v = (env[key] ?? def).trim();
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(v) || Number(v) <= 0) throw new Error(`${key} must be a positive USD amount like 0.01`);
    return v;
  };
  const opt = (key: string) => (env[key] ?? '').trim() || null;
  const nftContract = opt('NFT_CONTRACT'), minterAccountId = opt('MINTER_ACCOUNT_ID'), minterPrivateKey = opt('MINTER_PRIVATE_KEY');
  const publicBaseUrl = opt('PUBLIC_BASE_URL')?.replace(/\/+$/, '') ?? null;
  const mintVars = [nftContract, minterAccountId, minterPrivateKey];
  if (mintVars.some(Boolean) && !mintVars.every(Boolean)) {
    throw new Error('Memorial minting needs NFT_CONTRACT, MINTER_ACCOUNT_ID and MINTER_PRIVATE_KEY together (or none of them)');
  }
  if (minterPrivateKey && !/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,100}$/.test(minterPrivateKey)) throw new Error('MINTER_PRIVATE_KEY must look like ed25519:<base58>');
  if (nftContract && !publicBaseUrl) throw new Error('PUBLIC_BASE_URL is needed when minting is on (NFT metadata links point to it)');
  if (publicBaseUrl && !/^https?:\/\/[^/\s]+$/.test(publicBaseUrl)) throw new Error('PUBLIC_BASE_URL must be an origin like https://restinpump.com');
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
    dbPath: env.DB_PATH ?? 'data/rip.sqlite',
    nearRpcUrls: (env.NEAR_RPC_URLS ?? 'https://rpc.mainnet.fastnear.com,https://free.rpc.fastnear.com,https://rpc.mainnet.near.org').split(',').map((s) => s.trim()).filter(Boolean),
    treasury: env.TREASURY_ACCOUNT ?? 'whatthehoot.near',
    gravePriceUsd: usd('GRAVE_PRICE_USD', '0.01'),
    offeringMinUsd: usd('OFFERING_MIN_USD', '0.01'),
    holdMinutes: int(env, 'HOLD_MINUTES', 15, 1, 120),
    nftContract, minterAccountId, minterPrivateKey, publicBaseUrl,
  };
}
