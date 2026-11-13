import type { ChainId, GraveDetail, GraveInfo, GravesSnapshot, MemeInfo, OfferingItem, PaymentView, PriceConfig } from '../../../shared/graves.ts';

export interface CoinSuggestion { contract: string; name: string; symbol: string; icon: string | null; plot: number | null }

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * This browser's random id. The server ties unfinished orders to it, so people sharing an IP (one Wi-Fi, one mobile
 * network) never share an order, and only this browser can confirm or cancel its own.
 */
const SESSION_KEY = 'rip.session';
let session: string | null = null;
function sessionId(): string {
  if (session) return session;
  try { const v = localStorage.getItem(SESSION_KEY); if (v && /^[A-Za-z0-9_-]{16,64}$/.test(v)) return (session = v); } catch { /* no storage */ }
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  session = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try { localStorage.setItem(SESSION_KEY, session); } catch { /* this tab only */ }
  return session;
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? { 'x-rip-session': sessionId() } : { 'content-type': 'application/json', 'x-rip-session': sessionId() },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('network', 'Could not reach the game server. Check your connection.', 0);
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(e?.code ?? 'http_' + res.status, e?.message ?? `The server answered ${res.status}.`, res.status);
  }
  return data as T;
}

/** Typed calls to the grave API (see server/src/api.ts). */
export const api = {
  config: () => request<PriceConfig>('GET', '/config'),
  graves: () => request<GravesSnapshot>('GET', '/graves'),
  /** Coins matching a name, ticker or address, for the grave dialog's suggestions. */
  search: (chain: ChainId, q: string) =>
    request<{ results: CoinSuggestion[] }>('GET', `/search?chain=${encodeURIComponent(chain)}&q=${encodeURIComponent(q)}`),
  meme: (chain: ChainId, contract: string) =>
    request<{ meme: MemeInfo; grave: GraveInfo | null }>('GET', `/meme?chain=${encodeURIComponent(chain)}&contract=${encodeURIComponent(contract)}`),
  grave: (id: number, account: string | null) =>
    request<GraveDetail>('GET', `/graves/${id}${account ? `?account=${encodeURIComponent(account)}` : ''}`),
  createGrave: (b: { plot: number; chain: ChainId; contract: string; message: string }) => request<PaymentView>('POST', '/payments', b),
  createOffering: (b: { graveId: number; item: OfferingItem }) => request<PaymentView>('POST', '/offerings', b),
  payment: (id: string) => request<PaymentView>('GET', `/payments/${encodeURIComponent(id)}`),
  confirm: (id: string, txHash: string, accountId: string) => request<PaymentView>('POST', `/payments/${encodeURIComponent(id)}/confirm`, { txHash, accountId }),
  cancel: (id: string) => request<PaymentView>('POST', `/payments/${encodeURIComponent(id)}/cancel`, {}),
  balance: (account: string) => request<{ account: string; balance: string }>('GET', `/balance?account=${encodeURIComponent(account)}`),
};
