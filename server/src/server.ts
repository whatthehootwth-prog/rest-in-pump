import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import { RoomManager, type Player } from './rooms.ts';
import {
  MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION, parseClientMessage, sanitizeName,
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
  close(): Promise<void>;
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
  bad_name: 'Names must be 2-16 letters, numbers, spaces, dots, dashes or underscores.',
  rate_limited: 'Slow down — too many messages.',
};

export async function startServer(cfg: Config, log: Logger): Promise<GameServer> {
  const rooms = new RoomManager({ capacity: cfg.roomCapacity, maxRooms: cfg.maxRooms, graceMs: cfg.reconnectGraceMs });
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
        const name = sanitizeName(msg.name) ?? `Owl-${randomBytes(2).toString('hex').toUpperCase()}`;
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
      case 'rename': {
        const name = sanitizeName(msg.name);
        if (!name) return sendError(c, 'bad_name');
        rooms.rename(p.id, name);
        broadcastRoom(p.roomId, { t: 'renamed', id: p.id, name });
        log.info('player renamed', { player: p.id, name });
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
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
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
        p.id, r2(p.state.x), r2(p.state.y), r2(p.state.z), r3(p.state.yaw), r2(p.state.speed), p.state.air ? 1 : 0, p.state.walk,
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
    close: () => new Promise<void>((resolve) => {
      clearInterval(tick); clearInterval(sweeper); clearInterval(heartbeat);
      for (const c of clients) c.ws.close(1001, 'server shutting down');
      wss.close();
      httpServer.close(() => resolve());
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
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'",
};

function serveStatic(root: string, pathname: string, res: http.ServerResponse) {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
  let file = path.resolve(root, '.' + path.posix.normalize(rel));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
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
