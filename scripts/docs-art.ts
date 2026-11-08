/**
 * Writes the placeholder graphics used by the "What is Rest In Pump?" docs (client/public/docs/).
 * Replace any of these files with final artwork (same file name) — nothing else needs to change.
 * Run: node scripts/docs-art.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { levelFor, type GraveInfo } from '../shared/graves.ts';
import { memorialSvg } from '../server/src/nft.ts';

const out = 'client/public/docs';
mkdirSync(out, { recursive: true });

const sample = (offerings: number): GraveInfo => ({
  id: 1, plot: 7, message: '', creator: 'example.near', createdAt: 0, offerings, level: levelFor(offerings), recentItems: [],
  meme: { chain: 'near', contract: 'rug.example.near', name: 'Rug Pull', symbol: 'RUG', decimals: 18, icon: null },
});
[[1, 3], [2, 42], [3, 420], [4, 4200]].forEach(([lvl, n]) => writeFileSync(`${out}/level-${lvl}.svg`, memorialSvg(sample(n))));

// how $WTH flows: players pay in WTH -> graves & offerings -> treasury -> buyback
const box = (x: number, w: number, title: string, sub: string, fill: string) => `
  <rect x="${x}" y="70" width="${w}" height="110" rx="14" fill="${fill}" stroke="#1b1a1f" stroke-width="5"/>
  <text x="${x + w / 2}" y="118" text-anchor="middle" font-size="22" font-weight="900" fill="#1b1a1f">${title}</text>
  <text x="${x + w / 2}" y="148" text-anchor="middle" font-size="15" font-weight="700" fill="#1b1a1f" opacity=".75">${sub}</text>`;
const arrow = (x1: number, x2: number, label: string) => `
  <path d="M${x1} 125 H${x2 - 14}" stroke="#f1c76b" stroke-width="6"/>
  <path d="M${x2 - 18} 112 L${x2} 125 L${x2 - 18} 138 Z" fill="#f1c76b"/>
  <text x="${(x1 + x2) / 2}" y="105" text-anchor="middle" font-size="14" font-weight="800" fill="#f1c76b">${label}</text>`;
writeFileSync(`${out}/wth-flow.svg`, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 250" width="960" height="250" font-family="Arial Black, Arial, Helvetica, sans-serif">
  <rect width="960" height="250" rx="18" fill="#17161c"/>
  ${box(20, 160, 'PLAYERS', 'hold $WTH', '#f3efd8')}
  ${arrow(180, 290, 'pay in $WTH')}
  ${box(290, 180, 'GRAVES +', 'OFFERINGS', '#bcd2ff')}
  ${arrow(470, 570, 'revenue')}
  ${box(570, 180, 'TREASURY', 'whatthehoot.near', '#e8c35a')}
  ${arrow(750, 800, '')}
  ${box(800, 140, 'BUYBACK', '$WTH', '#7fd38b')}
  <text x="480" y="225" text-anchor="middle" font-size="14" font-weight="700" fill="#9a97a3">PLACEHOLDER GRAPHIC</text>
</svg>`);
console.log('wrote', out);
