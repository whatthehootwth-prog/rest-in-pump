import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import { RoomManager, type Player } from './rooms.ts';
import { openDb, type Db } from './db.ts';
import { GraveService } from './graves.ts';
import { createNearPrice, type NearPrice } from './price.ts';
import { createApi, createRateLimiter } from './api.ts';
import { MemorialMinter, nearMemorialChain, type MemorialChain } from './minter.ts';
import { createNftRoutes } from './nft.ts';
import { sillyName } from './names.ts';
import { Buyback, nearBuybackChain, type BuybackChain } from './buyback.ts';
import { parseUnits } from '../../shared/graves.ts';
import { createSolanaLookup } from './solana.ts';
import { createNearRpc, fetchFtMetadata, nearBalance, verifyNearTransfer, type MetadataResult, type TransferCheck, type TransferResult } from './near.ts';
import {
  MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION, parseClientMessage, sanitizeChat,
  type ClientMessage, type ErrorCode, type ServerMessage, type SnapshotEntry,
} from '../../shared/protocol.ts';

/** One open WebSocket. A client is "joined" once its hello was accepted. */
interface Client {
  ws: WebSocket;
  ip: string;
  connId: string;
  playerId: string | null;
  alive: boolean;
  tokens: number;
  lastRefill: number;
  violations: number;
  lastRateWarn: number;
}

export interface GameServer {
  port: number;
  rooms: RoomManager;
  graves: GraveService;
  close(): Promise<void>;
}

/** Test seams: replace the NEAR calls (everything else is real). */
export interface ServerOptions {
  near?: { lookup(contract: string): Promise<MetadataResult>; verify(c: TransferCheck): Promise<TransferResult> };
  /** Replaces the Solana token lookup. */
  solanaLookup?: (mint: string) => Promise<MetadataResult>;
  db?: Db;
  /** Replaces the buyback chain (turns buyback on with test settings). */
  buybackChain?: BuybackChain;
  /** Replaces the live NEAR/USD price. */
  price?: NearPrice;
  /** Replaces the NEAR balance lookup. */
  balance?: (account: string) => Promise<string | null>;
  /** Replaces the Memorial NFT contract (turns minting on with minter id "minter.test"). */
  memorialChain?: MemorialChain;
}

// Rate limit: a steady 40 messages/s with bursts of 60 (state updates are sent at 15/s).
const RATE_PER_SEC = 40;
const RATE_BURST = 60;
const MAX_VIOLATIONS = 200;
const HEARTBEAT_MS = 15000;

const ERROR_TEXT: Record<ErrorCode, string> = {
  bad_version: 'Your game version is out of date. Reload the page to update.',
  bad_message: 'The server could not read a message from your game.',
  not_joined: 'You are not in a room yet.',
  already_joined: 'You are already in the world.',
  room_full: 'That graveyard is full.',
  server_full: 'The graveyard is full right now.',
  unknown_room: 'That graveyard does not exist.',
  rate_limited: 'Slow down — too many messages.',
  bad_chat: 'Chat messages must be 1-140 characters.',
  chat_too_fast: 'You are chatting too fast. Wait a moment.',
};

export async function startServer(cfg: Config, log: Logger, opts: ServerOptions = {}): Promise<GameServer> {
  const rooms = new RoomManager({ capacity: cfg.roomCapacity, maxRooms: cfg.maxRooms, graceMs: cfg.reconnectGraceMs });
  const db = opts.db ?? openDb(cfg.dbPath);
  const rpc = createNearRpc(cfg.nearRpcUrls);
  const solanaLookup = opts.solanaLookup ?? createSolanaLookup({ rpcUrls: cfg.solanaRpcUrls });
  const mintingConfigured = !!(cfg.nftContract && cfg.minterAccountId && cfg.minterPrivateKey);
  const priceSource = opts.price ?? createNearPrice(undefined, (err) => log.warn('NEAR price source failed', { err: String((err as Error)?.message ?? err) }));
  const broadcastAll = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.playerId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  };
  const graves = new GraveService({
    db, log: log.child({ mod: 'graves' }), receiver: cfg.treasury,
    gravePriceUsd: cfg.gravePriceUsd,
    price: priceSource,
    holdMinutes: cfg.holdMinutes, nftContract: cfg.nftContract, mintingEnabled: mintingConfigured || !!opts.memorialChain,
    lookupMeme: (chain, contract) => chain === 'solana'
      ? solanaLookup(contract)
      : (opts.near?.lookup ?? ((c: string) => fetchFtMetadata(rpc, c)))(contract),
    verify: opts.near?.verify ?? ((check) => verifyNearTransfer(rpc, check)),
    onGraveAdded: (grave) => broadcastAll({ t: 'grave_added', grave }),
    onReservedChanged: (reserved) => broadcastAll({ t: 'plots_reserved', reserved }),
    onGraveUpdated: (grave, offering) => broadcastAll({ t: 'grave_updated', grave, offering }),
    onMemorialQueued: () => kickMinter(),
  });
  // Memorial NFT minting (memorials queue in the db and mint once this is configured)
  const memorialChain = opts.memorialChain ?? (mintingConfigured
    ? nearMemorialChain({ rpc, rpcUrls: cfg.nearRpcUrls, contract: cfg.nftContract!, minterId: cfg.minterAccountId!, privateKey: cfg.minterPrivateKey! })
    : null);
  const minter = memorialChain
    ? new MemorialMinter({ db, log: log.child({ mod: 'minter' }), graves, chain: memorialChain, minterId: opts.memorialChain ? 'minter.test' : cfg.minterAccountId! })
    : null;
  if (!minter) log.warn('Memorial NFT minting is off (set NFT_CONTRACT, MINTER_ACCOUNT_ID, MINTER_PRIVATE_KEY) — memorials queue until it is on');
  function kickMinter() { void minter?.run().catch((err) => log.error('memorial minting failed', { err })); }
  // buyback rounds (off unless BUYBACK_ACCOUNT_ID / BUYBACK_PRIVATE_KEY are set)
  const bbCfg = cfg.buyback ?? (opts.buybackChain ? {
    account: 'buyback.test', privateKey: '', teamWallet: 'team.test', thresholdUsd: 20, teamPercent: 20, reserveNear: '0.5', minHoldingWth: '100000', exclude: [],
  } : null);
  const buyback = bbCfg ? new Buyback({
    db, log: log.child({ mod: 'buyback' }), price: priceSource,
    chain: opts.buybackChain ?? nearBuybackChain({ rpc, rpcUrls: cfg.nearRpcUrls, account: bbCfg.account, privateKey: bbCfg.privateKey }),
    account: bbCfg.account, teamWallet: bbCfg.teamWallet, thresholdUsd: bbCfg.thresholdUsd, teamPercent: bbCfg.teamPercent,
    reserve: parseUnits(bbCfg.reserveNear, 24), minHolding: parseUnits(bbCfg.minHoldingWth, 18), exclude: bbCfg.exclude,
  }) : null;
  const buybackInfo = () => ({
    enabled: !!buyback, thresholdUsd: bbCfg?.thresholdUsd ?? null, teamPercent: bbCfg?.teamPercent ?? null, teamWallet: bbCfg?.teamWallet ?? null,
    account: bbCfg?.account ?? null, minHoldingWth: bbCfg?.minHoldingWth ?? null, collected: buyback?.collected ?? null, rounds: buyback?.history() ?? [],
  });
  const clientIp = (req: http.IncomingMessage) =>
    (cfg.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '') || req.socket.remoteAddress || '?';
  const previewLimit = createRateLimiter({ perMin: 30, burst: 15 });
  const nft = createNftRoutes(graves, log.child({ mod: 'nft' }), cfg.publicBaseUrl, cfg.nftContract, (req) => previewLimit(clientIp(req)));
  const api = createApi(graves, log.child({ mod: 'api' }), clientIp, opts.balance ?? ((account) => nearBalance(rpc, account)), () => buybackInfo());
  const clients = new Set<Client>();
  const byPlayer = new Map<string, Client>();
  const dirtyRooms = new Set<string>();
  let onlineDirty = false;
  const startedAt = Date.now();
  const maxConnections = cfg.roomCapacity * cfg.maxRooms + 50;

  // ------------------------------------------------------------------ sending
  const send = (c: Client, msg: ServerMessage) => {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const sendError = (c: Client, code: ErrorCode, fatal = false) => send(c, { t: 'error', code, message: ERROR_TEXT[code], fatal });
  const broadcastRoom = (roomId: string, msg: ServerMessage, exceptPlayer?: string) => {
    const data = JSON.stringify(msg);
    for (const p of rooms.playersIn(roomId)) {
      if (p.id === exceptPlayer || !p.connected) continue;
      const c = byPlayer.get(p.id);
      if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  };
  const welcome = (c: Client, p: Player, resumed: boolean) => send(c, {
    t: 'welcome', v: PROTOCOL_VERSION, you: p.id, session: p.session, resumed,
    room: rooms.summary(p.roomId), players: rooms.playersIn(p.roomId).map((q) => rooms.info(q)),
  });

  // ------------------------------------------------------------------ message handling
  const handle = (c: Client, msg: ClientMessage) => {
    const now = Date.now();
    if (msg.t === 'ping') return send(c, { t: 'pong', n: msg.n });
    if (msg.t === 'list_rooms') return send(c, { t: 'rooms', rooms: rooms.summaries() });

    if (msg.t === 'hello') {
      if (c.playerId) return sendError(c, 'already_joined');
      if (msg.v !== PROTOCOL_VERSION) { sendError(c, 'bad_version', true); c.ws.close(4000, 'bad_version'); return; }
      const resumed = msg.resume ? rooms.resume(msg.resume, now) : null;
      if (resumed) {
        bind(c, resumed);
        welcome(c, resumed, true);
        broadcastRoom(resumed.roomId, { t: 'presence', id: resumed.id, connected: true }, resumed.id);
        log.info('player resumed', { conn: c.connId, player: resumed.id, room: resumed.roomId });
      } else {
        // every player gets a random silly name from the server (the hello's name is ignored)
        const name = sillyName(new Set(rooms.summaries().flatMap((r) => rooms.playersIn(r.id).map((q) => q.name))));
        const res = rooms.join(name, msg.room, now);
        if (!res.ok && msg.room && (res.code === 'room_full' || res.code === 'unknown_room')) {
          // their remembered room is gone or full: put them anywhere rather than refusing entry
          const retry = rooms.join(name, null, now);
          if (retry.ok) return accept(c, retry.player);
          return refuse(c, retry.code);
        }
        if (!res.ok) return refuse(c, res.code);
        accept(c, res.player);
      }
      onlineDirty = true;
      return;
    }

    if (!c.playerId) return sendError(c, 'not_joined');
    const p = rooms.get(c.playerId);
    if (!p) return sendError(c, 'not_joined');

    switch (msg.t) {
      case 'state':
        if (rooms.applyState(p.id, msg.s, now)) dirtyRooms.add(p.roomId);
        return;
      case 'chat': {
        const text = sanitizeChat(msg.text);
        if (!text) return sendError(c, 'bad_chat');
        if (!rooms.allowChat(p.id, now)) return sendError(c, 'chat_too_fast');
        broadcastRoom(p.roomId, { t: 'chat', id: p.id, name: p.name, text, ts: now });
        log.debug('chat', { player: p.id, len: text.length });
        return;
      }
      case 'join_room': {
        const res = rooms.move(p.id, msg.room, now);
        if (!res.ok) return sendError(c, res.code);
        if (res.from === res.to) return welcome(c, p, false);
        broadcastRoom(res.from, { t: 'player_left', id: p.id });
        welcome(c, p, false);
        broadcastRoom(res.to, { t: 'player_joined', p: rooms.info(p) }, p.id);
        onlineDirty = true;
        log.info('player changed room', { player: p.id, from: res.from, to: res.to });
        return;
      }
    }
  };

  const bind = (c: Client, p: Player) => {
    c.playerId = p.id;
    byPlayer.set(p.id, c);
  };
  const accept = (c: Client, p: Player) => {
    bind(c, p);
    welcome(c, p, false);
    broadcastRoom(p.roomId, { t: 'player_joined', p: rooms.info(p) }, p.id);
    onlineDirty = true;
    log.info('player joined', { conn: c.connId, player: p.id, room: p.roomId, ip: c.ip });
  };
  const refuse = (c: Client, code: ErrorCode) => {
    sendError(c, code, true);
    log.warn('join refused', { conn: c.connId, code });
    c.ws.close(4001, code);
  };

  const onClose = (c: Client) => {
    clients.delete(c);
    if (!c.playerId) return;
    if (byPlayer.get(c.playerId) === c) byPlayer.delete(c.playerId);
    const p = rooms.get(c.playerId);
    if (!p) return;
    const roomId = p.roomId;
    const still = rooms.markDisconnected(p.id, Date.now());
    if (still && rooms.get(p.id)) broadcastRoom(roomId, { t: 'presence', id: p.id, connected: false });
    else broadcastRoom(roomId, { t: 'player_left', id: p.id });
    onlineDirty = true;
    log.info('player disconnected', { conn: c.connId, player: p.id, room: roomId });
  };

  const allowRate = (c: Client): boolean => {
    const now = Date.now();
    c.tokens = Math.min(RATE_BURST, c.tokens + ((now - c.lastRefill) / 1000) * RATE_PER_SEC);
    c.lastRefill = now;
    if (c.tokens >= 1) { c.tokens -= 1; return true; }
    c.violations++;
    if (now - c.lastRateWarn > 1000) { c.lastRateWarn = now; sendError(c, 'rate_limited'); }
    if (c.violations > MAX_VIOLATIONS) { log.warn('closing abusive connection', { conn: c.connId, ip: c.ip }); c.ws.close(1008, 'rate_limited'); }
    return false;
  };

  // ------------------------------------------------------------------ http + websocket
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (await api(req, res, url)) return;
    if (nft(req, res, url)) return;
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), protocol: PROTOCOL_VERSION,
        connections: clients.size, players: rooms.connectedCount(), rooms: rooms.roomIds().length,
      }));
      return;
    }
    if (cfg.staticDir && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(cfg.staticDir, url.pathname, res);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    if (!originAllowed(req.headers.origin, cfg.allowedOrigins)) {
      log.warn('websocket origin rejected', { origin: req.headers.origin });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    if (clients.size >= maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const fwd = cfg.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
      const c: Client = {
        ws, ip: fwd || req.socket.remoteAddress || '?', connId: randomBytes(4).toString('hex'), playerId: null,
        alive: true, tokens: RATE_BURST, lastRefill: Date.now(), violations: 0, lastRateWarn: 0,
      };
      clients.add(c);
      ws.on('pong', () => { c.alive = true; });
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary || !allowRate(c)) return;
        const msg = parseClientMessage(data.toString());
        if (!msg) { c.violations += 5; sendError(c, 'bad_message'); return; }
        try { handle(c, msg); } catch (err) { log.error('message handler failed', { conn: c.connId, type: msg.t, err }); }
      });
      ws.on('close', () => onClose(c));
      ws.on('error', (err) => log.debug('socket error', { conn: c.connId, err }));
    });
  });

  // ------------------------------------------------------------------ timers
  const tick = setInterval(() => {
    const ts = Date.now();
    for (const roomId of dirtyRooms) {
      const s: SnapshotEntry[] = rooms.playersIn(roomId).filter((p) => p.connected).map((p) => [
        p.id, r2(p.state.x), r2(p.state.y), r2(p.state.z), r3(p.state.yaw), r2(p.state.speed), p.state.air ? 1 : 0, p.state.walk, p.state.emote,
      ]);
      broadcastRoom(roomId, { t: 'snapshot', ts, s });
    }
    dirtyRooms.clear();
    if (onlineDirty) {
      onlineDirty = false;
      const total = rooms.connectedCount();
      for (const c of clients) {
        if (!c.playerId) continue;
        const p = rooms.get(c.playerId);
        if (p) send(c, { t: 'online', total, room: rooms.connectedCount(p.roomId) });
      }
    }
  }, Math.round(1000 / cfg.snapshotHz));

  const sweeper = setInterval(() => {
    for (const p of rooms.sweep(Date.now())) {
      broadcastRoom(p.roomId, { t: 'player_left', id: p.id });
      onlineDirty = true;
      log.info('player timed out', { player: p.id, room: p.roomId });
    }
  }, Math.min(1000, Math.max(50, cfg.reconnectGraceMs / 4)));

  // payments: expire unpaid holds, re-check interrupted verifications
  let sweeping = false;
  const paymentSweep = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    graves.sweep(Date.now()).catch((err) => log.error('payment sweep failed', { err })).finally(() => { sweeping = false; });
  }, 15000);
  void graves.sweep(Date.now()).catch((err) => log.error('payment sweep failed', { err }));
  const mintTimer = setInterval(kickMinter, 20000);
  const buybackTimer = setInterval(() => void buyback?.run(), 10 * 60_000);
  void buyback?.run();
  kickMinter();

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }, HEARTBEAT_MS);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(cfg.port, cfg.host, () => resolve());
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
  log.info('server listening', { host: cfg.host, port, rooms: cfg.maxRooms, capacity: cfg.roomCapacity, static: cfg.staticDir });

  return {
    port,
    rooms,
    graves,
    close: () => new Promise<void>((resolve) => {
      clearInterval(tick); clearInterval(sweeper); clearInterval(heartbeat); clearInterval(paymentSweep); clearInterval(mintTimer); clearInterval(buybackTimer);
      for (const c of clients) c.ws.close(1001, 'server shutting down');
      wss.close();
      httpServer.close(() => { if (!opts.db) db.close(); resolve(); });
      setTimeout(() => { for (const c of clients) c.ws.terminate(); }, 2000).unref();
    }),
  };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function originAllowed(origin: string | undefined, allowed: string[] | null): boolean {
  if (allowed) return !!origin && allowed.includes(origin);
  // development: no list configured -> local pages and non-browser tools only
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  // other pages (even ones that opened us) get no handle on this window; our own wallet popups still work
  'cross-origin-opener-policy': 'same-origin-allow-popups',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: https:; frame-src https:; frame-ancestors 'none'; base-uri 'self'",
};

/** True if `file` is `dir` itself or inside it (by whole path parts: dist/client-private is not inside dist/client). */
export function insideDir(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse) {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
  // a decoded backslash (%5c) or NUL would be a path separator / terminator on some systems: never part of our URLs
  if (/[\\\0]/.test(rel)) { res.writeHead(400).end(); return; }
  let file = path.resolve(root, '.' + path.posix.normalize(rel));
  if (!insideDir(root, file)) { res.writeHead(403).end(); return; }
  let st = safeStat(file);
  if (st?.isDirectory()) { file = path.join(file, 'index.html'); st = safeStat(file); }
  if (!st) { file = path.join(root, 'index.html'); st = safeStat(file); }  // single-page app fallback
  if (!st) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

function safeStat(p: string) {
  try { return statSync(p); } catch { return null; }
}
