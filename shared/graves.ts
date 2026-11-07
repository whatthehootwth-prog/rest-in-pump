/**
 * Graves: the plot layout, tombstone tiers and the shapes exchanged by the grave API.
 * Shared by client and server so both agree on plot ids, positions and limits.
 */

/** Grave tiers. The WTH price of each tier is set in server config (GRAVE_PRICES_WTH). */
export const GRAVE_TIERS = [
  { tier: 1, usd: 1, name: 'Wooden Cross' },
  { tier: 2, usd: 5, name: 'Classic Headstone' },
  { tier: 3, usd: 10, name: 'Grand Tombstone' },
  { tier: 4, usd: 50, name: 'Mausoleum' },
] as const;
export type GraveTier = 1 | 2 | 3 | 4;
export const isTier = (v: unknown): v is GraveTier => v === 1 || v === 2 || v === 3 || v === 4;

export const MESSAGE_MAX = 100;

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
  tier: GraveTier;
  meme: MemeInfo;
  message: string;
  /** NEAR account that paid for the grave. */
  creator: string;
  createdAt: number;
}

export interface PriceConfig {
  token: string;
  receiver: string;
  decimals: number;
  /** Whole-WTH price per tier, as decimal strings (exact). */
  tiers: Record<GraveTier, string>;
  holdMinutes: number;
}

export interface GravesSnapshot {
  graves: GraveInfo[];
  /** Plots someone is currently paying for (held for a few minutes). */
  reserved: number[];
}

export type PaymentStatus = 'pending' | 'confirming' | 'fulfilled' | 'expired' | 'failed' | 'unfulfillable';

export interface PaymentView {
  id: string;
  memo: string;
  status: PaymentStatus;
  /** Required amount in the token's smallest unit (yocto-WTH), decimal string. */
  amount: string;
  token: string;
  receiver: string;
  plot: number;
  tier: GraveTier;
  meme: MemeInfo;
  message: string;
  expiresAt: number;
  txHash: string | null;
  payer: string | null;
  error: string | null;
  grave: GraveInfo | null;
}

/** Formats a smallest-unit amount (decimal string) as whole tokens with thousands separators. */
export function formatUnits(amount: string, decimals: number, maxFraction = 2): string {
  const neg = amount.startsWith('-');
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = digits.slice(digits.length - decimals).slice(0, maxFraction).replace(/0+$/, '');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}
