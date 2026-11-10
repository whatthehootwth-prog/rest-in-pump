import { isIP } from 'node:net';
import sharp from 'sharp';
import { SOLANA_MINT_RE } from '../../shared/graves.ts';
import type { MetadataResult } from './near.ts';

/**
 * Solana memecoins for graves (payment stays in NEAR). For a mint address:
 *   1. Solana RPC confirms it is a real SPL / Token-2022 mint and gives its decimals (Token-2022 mints may also
 *      carry name / symbol / uri in their metadata extension),
 *   2. Jupiter's public token list gives the name, ticker and logo for almost every traded token (pump.fun included),
 *   3. the logo (a web link on Solana) is downloaded once, checked, and shrunk to a 128 px WebP data URI, so graves
 *      never load images from other sites and the grave list stays small.
 */

const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max) : '');

interface MintInfo { decimals: number | null; ext: { name?: string; symbol?: string; uri?: string } | null }

export function createSolanaLookup(o: { rpcUrls: string[]; timeoutMs?: number; fetchImpl?: typeof fetch }) {
  const timeout = o.timeoutMs ?? 10_000;
  const f = o.fetchImpl ?? fetch;

  /** getAccountInfo over the RPC endpoints in order. null = no such account; 'down' = no endpoint answered. */
  async function mintInfo(mint: string): Promise<MintInfo | null | 'not_mint' | 'down'> {
    for (const url of o.rpcUrls) {
      try {
        const r = await f(url, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed' }] }),
        });
        if (!r.ok) continue;
        const j = (await r.json()) as { result?: { value: null | { owner?: string; data?: { parsed?: { type?: string; info?: Record<string, unknown> } } } }; error?: unknown };
        if (j.error || !j.result) continue;
        const v = j.result.value;
        if (!v) return null;
        if (!TOKEN_PROGRAMS.has(v.owner ?? '') || v.data?.parsed?.type !== 'mint') return 'not_mint';
        const info = v.data.parsed.info ?? {};
        const exts = Array.isArray(info.extensions) ? (info.extensions as { extension?: string; state?: Record<string, unknown> }[]) : [];
        const meta = exts.find((e) => e.extension === 'tokenMetadata')?.state;
        return {
          decimals: Number.isInteger(info.decimals) ? (info.decimals as number) : null,
          ext: meta ? { name: clean(meta.name, 64), symbol: clean(meta.symbol, 24), uri: typeof meta.uri === 'string' ? meta.uri : undefined } : null,
        };
      } catch { /* next endpoint */ }
    }
    return 'down';
  }

  async function jupiter(mint: string): Promise<{ name: string; symbol: string; icon: string | null } | null> {
    try {
      const r = await f(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`, { signal: AbortSignal.timeout(timeout) });
      if (!r.ok) return null;
      const list = (await r.json()) as { id?: string; name?: string; symbol?: string; icon?: string }[];
      const t = Array.isArray(list) ? list.find((x) => x.id === mint) : undefined;
      if (!t) return null;
      return { name: clean(t.name, 64), symbol: clean(t.symbol, 24), icon: typeof t.icon === 'string' ? t.icon : null };
    } catch { return null; }
  }

  /** Tickers like "$WIF": the game adds the "$" itself. */
  const ticker = (s: string) => s.replace(/^\$+/, '').trim();

  return async function lookupSolana(mint: string): Promise<MetadataResult> {
    if (!SOLANA_MINT_RE.test(mint)) return { ok: false, code: 'not_found', message: 'That does not look like a Solana token address.' };
    const info = await mintInfo(mint);
    if (info === 'down') return { ok: false, code: 'unavailable', message: 'Could not reach Solana right now. Try again in a minute.' };
    if (info === null) return { ok: false, code: 'not_found', message: 'No Solana account with that address.' };
    if (info === 'not_mint') return { ok: false, code: 'not_token', message: 'That Solana address is not a token.' };
    let name = '', symbol = '', iconUrl: string | null = null;
    const jup = await jupiter(mint);
    if (jup) ({ name, symbol, icon: iconUrl } = jup);
    if ((!name || !symbol) && info.ext) {
      name ||= info.ext.name ?? ''; symbol ||= info.ext.symbol ?? '';
      if (!iconUrl && info.ext.uri) iconUrl = await imageFromJson(info.ext.uri, f, timeout);
    }
    symbol = ticker(symbol);
    if (!name && !symbol) return { ok: false, code: 'not_token', message: "We couldn't find this token's name and logo." };
    const icon = iconUrl ? await iconDataUri(iconUrl, f, timeout) : null;
    return { ok: true, meta: { name: name || symbol, symbol: symbol || name, decimals: info.decimals, icon } };
  };
}

// ------------------------------------------------------------------ logos

/** Public IPFS gateways, tried in turn (single gateways often rate-limit). */
const IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://4everland.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://ipfs.io/ipfs/'];
const CID = '(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})';
const IPFS_FORMS = [
  new RegExp(`^ipfs://(?:ipfs/)?${CID}(/[^?#]*)?`),
  new RegExp(`^https://[^/]+/ipfs/${CID}(/[^?#]*)?`),
  new RegExp(`^https://${CID}\\.ipfs\\.[^/]+(/[^?#]*)?`),
];

/** The links to try for a logo / metadata URL: IPFS content (ipfs://, /ipfs/<cid>, <cid>.ipfs.<host>) also via other gateways. */
export function candidateUrls(raw: string): string[] {
  const s = raw.trim();
  let m: RegExpExecArray | null = null;
  for (const re of IPFS_FORMS) if ((m = re.exec(s))) break;
  if (!m) return [s];
  const tail = m[1] + (m[2] && m[2] !== '/' ? m[2] : '');
  return [...new Set([...(s.startsWith('https://') ? [s] : []), ...IPFS_GATEWAYS.map((g) => g + tail)])];
}

/** Public https URLs only; no IP literals, no localhost. */
function safeUrl(raw: string): URL | null {
  const s = raw.trim();
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || /^(localhost|.*\.local|.*\.internal)$/i.test(host)) return null;
  return u;
}

/** Tries each candidate link until one answers with the body. */
async function fetchBody(raw: string, f: typeof fetch, timeout: number): Promise<Buffer | null> {
  for (const u of candidateUrls(raw)) {
    try {
      const r = await safeFetch(u, f, timeout);
      const buf = r ? await readLimited(r) : null;
      if (buf) return buf;
    } catch { /* next */ }
  }
  return null;
}

/** Fetches with manual redirects so every hop is re-checked. */
async function safeFetch(raw: string, f: typeof fetch, timeout: number): Promise<Response | null> {
  let url = safeUrl(raw);
  for (let hop = 0; url && hop < 4; hop++) {
    const r = await f(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); url = loc ? safeUrl(new URL(loc, url).toString()) : null; continue; }
    return r.ok ? r : null;
  }
  return null;
}

async function readLimited(r: Response): Promise<Buffer | null> {
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > MAX_IMAGE_BYTES) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.length > MAX_IMAGE_BYTES ? null : buf;
}

/** Token metadata JSON (Token-2022 uri) -> its image URL. */
async function imageFromJson(uri: string, f: typeof fetch, timeout: number): Promise<string | null> {
  try {
    const buf = await fetchBody(uri, f, timeout);
    const j = buf ? (JSON.parse(buf.toString('utf8')) as { image?: unknown }) : null;
    return typeof j?.image === 'string' ? j.image : null;
  } catch { return null; }
}

/** Any image link -> 128 x 128 WebP data URI (or null if it isn't a usable image). */
export async function iconDataUri(url: string, f: typeof fetch = fetch, timeout = 10_000): Promise<string | null> {
  try {
    const buf = await fetchBody(url, f, timeout);
    if (!buf) return null;
    const out = await sharp(buf, { limitInputPixels: 40_000_000 }).resize(128, 128, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch { return null; }
}
