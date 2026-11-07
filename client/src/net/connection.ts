import { PROTOCOL_VERSION, type ClientMessage, type ErrorCode, type ServerMessage } from '../../../shared/protocol.ts';

/** Every state the multiplayer connection can be in, so the UI can always say what is happening. */
export type NetStatus =
  | { kind: 'connecting'; attempt: number; retrying: boolean }
  | { kind: 'connected'; rttMs: number | null }
  | { kind: 'reconnecting'; attempt: number; retryAt: number }
  | { kind: 'offline'; attempt: number; retryAt: number }
  | { kind: 'refused'; code: ErrorCode; message: string; retryAt: number }
  | { kind: 'outdated'; message: string };

export interface HelloInfo { name: string | null; resume: string | null; room: string | null }

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const OPEN_TIMEOUT_MS = 8000;
const PING_EVERY_MS = 5000;
const DEAD_AFTER_MS = 15000;
/** After this many failed attempts in a row we call it "offline" instead of "reconnecting". */
const OFFLINE_AFTER = 4;

/**
 * One WebSocket to the game server with automatic, backed-off reconnection.
 * `hello()` is asked for the join details on every (re)connect so a reconnect resumes the same player.
 */
export class Connection {
  status: NetStatus = { kind: 'connecting', attempt: 1, retrying: false };
  private ws: WebSocket | null = null;
  private attempt = 0;
  private everConnected = false;
  private retryTimer: number | null = null;
  private openTimer: number | null = null;
  private pingTimer: number | null = null;
  private lastHeard = 0;
  private pingSeq = 0;
  private pingSent = new Map<number, number>();
  private stopped = false;
  private readonly url: string;
  private readonly hello: () => HelloInfo;
  private readonly statusListeners = new Set<(s: NetStatus) => void>();
  private readonly messageListeners = new Set<(m: ServerMessage) => void>();

  constructor(hello: () => HelloInfo, url = Connection.defaultUrl()) {
    this.hello = hello;
    this.url = url;
    window.addEventListener('online', () => this.retryNow());
  }

  static defaultUrl(): string {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  onStatus(fn: (s: NetStatus) => void): () => void { this.statusListeners.add(fn); fn(this.status); return () => this.statusListeners.delete(fn); }
  onMessage(fn: (m: ServerMessage) => void): () => void { this.messageListeners.add(fn); return () => this.messageListeners.delete(fn); }

  get connected(): boolean { return this.status.kind === 'connected'; }

  start(): void { this.stopped = false; this.open(); }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, 'bye');
    this.ws = null;
  }

  /** Skip the backoff wait (the "Retry now" button, or the browser coming back online). */
  retryNow(): void {
    if (this.stopped || this.status.kind === 'outdated' || this.status.kind === 'connected' || this.status.kind === 'connecting') return;
    this.open();
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.status.kind !== 'connected') return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  // ------------------------------------------------------------------ internals

  private setStatus(s: NetStatus) {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private open() {
    this.clearTimers();
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    this.attempt++;
    this.setStatus({ kind: 'connecting', attempt: this.attempt, retrying: this.everConnected || this.attempt > 1 });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.openTimer = window.setTimeout(() => ws.close(), OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.openTimer !== null) clearTimeout(this.openTimer);
      const h = this.hello();
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: h.name, resume: h.resume, room: h.room } satisfies ClientMessage));
    };
    ws.onmessage = (ev) => {
      this.lastHeard = performance.now();
      let msg: ServerMessage;
      try { msg = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      this.handleControl(msg);
      for (const fn of this.messageListeners) fn(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped || this.status.kind === 'outdated') return;
      if (this.status.kind === 'refused') { this.scheduleRetry(this.status.retryAt - Date.now()); return; }
      this.scheduleRetry();
    };
  }

  private handleControl(msg: ServerMessage) {
    if (msg.t === 'welcome') {
      this.attempt = 0;
      this.everConnected = true;
      this.setStatus({ kind: 'connected', rttMs: null });
      this.startPinging();
    } else if (msg.t === 'pong') {
      const sent = this.pingSent.get(msg.n);
      this.pingSent.delete(msg.n);
      if (sent !== undefined && this.status.kind === 'connected') this.setStatus({ kind: 'connected', rttMs: Math.round(performance.now() - sent) });
    } else if (msg.t === 'error' && msg.fatal) {
      if (msg.code === 'bad_version') this.setStatus({ kind: 'outdated', message: msg.message });
      else this.setStatus({ kind: 'refused', code: msg.code, message: msg.message, retryAt: Date.now() + 15000 });
    }
  }

  private startPinging() {
    this.lastHeard = performance.now();
    this.pingTimer = window.setInterval(() => {
      if (performance.now() - this.lastHeard > DEAD_AFTER_MS) { this.ws?.close(); return; }   // silent connection: start over
      const n = ++this.pingSeq;
      this.pingSent.set(n, performance.now());
      if (this.pingSent.size > 10) this.pingSent.delete(this.pingSent.keys().next().value as number);
      this.ws?.send(JSON.stringify({ t: 'ping', n } satisfies ClientMessage));
    }, PING_EVERY_MS);
  }

  private scheduleRetry(minDelay = 0) {
    // attempt is 0 right after losing a working connection: retry quickly first, then back off
    const base = BACKOFF_MS[Math.min(Math.max(this.attempt - 1, 0), BACKOFF_MS.length - 1)];
    const delay = Math.max(minDelay, base * (1 + Math.random() * 0.3));
    const retryAt = Date.now() + delay;
    if (this.status.kind !== 'refused') {
      this.setStatus(this.attempt >= OFFLINE_AFTER || !this.everConnected && this.attempt >= 2
        ? { kind: 'offline', attempt: this.attempt, retryAt }
        : { kind: 'reconnecting', attempt: this.attempt + 1, retryAt });
    }
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  private clearTimers() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.retryTimer = this.openTimer = this.pingTimer = null;
  }
}
