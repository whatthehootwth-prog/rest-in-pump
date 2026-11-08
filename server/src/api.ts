import type http from 'node:http';
import type { GraveService, GraveError } from './graves.ts';
import type { Logger } from './log.ts';
import { isTxHash } from './near.ts';
import { NEAR_ACCOUNT_RE } from '../../shared/graves.ts';

/**
 * JSON HTTP API for graves (request/response flows with clear states).
 * Live changes are pushed to everyone over the game WebSocket.
 *
 *   GET  /api/config                    USD prices, NEAR amounts at the live price, treasury, whether minting is on
 *   GET  /api/graves                    all graves + reserved plots
 *   GET  /api/graves/:id?account=       one grave, recent offerings, the account's memorial + offering count
 *   GET  /api/meme?chain=&contract=     resolve a meme (name/symbol/logo) and whether it has a grave
 *   POST /api/payments                  { plot, chain, contract, message } hold a plot + meme, get the transfer
 *   POST /api/offerings                 { graveId, item, amount } get the transfer for an offering
 *   GET  /api/payments/:id              payment status (used to recover after a refresh)
 *   POST /api/payments/:id/confirm      { txHash, accountId } verify on NEAR, then create the grave / count the offering
 *   POST /api/payments/:id/cancel       release an unpaid hold
 *   GET  /api/balance?account=          the account's spendable NEAR (yoctoNEAR)
 */

const MAX_BODY = 4096;
const RATE = { perMin: 40, burst: 20 };

export function createApi(graves: GraveService, log: Logger, clientIp: (req: http.IncomingMessage) => string, balanceOf: (account: string) => Promise<string | null>) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const limited = (ip: string): boolean => {
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: RATE.burst, at: now };
    b.tokens = Math.min(RATE.burst, b.tokens + ((now - b.at) / 60000) * RATE.perMin);
    b.at = now;
    buckets.set(ip, b);
    if (buckets.size > 10000) buckets.clear();
    if (b.tokens < 1) return true;
    b.tokens -= 1;
    return false;
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const fail = (res: http.ServerResponse, e: GraveError) => send(res, e.status, { error: { code: e.code, message: e.message } });
  const isErr = (v: unknown): v is GraveError => !!v && typeof v === 'object' && 'code' in v && 'status' in v;

  const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown> | null> => new Promise((resolve) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) { resolve(null); return; }
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });

  /** Returns true if the request was an API request (handled here). */
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/')) return false;
    const ip = clientIp(req);
    const parts = url.pathname.split('/').filter(Boolean);   // ['api', ...]
    try {
      if (req.method === 'GET' && url.pathname === '/api/config') { send(res, 200, await graves.config()); return true; }
      if (req.method === 'GET' && url.pathname === '/api/graves') { send(res, 200, graves.snapshot()); return true; }
      if (req.method === 'GET' && parts[1] === 'graves' && parts.length === 3) {
        const out = graves.detail(parts[2], url.searchParams.get('account'));
        if (isErr(out)) fail(res, out); else send(res, 200, out);
        return true;
      }

      if (limited(ip)) { send(res, 429, { error: { code: 'rate_limited', message: 'Too many requests. Wait a moment.' } }); return true; }

      if (req.method === 'GET' && url.pathname === '/api/meme') {
        const out = await graves.lookup(url.searchParams.get('chain'), url.searchParams.get('contract'));
        if (isErr(out)) fail(res, out); else send(res, 200, out);
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/api/balance') {
        const account = url.searchParams.get('account') ?? '';
        if (!NEAR_ACCOUNT_RE.test(account)) { send(res, 400, { error: { code: 'bad_account', message: 'That is not a NEAR account.' } }); return true; }
        const balance = await balanceOf(account).catch(() => null);
        if (balance === null) send(res, 503, { error: { code: 'unavailable', message: 'Could not read the NEAR balance right now.' } });
        else send(res, 200, { account, balance });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/payments') {
        const body = await readJson(req);
        if (!body) { send(res, 400, { error: { code: 'bad_request', message: 'Expected a JSON body.' } }); return true; }
        const out = await graves.createGrave({ plot: body.plot, chain: body.chain, contract: body.contract, message: body.message }, ip, Date.now());
        if (isErr(out)) fail(res, out); else send(res, 201, out);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/offerings') {
        const body = await readJson(req);
        if (!body) { send(res, 400, { error: { code: 'bad_request', message: 'Expected a JSON body.' } }); return true; }
        const out = await graves.createOffering({ graveId: body.graveId, item: body.item, amount: body.amount }, ip, Date.now());
        if (isErr(out)) fail(res, out); else send(res, 201, out);
        return true;
      }
      if (parts[1] === 'payments' && parts.length >= 3) {
        const id = parts[2];
        if (req.method === 'GET' && parts.length === 3) {
          const out = graves.getPayment(id);
          if (isErr(out)) fail(res, out); else send(res, 200, out);
          return true;
        }
        if (req.method === 'POST' && parts[3] === 'cancel') {
          const out = graves.cancelPayment(id, Date.now());
          if (isErr(out)) fail(res, out); else send(res, 200, out);
          return true;
        }
        if (req.method === 'POST' && parts[3] === 'confirm') {
          const body = await readJson(req);
          if (!body || !isTxHash(body.txHash) || typeof body.accountId !== 'string') {
            send(res, 400, { error: { code: 'bad_request', message: 'Expected { txHash, accountId }.' } });
            return true;
          }
          const out = await graves.confirmPayment(id, body.txHash, body.accountId, Date.now());
          if (isErr(out)) fail(res, out); else send(res, 200, out);
          return true;
        }
      }
      send(res, 404, { error: { code: 'not_found', message: 'Unknown API route.' } });
    } catch (e) {
      log.error('api error', { path: url.pathname, err: e });
      send(res, 500, { error: { code: 'server_error', message: 'Something went wrong on the server.' } });
    }
    return true;
  };
}
