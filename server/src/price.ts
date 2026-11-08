/**
 * The NEAR/USD price, used to turn USD prices (a grave costs $0.01) into exact NEAR amounts.
 * Public sources are tried in order (CoinGecko, Coinbase, Kraken, Binance); a price is cached for a minute and never used when it is older than
 * MAX_AGE (then orders pause with a clear message instead of charging a guessed amount).
 */

export interface NearPrice {
  /** USD per NEAR, or null if no source answered recently. */
  usd(): Promise<number | null>;
}

type Source = () => Promise<number>;
const TTL = 60_000;
const MAX_AGE = 15 * 60_000;

const sane = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n) || n <= 0.01 || n > 10_000) throw new Error(`implausible NEAR price ${v}`);
  return n;
};

export const PRICE_SOURCES: Record<string, Source> = {
  coingecko: async () => {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    return sane(((await r.json()) as { near?: { usd?: number } }).near?.usd);
  },
  coinbase: async () => {
    const r = await fetch('https://api.coinbase.com/v2/prices/NEAR-USD/spot', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    return sane(((await r.json()) as { data?: { amount?: string } }).data?.amount);
  },
  kraken: async () => {
    const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=NEARUSD', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`kraken ${r.status}`);
    const j = (await r.json()) as { result?: Record<string, { c?: string[] }> };
    return sane(Object.values(j.result ?? {})[0]?.c?.[0]);
  },
  binance: async () => {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`binance ${r.status}`);
    return sane(((await r.json()) as { price?: string }).price);
  },
};

export function createNearPrice(sources: Source[] = Object.values(PRICE_SOURCES), onError?: (e: unknown) => void, now = () => Date.now()): NearPrice {
  let last: { usd: number; at: number } | null = null;
  let inflight: Promise<void> | null = null;
  const refresh = async () => {
    for (const s of sources) {
      try { last = { usd: await s(), at: now() }; return; } catch (e) { onError?.(e); }
    }
  };
  return {
    async usd() {
      if (!last || now() - last.at > TTL) {
        inflight ??= refresh().finally(() => { inflight = null; });
        // a fresh-enough cached price answers at once; otherwise wait for the refresh
        if (!last || now() - last.at > MAX_AGE) await inflight;
      }
      return last && now() - last.at <= MAX_AGE ? last.usd : null;
    },
  };
}

export { usdToYocto } from '../../shared/graves.ts';
