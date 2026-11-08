import type { ChainId, GraveDetail, GraveInfo, GravesSnapshot, MemeInfo, OfferingItem, PaymentView, PriceConfig } from '../../../shared/graves.ts';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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
  meme: (chain: ChainId, contract: string) =>
    request<{ meme: MemeInfo; grave: GraveInfo | null }>('GET', `/meme?chain=${encodeURIComponent(chain)}&contract=${encodeURIComponent(contract)}`),
  grave: (id: number, account: string | null) =>
    request<GraveDetail>('GET', `/graves/${id}${account ? `?account=${encodeURIComponent(account)}` : ''}`),
  createGrave: (b: { plot: number; chain: ChainId; contract: string; message: string }) => request<PaymentView>('POST', '/payments', b),
  createOffering: (b: { graveId: number; item: OfferingItem; amount: string }) => request<PaymentView>('POST', '/offerings', b),
  payment: (id: string) => request<PaymentView>('GET', `/payments/${encodeURIComponent(id)}`),
  confirm: (id: string, txHash: string, accountId: string) => request<PaymentView>('POST', `/payments/${encodeURIComponent(id)}/confirm`, { txHash, accountId }),
  cancel: (id: string) => request<PaymentView>('POST', `/payments/${encodeURIComponent(id)}/cancel`, {}),
  balance: (account: string) => request<{ account: string; balance: string }>('GET', `/balance?account=${encodeURIComponent(account)}`),
};
