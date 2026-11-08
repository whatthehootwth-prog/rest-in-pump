/**
 * Graves, offerings and Memorial NFTs: plot layout, memorial levels, offering items and the shapes
 * exchanged by the API. Shared by client and server so both agree on ids, positions and limits.
 *
 * "Every offering keeps the memory alive." A grave represents a memecoin. Visitors leave paid offerings
 * in NEAR; each successful offering adds one to the grave's community count, and the grave evolves at
 * milestones. A wallet's first successful offering to a grave earns it that grave's Memorial NFT, and all
 * memorials of a grave evolve with it. No staking, yield, rewards or token burning.
 */

/** Memorial levels, reached by the community offering count (number of successful offerings, not WTH). */
export const GRAVE_LEVELS = [
  { level: 1, name: 'Forgotten Grave', min: 0 },
  { level: 2, name: 'Remembered Grave', min: 10 },
  { level: 3, name: 'Honored Grave', min: 100 },
  { level: 4, name: 'Legendary Grave', min: 1000 },
] as const;
export type GraveLevel = 1 | 2 | 3 | 4;
export function levelFor(offerings: number): GraveLevel {
  let lvl: GraveLevel = 1;
  for (const l of GRAVE_LEVELS) if (offerings >= l.min) lvl = l.level;
  return lvl;
}
export const levelName = (l: GraveLevel) => GRAVE_LEVELS[l - 1].name;
/** Offerings still needed for the next level (null at the top). */
export function nextLevelIn(offerings: number): number | null {
  const next = GRAVE_LEVELS.find((l) => l.min > offerings);
  return next ? next.min - offerings : null;
}

/** Things visitors can leave at a grave. Purely decorative: the WTH amount is chosen separately. */
export const OFFERING_ITEMS = [
  { id: 'candle', name: 'Candle' },
  { id: 'flowers', name: 'Flowers' },
  { id: 'noodles', name: 'Instant noodles' },
  { id: 'rug', name: 'A rug' },
  { id: 'diamond', name: 'Diamond hands' },
  { id: 'copium', name: 'Copium tank' },
] as const;
export type OfferingItem = (typeof OFFERING_ITEMS)[number]['id'];
export const isOfferingItem = (v: unknown): v is OfferingItem => OFFERING_ITEMS.some((i) => i.id === v);
export const itemName = (id: string) => OFFERING_ITEMS.find((i) => i.id === id)?.name ?? id;

export const MESSAGE_MAX = 100;
/** How many recent offering items are shown around a grave. */
export const RECENT_ITEMS = 6;

/** Chains a meme can live on. Only NEAR resolves today; the others are planned. */
export const CHAINS = [
  { id: 'near', name: 'NEAR', live: true },
  { id: 'solana', name: 'Solana', live: false },
  { id: 'base', name: 'Base', live: false },
  { id: 'ethereum', name: 'Ethereum', live: false },
] as const;
export type ChainId = (typeof CHAINS)[number]['id'];
export const isChain = (v: unknown): v is ChainId => CHAINS.some((c) => c.id === v);
export const chainLive = (c: ChainId) => CHAINS.find((x) => x.id === c)?.live === true;
export const chainName = (c: string) => CHAINS.find((x) => x.id === c)?.name ?? c;

/** NEAR account ids (named or 64-hex implicit), 2-64 chars, lowercase. */
export const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * 40 empty plots in 5 rows x 8 columns, either side of the central path.
 * Each plot is a 1.6 m x 2.4 m rectangle; the headstone stands at the back (−z) and faces the gate (+z).
 */
export interface Plot { id: number; x: number; z: number }
export const PLOT_SIZE = { w: 1.6, d: 2.4 } as const;
const ROWS = [-8, -4, 0, 4, 8];
const COLS = [-14.5, -11, -7.5, -4, 4, 7.5, 11, 14.5];
export const PLOTS: Plot[] = ROWS.flatMap((z, r) => COLS.map((x, c) => ({ id: r * COLS.length + c + 1, x, z })));
export const plotById = (id: number) => PLOTS[id - 1] as Plot | undefined;
export const isPlotId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= PLOTS.length;

/** Cleans a grave message: no control/zero-width characters, collapsed whitespace, 1..MESSAGE_MAX chars. */
export function sanitizeMessage(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MESSAGE_MAX * 4) return null;
  const text = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (text.length < 1 || [...text].length > MESSAGE_MAX) return null;
  return text;
}

// ------------------------------------------------------------------ API shapes

export interface MemeInfo {
  chain: ChainId;
  contract: string;
  name: string;
  symbol: string;
  decimals: number | null;
  /** data: URI of the token logo, or null if the contract has none we can show. */
  icon: string | null;
}

export interface GraveInfo {
  id: number;
  plot: number;
  meme: MemeInfo;
  message: string;
  /** NEAR account that paid to create the grave (creating a grave does not mint an NFT). */
  creator: string;
  createdAt: number;
  /** Community offering count (successful offerings). */
  offerings: number;
  level: GraveLevel;
  /** Most recent offering items, newest first (for decoration). */
  recentItems: string[];
}

export interface PriceConfig {
  currency: 'NEAR';
  /** NEAR has 24 decimals (yoctoNEAR). */
  decimals: number;
  /** Account that receives the NEAR. */
  receiver: string;
  /** USD prices (exact decimal strings). */
  gravePriceUsd: string;
  offeringMinUsd: string;
  /** Current USD per NEAR, or null if no price source answered (orders pause). */
  nearUsd: number | null;
  /** The USD prices in yoctoNEAR at the current price (null when the price is unknown). */
  gravePrice: string | null;
  offeringMin: string | null;
  holdMinutes: number;
  /** Whether Memorial NFT minting is switched on (contract + minter configured on the server). */
  mintingEnabled: boolean;
  nftContract: string | null;
}

export interface GravesSnapshot {
  graves: GraveInfo[];
  /** Plots someone is currently paying for (held for a few minutes). */
  reserved: number[];
}

export type PaymentStatus = 'pending' | 'confirming' | 'fulfilled' | 'expired' | 'failed' | 'unfulfillable';
export type MemorialStatus = 'pending' | 'minting' | 'minted' | 'failed';

export interface MemorialView {
  graveId: number;
  account: string;
  status: MemorialStatus;
  tokenId: string | null;
  /** Memorial number within its grave (#001…), known once minted. */
  serial: number | null;
  error: string | null;
}

export interface PaymentView {
  id: string;
  kind: 'grave' | 'offering';
  status: PaymentStatus;
  /** Exact amount to send, in yoctoNEAR (decimal string). Unique per order: it is how the transfer is matched. */
  amount: string;
  receiver: string;
  plot: number;
  meme: MemeInfo;
  /** Grave: the creator's message. Offering: unused (see item). */
  message: string;
  /** Offering only. */
  graveId: number | null;
  item: string | null;
  expiresAt: number;
  txHash: string | null;
  payer: string | null;
  error: string | null;
  grave: GraveInfo | null;
  /** Offering only: the payer's memorial for this grave (if any). */
  memorial: MemorialView | null;
}

export interface GraveDetail {
  grave: GraveInfo;
  recent: { item: string; payer: string; amount: string; at: number }[];
  memorials: number;
  /** The asking wallet's memorial, if an account was given. */
  mine: MemorialView | null;
  /** How many offerings the asking wallet made to this grave. */
  myOfferings: number;
}

/** Formats a smallest-unit amount (decimal string) as whole tokens with thousands separators. */
export function formatUnits(amount: string, decimals: number, maxFraction = 2): string {
  const neg = amount.startsWith('-');
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = digits.slice(digits.length - decimals).slice(0, maxFraction).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

/** "75000" / "12.5" whole tokens -> smallest unit (exact). Throws on bad input. */
export function parseUnits(whole: string, decimals: number): bigint {
  if (!/^\d{1,15}(\.\d+)?$/.test(whole)) throw new Error(`bad amount "${whole}"`);
  const [i, f = ''] = whole.split('.');
  if (f.length > decimals) throw new Error(`too many decimals in "${whole}"`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}

// ------------------------------------------------------------------ NEAR amounts

const YOCTO = 10n ** 24n;
/**
 * USD amount (decimal string like "0.01") at a NEAR price -> yoctoNEAR, rounded UP to a whole 0.000001 NEAR,
 * so the price is never undercharged and amounts stay readable.
 */
export function usdToYocto(usd: string, nearUsd: number): bigint {
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(usd)) throw new Error(`bad USD amount "${usd}"`);
  const [i, f = ''] = usd.split('.');
  const micro = BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0'));            // millionths of a dollar
  const priceMicro = BigInt(Math.round(nearUsd * 1_000_000));                 // millionths of a dollar per NEAR
  if (priceMicro <= 0n) throw new Error('bad NEAR price');
  const step = 10n ** 18n;                                                     // 0.000001 NEAR
  const raw = (micro * YOCTO + priceMicro - 1n) / priceMicro;
  return ((raw + step - 1n) / step) * step;
}

/** yoctoNEAR -> "0.003571 NEAR" (up to 6 decimals, never shows 0 for a non-zero amount). */
export function nearLabel(yocto: string | bigint): string {
  const y = BigInt(yocto);
  const s = formatUnits(y.toString(), 24, 6);
  return `${s === '0' && y > 0n ? '<0.000001' : s} NEAR`;
}
/** yoctoNEAR at a NEAR price -> "$0.01" (2 decimals, or more for tiny amounts). */
export function usdLabel(yocto: string | bigint, nearUsd: number): string {
  const usd = (Number(BigInt(yocto) / 10n ** 12n) / 1e12) * nearUsd;
  return '$' + (usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(usd >= 0.01 ? 3 : 4)).replace(/(\.\d*?[1-9])0+$/, '$1');
}
