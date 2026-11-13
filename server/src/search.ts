import sharp from 'sharp';
import type { ChainId } from '../../shared/graves.ts';
import { iconDataUri, imageKind, publicFetch } from './solana.ts';

/**
 * Coin search for the "Dig a grave" field, so people can type a name or ticker instead of digging up the address.
 * Dead coins drop out of DexScreener's search once they stop trading, so this uses lists that keep them:
 *   NEAR    RHEA's full token list (about 8,000 tokens, dead ones included), downloaded and searched here
 *   Solana  Jupiter's token search (pump.fun coins with no trades still show up)
 * Coins that already have a grave come first and carry their plot. Logos are shrunk to small WebP data URIs on the
 * server (like grave logos), so browsers never load images from the sites token creators picked.
 */

export interface Suggestion {
  contract: string;
  name: string;
  symbol: string;
  /** Small data: URI logo, or null. */
  icon: string | null;
  /** Plot of the coin's grave, if it already has one. */
  plot: number | null;
}

export interface Buried { chain: string; contract: string; name: string; symbol: string; plot: number }

interface Token { contract: string; name: string; symbol: string; icon: string }

const RHEA_LIST = 'https://api.ref.finance/list-token';
const LIST_TTL = 6 * 60 * 60 * 1000;
const QUERY_TTL = 5 * 60 * 1000;
const MAX = 6;
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max) : '');

/** How well a token matches the query (lower is better), or null for no match. */
export function rank(t: { contract: string; name: string; symbol: string }, q: string): number | null {
  const sym = t.symbol.toLowerCase().replace(/^\$+/, ''), name = t.name.toLowerCase(), c = t.contract.toLowerCase();
  if (sym === q || c === q) return 0;
  if (c.split('.')[0] === q || c.split('.')[0].replace(/-[0-9a-f]+$|-\d+$/, '') === q) return 1;
  if (name === q) return 2;
  if (sym.startsWith(q)) return 3;
  if (name.startsWith(q)) return 4;
  if (c.startsWith(q)) return 5;
  if (sym.includes(q) || name.includes(q)) return 6;
  if (c.includes(q)) return 7;
  return null;
}

export function createTokenSearch(o: { buried: () => Buried[]; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const f = o.fetchImpl ?? fetch;
  const media = o.fetchImpl ?? publicFetch;
  const timeout = o.timeoutMs ?? 8000;
  let nearList: Token[] = [];
  let nearAt = 0;
  let nearLoading: Promise<void> | null = null;
  const queries = new Map<string, { at: number; out: Promise<Suggestion[]> }>();
  const icons = new Map<string, Promise<string | null>>();

  async function loadNear(): Promise<void> {
    try {
      const r = await f(RHEA_LIST, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) return;
      const j = (await r.json()) as Record<string, { name?: string; symbol?: string; icon?: string }>;
      const list: Token[] = [];
      for (const [contract, t] of Object.entries(j ?? {})) {
        if (!/^[a-z0-9._-]{2,64}$/.test(contract)) continue;
        list.push({ contract, name: clean(t?.name, 64), symbol: clean(t?.symbol, 24), icon: typeof t?.icon === 'string' ? t.icon : '' });
      }
      if (list.length) { nearList = list; nearAt = Date.now(); }
    } catch { /* keep the old list */ }
  }
  /** The list is fetched on first use and refreshed in the background every few hours. */
  async function near(): Promise<Token[]> {
    if (!nearList.length || Date.now() - nearAt > LIST_TTL) {
      nearLoading ??= loadNear().finally(() => { nearLoading = null; });
      if (!nearList.length) await nearLoading;
    }
    return nearList;
  }

  async function solana(q: string): Promise<Token[]> {
    try {
      const r = await f(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(timeout) });
      if (!r.ok) return [];
      const list = (await r.json()) as { id?: string; name?: string; symbol?: string; icon?: string }[];
      return (Array.isArray(list) ? list : [])
        .filter((t) => typeof t.id === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.id))
        .map((t) => ({ contract: t.id!, name: clean(t.name, 64), symbol: clean(t.symbol, 24).replace(/^\$+/, ''), icon: typeof t.icon === 'string' ? t.icon : '' }));
    } catch { return []; }
  }

  /** A logo as a small WebP data URI (cached). Inline data: logos are re-encoded too, never passed through. */
  function icon(src: string): Promise<string | null> {
    if (!src) return Promise.resolve(null);
    let p = icons.get(src);
    if (!p) {
      p = (async () => {
        if (src.startsWith('data:')) {
          const m = /^data:image\/[a-z0-9.+-]+(;charset=[^;,]*)?(;base64)?,(.*)$/is.exec(src);
          if (!m || src.length > 400_000) return null;
          const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
          if (!imageKind(buf)) return null;
          const out = await sharp(buf, { limitInputPixels: 40_000_000, animated: false }).resize(64, 64, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
          return `data:image/webp;base64,${out.toString('base64')}`;
        }
        return src.startsWith('https://') ? iconDataUri(src, media, timeout) : null;
      })().catch(() => null);
      if (icons.size > 2000) icons.clear();
      icons.set(src, p);
    }
    return p;
  }

  async function run(chain: ChainId, q: string, exact: string): Promise<Suggestion[]> {
    const buried = o.buried().filter((b) => b.chain === chain);
    const plotOf = new Map(buried.map((b) => [b.contract, b.plot]));
    const pool: Token[] = chain === 'near' ? await near() : await solana(exact);
    const seen = new Set<string>();
    const scored: { t: Token; r: number; plot: number | null }[] = [];
    // buried coins match by their own name too, and come first
    for (const b of buried) {
      const r = rank(b, q);
      if (r === null) continue;
      seen.add(b.contract);
      scored.push({ t: { contract: b.contract, name: b.name, symbol: b.symbol, icon: pool.find((t) => t.contract === b.contract)?.icon ?? '' }, r: r - 10, plot: b.plot });
    }
    pool.forEach((t, i) => {
      if (seen.has(t.contract)) return;
      // Jupiter already ranks its results (by relevance and liquidity); keep its order
      const r = chain === 'solana' ? i / 1000 : rank(t, q);
      if (r === null) return;
      seen.add(t.contract);
      scored.push({ t, r, plot: plotOf.get(t.contract) ?? null });
    });
    scored.sort((a, b) => a.r - b.r || a.t.symbol.length - b.t.symbol.length);
    return Promise.all(scored.slice(0, MAX).map(async ({ t, plot }) => ({
      contract: t.contract, name: t.name || t.symbol, symbol: t.symbol || t.name, icon: await icon(t.icon), plot,
    })));
  }

  return {
    /** Up to 6 coins matching a name, ticker or address. Results are cached for a few minutes. */
    search(chain: ChainId, raw: string): Promise<Suggestion[]> {
      const exact = raw.trim().replace(/^\$+/, '').slice(0, 64);   // Solana addresses are case-sensitive
      const q = exact.toLowerCase();
      if (q.length < 2 || (chain !== 'near' && chain !== 'solana')) return Promise.resolve([]);
      const key = `${chain}:${chain === 'solana' ? exact : q}`;
      const hit = queries.get(key);
      if (hit && Date.now() - hit.at < QUERY_TTL) return hit.out;
      const out = run(chain, q, exact);
      if (queries.size > 1000) queries.clear();
      queries.set(key, { at: Date.now(), out });
      out.catch(() => queries.delete(key));
      return out;
    },
    /** Starts downloading the NEAR list so the first search is fast. */
    warm(): void { void near(); },
  };
}
