import dns from 'node:dns';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
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
  /** Links from token metadata (logos, metadata JSON) never reach private networks. */
  const media = o.fetchImpl ?? publicFetch;

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
      if (!iconUrl && info.ext.uri) iconUrl = await imageFromJson(info.ext.uri, media, timeout);
    }
    symbol = ticker(symbol);
    if (!name && !symbol) return { ok: false, code: 'not_token', message: "We couldn't find this token's name and logo." };
    const icon = iconUrl ? await iconDataUri(iconUrl, media, timeout) : null;
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

/** Host names that never mean a public website. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

/** Public https URLs on the normal port only: no IP literals, no single-label or local names. DNS is checked on connect. */
export function safeUrl(raw: string): URL | null {
  const s = raw.trim();
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host || isIP(host) || !host.includes('.') || LOCAL_NAME.test(host)) return null;
  return u;
}

// ------------------------------------------------------------------ outbound requests that cannot reach private networks

const PRIVATE_NETS = new BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE_NETS.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) PRIVATE_NETS.addSubnet(a, p, 'ipv6');

/** True only for an address on the public internet (IPv4-mapped IPv6 is judged by its IPv4 part). */
export function isPublicIp(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return !PRIVATE_NETS.check(addr, 'ipv4');
  if (v !== 6) return false;
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (dotted) return isPublicIp(dotted[1]);
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); return isPublicIp(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
  return !PRIVATE_NETS.check(addr, 'ipv6');
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;
/** DNS lookup for outbound image requests: refuses the host if any of its addresses is not public. */
function publicLookup(host: string, opts: dns.LookupOptions, cb: LookupCb): void {
  dns.lookup(host, { ...opts, all: true }, (err, list) => {
    if (err) { cb(err, ''); return; }
    if (!list.length || list.some((a) => !isPublicIp(a.address))) {
      cb(Object.assign(new Error(`${host} does not resolve to a public address`), { code: 'EBLOCKED' }), '');
      return;
    }
    if (opts.all) cb(null, list); else cb(null, list[0].address, list[0].family);
  });
}

/**
 * fetch() for links taken from token metadata. The connection goes to the address publicLookup approved (so a DNS
 * answer cannot change between the check and the connect), TLS still checks the certificate against the host name,
 * and redirects are never followed here (safeFetch re-checks every hop).
 */
export function publicFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : input);
    // node skips the lookup for IP literals, so check those here
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !isPublicIp(literal)) { reject(Object.assign(new Error(`${literal} is not a public address`), { code: 'EBLOCKED' })); return; }
    const req = https.request(url, {
      method: 'GET', lookup: publicLookup as never, signal: init.signal ?? undefined, maxHeaderSize: 16 * 1024,
      headers: { accept: '*/*', 'user-agent': 'rest-in-pump-logo-fetch' },
    }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const status = res.statusCode ?? 502;
      if (status < 200 || status > 599 || status === 204 || status === 205 || status === 304) {
        res.resume();
        resolve(new Response(null, { status: status >= 200 && status <= 599 ? status : 502, headers }));
        return;
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream, { status, headers }));
    });
    req.on('error', reject);
    req.end();
  });
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
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      await r.body?.cancel().catch(() => {});
      url = loc ? safeUrl(new URL(loc, url).toString()) : null;
      continue;
    }
    if (r.ok) return r;
    await r.body?.cancel().catch(() => {});
    return null;
  }
  return null;
}

/** Reads at most `max` bytes: stops (and drops the connection) as soon as a body goes over, whatever it claimed. */
export async function readLimited(r: Response, max = MAX_IMAGE_BYTES): Promise<Buffer | null> {
  if (!r.body) return null;
  if (Number(r.headers.get('content-length') ?? 0) > max) { await r.body.cancel().catch(() => {}); return null; }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Token metadata JSON (Token-2022 uri) -> its image URL. */
async function imageFromJson(uri: string, f: typeof fetch, timeout: number): Promise<string | null> {
  try {
    const buf = await fetchBody(uri, f, timeout);
    const j = buf ? (JSON.parse(buf.toString('utf8')) as { image?: unknown }) : null;
    return typeof j?.image === 'string' ? j.image : null;
  } catch { return null; }
}

/** The only image formats we decode, told apart by their first bytes (never by the server's content-type). */
export function imageKind(b: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  const head = b.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  const text = b.subarray(0, 1024).toString('utf8').trimStart();   // trimStart also drops a leading byte-order mark
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text)) return 'svg';
  return null;
}

// Defence in depth: switch off decoders logos never need (HEIF, PDF, TIFF, JPEG 2000 / XL, raw and science formats).
try {
  sharp.block({ operation: ['VipsForeignLoadHeif', 'VipsForeignLoadPdf', 'VipsForeignLoadTiff', 'VipsForeignLoadJp2k', 'VipsForeignLoadJxl',
    'VipsForeignLoadMagick', 'VipsForeignLoadOpenslide', 'VipsForeignLoadFits', 'VipsForeignLoadMat', 'VipsForeignLoadVips', 'VipsForeignLoadRad',
    'VipsForeignLoadPpm', 'VipsForeignLoadCsv', 'VipsForeignLoadMatrix', 'VipsForeignLoadAnalyze'] });
} catch { /* a libvips build without some of these: the format check below still applies */ }

/** At most this many logos are downloaded / decoded at once; beyond a short queue, extra requests get no logo. */
const MAX_ICON_JOBS = 4, MAX_ICON_QUEUE = 16;
let iconJobs = 0;
const iconQueue: (() => void)[] = [];
async function iconSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (iconJobs >= MAX_ICON_JOBS) {
    if (iconQueue.length >= MAX_ICON_QUEUE) return null;
    await new Promise<void>((r) => iconQueue.push(r));
  }
  iconJobs++;
  try { return await fn(); } finally { iconJobs--; iconQueue.shift()?.(); }
}

/** Any image link -> 128 x 128 WebP data URI (or null if it isn't a usable image). */
export async function iconDataUri(url: string, f: typeof fetch = publicFetch, timeout = 10_000): Promise<string | null> {
  try {
    return await iconSlot(async () => {
      const buf = await fetchBody(url, f, timeout);
      if (!buf || !imageKind(buf)) return null;
      const out = await sharp(buf, { limitInputPixels: 40_000_000, animated: false }).resize(128, 128, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
      return `data:image/webp;base64,${out.toString('base64')}`;
    });
  } catch { return null; }
}
