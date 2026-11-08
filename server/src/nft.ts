import type http from 'node:http';
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
const INK = '#1b1a1f';
const PALETTE: Record<GraveLevel, { sky: [string, string]; ground: string; accent: string; stone: string; stoneDark: string }> = {
  1: { sky: ['#20242c', '#2c3038'], ground: '#3b3328', accent: '#8d8a80', stone: '#7a5a3a', stoneDark: '#5c4128' },
  2: { sky: ['#1d2533', '#2e3a4c'], ground: '#34452f', accent: '#c9c2b0', stone: '#9b9a95', stoneDark: '#74736e' },
  3: { sky: ['#1e1f3a', '#3a2f55'], ground: '#2f4a33', accent: '#e8c35a', stone: '#e6e1d6', stoneDark: '#b9b2a4' },
  4: { sky: ['#140f2a', '#4a2462'], ground: '#2a3d2e', accent: '#ffd34d', stone: '#f2ede2', stoneDark: '#c8bfae' },
};

/** Flat cartoon tombstone in the game's style; the design changes with the grave's level. */
export function memorialSvg(g: GraveInfo): string {
  const p = PALETTE[g.level];
  const ticker = esc(describe(g.meme.symbol, g.meme.contract, g.plot).namePrefix);
  const levelText = esc(`LEVEL ${g.level} · ${levelName(g.level).toUpperCase()}`);
  const count = `${g.offerings.toLocaleString('en-US')} ${g.offerings === 1 ? 'OFFERING' : 'OFFERINGS'}`;
  const next = nextLevelIn(g.offerings);
  const nextText = next === null ? 'MAX LEVEL' : `${next.toLocaleString('en-US')} TO NEXT LEVEL`;
  const icon = g.meme.icon && /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(g.meme.icon) ? esc(g.meme.icon) : null;
  const font = `font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900"`;
  const logo = (cx: number, cy: number, r: number) => `
    <circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="${INK}"/>
    <clipPath id="logo"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"/>
    ${icon
      ? `<image href="${icon}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#logo)" preserveAspectRatio="xMidYMid slice"/>`
      : `<text x="${cx}" y="${cy + r * 0.32}" text-anchor="middle" font-size="${r * 0.9}" ${font} fill="${INK}">${ticker.slice(1, 3) || '?'}</text>`}`;

  let art = '';
  if (g.level === 1) {
    // wooden cross on a bare dirt mound
    art = `
      <path d="M190 470 Q300 395 410 470 Z" fill="${p.ground}" stroke="${INK}" stroke-width="8"/>
      <rect x="282" y="190" width="36" height="270" rx="6" fill="${p.stone}" stroke="${INK}" stroke-width="8"/>
      <rect x="205" y="250" width="190" height="34" rx="6" fill="${p.stone}" stroke="${INK}" stroke-width="8"/>
      <path d="M292 210 v230 M215 260 h170" stroke="${p.stoneDark}" stroke-width="4" opacity=".6"/>
      ${logo(300, 345, 46)}`;
  } else if (g.level === 2) {
    // classic rounded headstone, grass and one candle
    art = `
      <path d="M150 478 Q300 430 450 478 Z" fill="${p.ground}" stroke="${INK}" stroke-width="8"/>
      <path d="M205 465 V250 Q205 160 300 160 Q395 160 395 250 V465 Z" fill="${p.stone}" stroke="${INK}" stroke-width="8"/>
      <path d="M225 455 V255 Q225 182 300 182" fill="none" stroke="#ffffff" stroke-width="6" opacity=".25"/>
      ${logo(300, 270, 58)}
      <text x="300" y="385" text-anchor="middle" font-size="22" ${font} fill="${p.stoneDark}">R.I.P.</text>
      <rect x="420" y="420" width="22" height="46" rx="4" fill="#f5ecd2" stroke="${INK}" stroke-width="6"/>
      <path d="M431 398 q10 12 0 20 q-10 -8 0 -20 Z" fill="#ffb53d" stroke="${INK}" stroke-width="4"/>`;
  } else if (g.level === 3) {
    // grand marble tombstone with gold trim, candles and flowers
    art = `
      <path d="M110 480 Q300 438 490 480 Z" fill="${p.ground}" stroke="${INK}" stroke-width="8"/>
      <rect x="170" y="430" width="260" height="40" rx="6" fill="${p.stoneDark}" stroke="${INK}" stroke-width="8"/>
      <path d="M195 435 V230 Q195 135 300 120 Q405 135 405 230 V435 Z" fill="${p.stone}" stroke="${INK}" stroke-width="8"/>
      <path d="M215 425 V235 Q215 155 300 142 Q385 155 385 235 V425" fill="none" stroke="${p.accent}" stroke-width="7"/>
      ${logo(300, 255, 64)}
      <text x="300" y="372" text-anchor="middle" font-size="24" ${font} fill="${p.accent}" stroke="${INK}" stroke-width="1">R.I.P.</text>
      ${[130, 470].map((x) => `
        <rect x="${x - 12}" y="404" width="24" height="56" rx="4" fill="#f5ecd2" stroke="${INK}" stroke-width="6"/>
        <path d="M${x} 380 q11 13 0 22 q-11 -9 0 -22 Z" fill="#ffb53d" stroke="${INK}" stroke-width="4"/>`).join('')}
      ${[245, 300, 355].map((x, i) => `<circle cx="${x}" cy="452" r="13" fill="${['#e2557a', '#f1c84b', '#e2557a'][i]}" stroke="${INK}" stroke-width="5"/>`).join('')}`;
  } else {
    // legendary mausoleum with columns, gold and a glow
    art = `
      <circle cx="300" cy="290" r="230" fill="${p.accent}" opacity=".12"/>
      <path d="M80 482 Q300 440 520 482 Z" fill="${p.ground}" stroke="${INK}" stroke-width="8"/>
      <rect x="135" y="440" width="330" height="34" rx="5" fill="${p.stoneDark}" stroke="${INK}" stroke-width="8"/>
      <rect x="160" y="210" width="280" height="235" fill="${p.stone}" stroke="${INK}" stroke-width="8"/>
      <path d="M135 215 L300 110 L465 215 Z" fill="${p.stone}" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>
      <path d="M175 205 L300 128 L425 205" fill="none" stroke="${p.accent}" stroke-width="7"/>
      ${[185, 415].map((x) => `<rect x="${x - 16}" y="220" width="32" height="222" fill="${p.stoneDark}" stroke="${INK}" stroke-width="6"/>`).join('')}
      <path d="M245 445 V330 Q245 290 300 290 Q355 290 355 330 V445 Z" fill="#2a2140" stroke="${INK}" stroke-width="7"/>
      ${logo(300, 245, 40)}
      <circle cx="300" cy="300" r="6" fill="${p.accent}"/>
      ${[[90, 120], [400, 70], [70, 260], [530, 230]].map(([x, y]) => `<path d="M${x} ${y - 12} L${x + 4} ${y - 4} L${x + 12} ${y} L${x + 4} ${y + 4} L${x} ${y + 12} L${x - 4} ${y + 4} L${x - 12} ${y} L${x - 4} ${y - 4} Z" fill="${p.accent}"/>`).join('')}`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">
  <rect width="600" height="600" fill="${p.sky[0]}"/>
  <rect y="300" width="600" height="300" fill="${p.sky[1]}"/>
  <circle cx="500" cy="95" r="38" fill="#f3efd8" opacity="${g.level === 1 ? 0.35 : 0.8}"/>
  ${art}
  <rect x="0" y="490" width="600" height="110" fill="${INK}"/>
  <text x="32" y="536" ${font} font-size="34" fill="#ffffff">${ticker}</text>
  <text x="32" y="572" ${font} font-size="17" fill="${p.accent}">${levelText}</text>
  <text x="568" y="536" text-anchor="end" ${font} font-size="22" fill="#ffffff">${count}</text>
  <text x="568" y="572" text-anchor="end" ${font} font-size="15" fill="#9a97a3">${esc(nextText)}</text>
  <text x="300" y="40" text-anchor="middle" ${font} font-size="16" fill="#ffffff" opacity=".55" letter-spacing="4">REST IN PUMP · MEMORIAL</text>
</svg>`;
}
