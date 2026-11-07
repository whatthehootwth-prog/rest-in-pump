import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type GameServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { PROTOCOL_VERSION, type ServerMessage } from '../../shared/protocol.ts';

/** A tiny test client that records every message it gets. */
class TestClient {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  private waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  closed: Promise<number>;
  private opened: Promise<void>;

  constructor(port: number, origin?: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : undefined);
    this.opened = new Promise<void>((res, rej) => { this.ws.once('open', () => res()); this.ws.once('error', rej); });
    this.opened.catch(() => {});
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    this.closed = new Promise((r) => this.ws.on('close', (code) => r(code)));
  }
  open() { return this.opened; }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  next<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 3000) {
    const found = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
    if (found) { this.msgs.splice(this.msgs.indexOf(found), 1); return Promise.resolve(found as Extract<ServerMessage, { t: T }>); }
    return new Promise<Extract<ServerMessage, { t: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), ms);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>),
        resolve: (m) => { clearTimeout(timer); this.msgs.splice(this.msgs.indexOf(m), 1); resolve(m as Extract<ServerMessage, { t: T }>); },
      });
    });
  }
  async hello(extra: Record<string, unknown> = {}) {
    await this.open();
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: null, resume: null, room: null, ...extra });
    return this.next('welcome');
  }
  close() { this.ws.close(); return this.closed; }
}

let server: GameServer | null = null;
const clients: TestClient[] = [];
async function boot(env: Record<string, string> = {}) {
  const cfg = loadConfig({ PORT: '0', ROOM_CAPACITY: '2', MAX_ROOMS: '2', RECONNECT_GRACE_MS: '400', SNAPSHOT_HZ: '30', STATIC_DIR: '', ...env });
  server = await startServer(cfg, silentLogger);
  return server.port;
}
const client = (port: number, origin?: string) => { const c = new TestClient(port, origin); clients.push(c); return c; };

afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await server?.close();
  server = null;
});

describe('game server', () => {
  it('two players see each other join and move', async () => {
    const port = await boot();
    const a = client(port), b = client(port);
    const wa = await a.hello({ name: 'Alice' });
    expect(wa.players.map((p) => p.name)).toEqual(['Alice']);
    const wb = await b.hello({ name: 'Bob' });
    expect(wb.players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
    const joined = await a.next('player_joined');
    expect(joined.p).toMatchObject({ id: wb.you, name: 'Bob', connected: true });
    await a.next('online', (m) => m.total === 2);

    const me = wb.players.find((p) => p.id === wb.you)!.state;
    b.send({ t: 'state', s: { ...me, x: me.x + 0.2, speed: 1.8, walk: 4 } });
    const snap = await a.next('snapshot', (m) => m.s.some((e) => e[0] === wb.you && e[7] === 4));
    const entry = snap.s.find((e) => e[0] === wb.you)!;
    expect(entry[1]).toBeCloseTo(me.x + 0.2, 1);
  });

  it('keeps a dropped player during the grace period and lets them resume', async () => {
    const port = await boot();
    const a = client(port), b = client(port);
    await a.hello({ name: 'Alice' });
    const wb = await b.hello({ name: 'Bob' });
    await b.close();
    await a.next('presence', (m) => m.id === wb.you && !m.connected);

    const b2 = client(port);
    const again = await b2.hello({ resume: wb.session });
    expect(again).toMatchObject({ resumed: true, you: wb.you });
    await a.next('presence', (m) => m.id === wb.you && m.connected);
  });

  it('removes a dropped player after the grace period', async () => {
    const port = await boot();
    const a = client(port), b = client(port);
    await a.hello();
    const wb = await b.hello();
    await b.close();
    await a.next('player_left', (m) => m.id === wb.you, 3000);
    const b2 = client(port);
    const fresh = await b2.hello({ resume: wb.session });
    expect(fresh.resumed).toBe(false);
    expect(fresh.you).not.toBe(wb.you);
  });

  it('enforces room capacity by opening another room, then refuses when full', async () => {
    const port = await boot();
    const rooms: string[] = [];
    for (let i = 0; i < 4; i++) rooms.push((await client(port).hello()).room.id);
    expect(rooms).toEqual(['graveyard-1', 'graveyard-1', 'graveyard-2', 'graveyard-2']);
    const late = client(port);
    await late.open();
    late.send({ t: 'hello', v: PROTOCOL_VERSION, name: null, resume: null, room: null });
    expect(await late.next('error')).toMatchObject({ code: 'server_full', fatal: true });
    await late.closed;
  });

  it('lets a player switch rooms and tells both rooms', async () => {
    const port = await boot({ ROOM_CAPACITY: '3' });
    const a = client(port), b = client(port);
    await a.hello();
    const wb = await b.hello();
    b.send({ t: 'join_room', room: 'graveyard-2' });
    const moved = await b.next('welcome');
    expect(moved.room.id).toBe('graveyard-2');
    expect(moved.players.map((p) => p.id)).toEqual([wb.you]);
    await a.next('player_left', (m) => m.id === wb.you);
  });

  it('rejects old clients, bad messages and foreign origins', async () => {
    const port = await boot();
    const old = client(port);
    await old.open();
    old.send({ t: 'hello', v: PROTOCOL_VERSION + 1 });
    expect(await old.next('error')).toMatchObject({ code: 'bad_version', fatal: true });
    expect(await old.closed).toBe(4000);

    const junk = client(port);
    await junk.open();
    junk.ws.send('{"t":"state","s":"teleport"}');
    expect(await junk.next('error')).toMatchObject({ code: 'bad_message' });
    junk.send({ t: 'state', s: { x: 0, y: 0, z: 0, yaw: 0, speed: 0, air: false, walk: 0 } });
    expect(await junk.next('error')).toMatchObject({ code: 'not_joined' });

    const evil = client(port, 'https://evil.example');
    await expect(evil.open()).rejects.toThrow();
  });

  it('renames with validation', async () => {
    const port = await boot();
    const a = client(port), b = client(port);
    await a.hello({ name: 'Alice' });
    const wb = await b.hello({ name: 'Bob' });
    b.send({ t: 'rename', name: '<b>' });
    expect(await b.next('error')).toMatchObject({ code: 'bad_name' });
    b.send({ t: 'rename', name: 'Bobby' });
    expect(await a.next('renamed')).toEqual({ t: 'renamed', id: wb.you, name: 'Bobby' });
  });

  it('serves a health check', async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION });
  });
});
