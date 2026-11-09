import type http from 'node:http';
import { readFileSync } from 'node:fs';
import { chainName, levelName, nextLevelIn, type GraveInfo, type GraveLevel } from '../../shared/graves.ts';
import type { GraveService } from './graves.ts';
import type { Logger } from './log.ts';
import { describe } from './minter.ts';

/**
 * Memorial NFT metadata, served live by the game so every memorial evolves with its grave.
 * The contract stores paths relative to its base_uri (`<PUBLIC_BASE_URL>/nft`):
 *   GET /nft/grave/:id/media.svg     artwork, shared by every memorial of the grave (reflects its current level)
 *   GET /nft/token/:tokenId.json     NEP-177 reference JSON with the memorial's attributes
 */
export function createNftRoutes(graves: GraveService, log: Logger, publicBaseUrl: string | null, nftContract: string | null) {
  const base = (publicBaseUrl ?? '').replace(/\/+$/, '');
  const headers = (type: string, maxAge: number) => ({
    'content-type': type,
    'cache-control': `public, max-age=${maxAge}`,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    // the SVG is a picture, never a document that runs anything
    'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  });
  const notFound = (res: http.ServerResponse) => {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Unknown memorial.' } }));
  };

  return function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    if (!url.pathname.startsWith('/nft/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return true; }
    try {
      const media = /^\/nft\/grave\/(\d{1,9})\/media\.svg$/.exec(url.pathname);
      if (media) {
        const grave = graves.grave(Number(media[1]));
        if (!grave) { notFound(res); return true; }
        res.writeHead(200, headers('image/svg+xml; charset=utf-8', 60));
        res.end(req.method === 'HEAD' ? undefined : memorialSvg(grave));
        return true;
      }
      const token = /^\/nft\/token\/(\d{1,9}-\d{1,9})\.json$/.exec(url.pathname);
      if (token) {
        const found = graves.memorialByToken(token[1]);
        if (!found) { notFound(res); return true; }
        const { memorial: m, grave: g, personalOfferings } = found;
        const { namePrefix, description } = describe(g.meme.symbol, g.meme.contract, g.plot);
        const body = {
          name: `${namePrefix} — Memorial #${String(m.serial ?? 0).padStart(3, '0')}`,
          description,
          image: base ? `${base}/nft/grave/${g.id}/media.svg` : `grave/${g.id}/media.svg`,
          external_url: base || undefined,
          contract: nftContract ?? undefined,
          token_id: m.token_id,
          attributes: [
            { trait_type: 'Memecoin name', value: g.meme.name },
            { trait_type: 'Memecoin contract address', value: g.meme.contract },
            { trait_type: 'Blockchain', value: chainName(g.meme.chain) },
            { trait_type: 'Grave ID', value: g.id },
            { trait_type: 'Memorial level', value: `Level ${g.level} — ${levelName(g.level)}` },
            { trait_type: 'Total community offerings', value: g.offerings },
            { trait_type: 'Original participant wallet', value: m.account_id },
            { trait_type: 'Personal offerings made', value: personalOfferings },
            { trait_type: 'First offering date', value: new Date(m.first_offering_at).toISOString().slice(0, 10), timestamp: m.first_offering_at },
            { trait_type: 'Grave creation date', value: new Date(g.createdAt).toISOString().slice(0, 10), timestamp: g.createdAt },
          ],
        };
        res.writeHead(200, { ...headers('application/json; charset=utf-8', 60), 'content-security-policy': "default-src 'none'" });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
        return true;
      }
      notFound(res);
    } catch (e) {
      log.error('nft route error', { path: url.pathname, err: e });
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error');
    }
    return true;
  };
}

// ------------------------------------------------------------------ artwork

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * One illustrated design per level (server/assets/nft/level-N.webp, 1080 x 1380): a wooden cross, a headstone,
 * a marble tomb and a golden mausoleum. Each has a spot for the token's logo, measured from the artwork:
 * a box on the stone for levels 2-4 (the doorway arch for the mausoleum), a round medallion over the cross's bolt
 * for level 1. Each memorial's picture = its grave's level design + the token's own logo + a name / level / count bar.
 */
const W = 1080, H = 1380;
type Spot = { kind: 'circle'; cx: number; cy: number; r: number } | { kind: 'box'; x: number; y: number; w: number; h: number; rx: number; arch?: boolean };
const SPOTS: Record<GraveLevel, Spot> = {
  1: { kind: 'circle', cx: 512, cy: 517, r: 96 },
  2: { kind: 'box', x: 344, y: 545, w: 393, h: 384, rx: 46 },
  3: { kind: 'box', x: 364, y: 503, w: 354, h: 346, rx: 44 },
  4: { kind: 'box', x: 390, y: 559, w: 310, h: 356, rx: 30, arch: true },
};
const ASSETS = new URL('../assets/nft/', import.meta.url);
const designs = new Map<GraveLevel, string | null>();
function design(level: GraveLevel): string | null {
  if (!designs.has(level)) {
    try { designs.set(level, 'data:image/webp;base64,' + readFileSync(new URL(`level-${level}.webp`, ASSETS)).toString('base64')); }
    catch { designs.set(level, null); }   // missing file: plain background below
  }
  return designs.get(level)!;
}
const ACCENT: Record<GraveLevel, string> = { 1: '#d9a46b', 2: '#8fc4ff', 3: '#d48cff', 4: '#ffcf4a' };

/** The outline of the logo spot, as an SVG shape (used for the clip and the border). */
function spotShape(s: Spot, attrs: string): string {
  if (s.kind === 'circle') return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${attrs}/>`;
  if (!s.arch) return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.rx}" ${attrs}/>`;
  // a doorway: round arch on top, small rounded corners at the bottom
  const r = s.w / 2, b = s.y + s.h, c = s.rx;
  return `<path d="M${s.x} ${s.y + r} A${r} ${r} 0 0 1 ${s.x + s.w} ${s.y + r} V${b - c} Q${s.x + s.w} ${b} ${s.x + s.w - c} ${b} H${s.x + c} Q${s.x} ${b} ${s.x} ${b - c} Z" ${attrs}/>`;
}

/** The memorial picture: the level's design, the token's logo in its spot, and an info bar. */
export function memorialSvg(g: GraveInfo): string {
  const s = SPOTS[g.level], art = design(g.level), accent = ACCENT[g.level];
  const ticker = esc(describe(g.meme.symbol, g.meme.contract, g.plot).namePrefix);
  const levelText = esc(`LEVEL ${g.level} · ${levelName(g.level).toUpperCase()}`);
  const count = `${g.offerings.toLocaleString('en-US')} ${g.offerings === 1 ? 'OFFERING' : 'OFFERINGS'}`;
  const next = nextLevelIn(g.offerings);
  const nextText = next === null ? 'MAX LEVEL' : `${next.toLocaleString('en-US')} TO NEXT LEVEL`;
  const icon = g.meme.icon && /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(g.meme.icon) ? esc(g.meme.icon) : null;
  const font = `font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900"`;
  const box = s.kind === 'circle' ? { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 } : s;
  const logo = icon
    ? `${spotShape(s, 'fill="#ffffff"')}
       <image href="${icon}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" clip-path="url(#spot)" preserveAspectRatio="xMidYMid slice"/>`
    : `${spotShape(s, 'fill="#2e2b38"')}
       <text x="${box.x + box.w / 2}" y="${box.y + box.h / 2 + Math.min(box.w, box.h) * 0.19}" text-anchor="middle" font-size="${Math.min(box.w, box.h) * 0.55}" ${font} fill="#ffffff">${ticker.slice(1, 2) || '?'}</text>`;
  const bx = 70, by = 1190, bw = W - 140, bh = 130;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs><clipPath id="spot">${spotShape(s, '')}</clipPath></defs>
  ${art ? `<image href="${art}" x="0" y="0" width="${W}" height="${H}"/>` : `<rect width="${W}" height="${H}" rx="60" fill="#2b2733"/>`}
  ${logo}
  ${spotShape(s, `fill="none" stroke="#2a1f1a" stroke-width="10"`)}
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="34" fill="#1b1720" fill-opacity="0.9" stroke="#2a1f1a" stroke-width="6"/>
  <rect x="${bx + 24}" y="${by + 24}" width="10" height="${bh - 48}" rx="5" fill="${accent}"/>
  <text x="${bx + 56}" y="${by + 66}" ${font} font-size="54" fill="#ffffff">${ticker}</text>
  <text x="${bx + 58}" y="${by + 106}" ${font} font-size="25" fill="${accent}" letter-spacing="1">${levelText}</text>
  <text x="${bx + bw - 34}" y="${by + 62}" text-anchor="end" ${font} font-size="34" fill="#ffffff">${count}</text>
  <text x="${bx + bw - 34}" y="${by + 104}" text-anchor="end" ${font} font-size="22" fill="#b3aebd">${esc(nextText)}</text>
</svg>`;
}
