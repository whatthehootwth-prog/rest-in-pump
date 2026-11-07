import { randomBytes } from 'node:crypto';
import {
  GRAVE_TIERS, NEAR_ACCOUNT_RE, chainLive, isChain, isPlotId, isTier, plotById, sanitizeMessage,
  type ChainId, type GraveInfo, type GraveTier, type GravesSnapshot, type MemeInfo, type PaymentStatus, type PaymentView, type PriceConfig,
} from '../../shared/graves.ts';
import { transaction, type Db } from './db.ts';
import type { Logger } from './log.ts';
import type { FtMetadata, MetadataResult, TransferCheck, TransferResult } from './near.ts';

/**
 * Grave lifecycle:
 *   1. createPayment  — validates plot, meme (metadata fetched by the server), tier and message, then HOLDS
 *                       the plot and the meme for a few minutes and returns the exact transfer to make.
 *   2. the player sends WTH to the treasury with the memo, from their own wallet.
 *   3. confirmPayment — records the tx hash, verifies the transfer on NEAR, and creates the grave in one
 *                       transaction. Retries with the same tx can never create a second grave.
 * A background sweep expires unpaid holds and re-checks payments whose verification was interrupted.
 */

export interface GraveServiceDeps {
  db: Db;
  log: Logger;
  token: string;
  receiver: string;
  decimals: number;
  /** Price per tier in the token's smallest unit. */
  tierUnits: Record<GraveTier, bigint>;
  /** Price per tier in whole tokens (for display), exact decimal strings. */
  tierWhole: Record<GraveTier, string>;
  holdMinutes: number;
  lookupNear(contract: string): Promise<MetadataResult>;
  verify(check: TransferCheck): Promise<TransferResult>;
  onGraveAdded?(g: GraveInfo): void;
  onReservedChanged?(reserved: number[]): void;
}

export type GraveError = { code: string; message: string; status: number };
const err = (status: number, code: string, message: string): GraveError => ({ status, code, message });

interface PaymentRow {
  id: string; kind: string; status: PaymentStatus; amount: string; plot: number; chain: string; contract: string;
  tier: number; message: string; meme_json: string; tx_hash: string | null; payer: string | null; error: string | null;
  client_ip: string | null; created_at: number; expires_at: number; updated_at: number;
}
interface GraveRow {
  id: number; plot: number; chain: string; contract: string; tier: number; name: string; symbol: string;
  decimals: number | null; icon: string | null; message: string; creator: string; payment_id: string; created_at: number;
}

const MAX_HOLDS_PER_IP = 2;
/** After a hold expires, how long we keep re-checking a submitted transaction before giving up. */
const VERIFY_GIVE_UP_MS = 30 * 60 * 1000;

export class GraveService {
  private readonly d: GraveServiceDeps;
  private readonly verifying = new Set<string>();

  constructor(deps: GraveServiceDeps) { this.d = deps; }

  config(): PriceConfig {
    return { token: this.d.token, receiver: this.d.receiver, decimals: this.d.decimals, tiers: this.d.tierWhole, holdMinutes: this.d.holdMinutes };
  }

  snapshot(): GravesSnapshot {
    const rows = this.d.db.prepare('SELECT * FROM graves ORDER BY id').all() as unknown as GraveRow[];
    return { graves: rows.map(graveInfo), reserved: this.reservedPlots() };
  }

  reservedPlots(): number[] {
    const rows = this.d.db.prepare("SELECT plot FROM payments WHERE status IN ('pending','confirming') ORDER BY plot").all() as { plot: number }[];
    return rows.map((r) => r.plot);
  }

  graveByContract(chain: ChainId, contract: string): GraveInfo | null {
    const row = this.d.db.prepare('SELECT * FROM graves WHERE chain = ? AND contract = ?').get(chain, contract) as GraveRow | undefined;
    return row ? graveInfo(row) : null;
  }

  /** Resolves a meme by contract. Also says whether it is already buried. */
  async lookup(chainRaw: unknown, contractRaw: unknown): Promise<{ meme: MemeInfo; grave: GraveInfo | null } | GraveError> {
    const parsed = parseMemeRef(chainRaw, contractRaw);
    if ('code' in parsed) return parsed;
    const { chain, contract } = parsed;
    const res = await this.d.lookupNear(contract);
    if (!res.ok) return err(res.code === 'unavailable' ? 503 : 404, res.code, res.message);
    return { meme: memeInfo(chain, contract, res.meta), grave: this.graveByContract(chain, contract) };
  }

  async createPayment(input: { plot: unknown; chain: unknown; contract: unknown; tier: unknown; message: unknown }, ip: string, now: number): Promise<PaymentView | GraveError> {
    this.expireHolds(now);
    if (!isPlotId(input.plot) || !plotById(input.plot)) return err(400, 'bad_plot', 'That is not an empty grave plot.');
    if (!isTier(input.tier)) return err(400, 'bad_tier', 'Pick a tombstone.');
    const message = sanitizeMessage(input.message);
    if (!message) return err(400, 'bad_message', 'Leave a message of 1–100 characters.');
    const parsed = parseMemeRef(input.chain, input.contract);
    if ('code' in parsed) return parsed;
    const { chain, contract } = parsed;
    const plot = input.plot, tier = input.tier;
    const db = this.d.db;

    // resuming an open hold for exactly the same grave (e.g. after closing the dialog) returns it
    const mine = db.prepare("SELECT * FROM payments WHERE plot = ? AND chain = ? AND contract = ? AND client_ip = ? AND status IN ('pending','confirming')")
      .get(plot, chain, contract, ip) as PaymentRow | undefined;
    if (mine && mine.tier === tier && mine.message === message) return this.view(mine);
    if (mine && mine.status === 'pending' && !mine.tx_hash) this.setStatus(mine.id, 'expired', null, now);   // changed their mind: replace it

    if (db.prepare('SELECT 1 FROM graves WHERE plot = ?').get(plot)) return err(409, 'plot_taken', 'Someone already has a grave here.');
    if (db.prepare("SELECT 1 FROM payments WHERE plot = ? AND status IN ('pending','confirming')").get(plot)) {
      return err(409, 'plot_reserved', 'Someone is burying a meme here right now. Try another empty grave.');
    }
    const buried = this.graveByContract(chain, contract);
    if (buried) return err(409, 'already_buried', `${buried.meme.symbol} is already buried in grave #${buried.plot}.`);
    if (db.prepare("SELECT 1 FROM payments WHERE chain = ? AND contract = ? AND status IN ('pending','confirming')").get(chain, contract)) {
      return err(409, 'being_buried', 'Someone is burying this meme right now.');
    }
    const holds = (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE client_ip = ? AND status = 'pending'").get(ip) as { n: number }).n;
    if (holds >= MAX_HOLDS_PER_IP) return err(429, 'too_many_holds', 'Finish or cancel your other grave first.');

    // never trust metadata from the browser: resolve it here
    const res = await this.d.lookupNear(contract);
    if (!res.ok) return err(res.code === 'unavailable' ? 503 : 404, res.code, res.message);
    const meme = memeInfo(chain, contract, res.meta);

    const id = randomBytes(12).toString('base64url');
    const amount = this.d.tierUnits[tier].toString();
    try {
      db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, tier, message, meme_json, client_ip, created_at, expires_at, updated_at)
                  VALUES (?, 'grave', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, amount, plot, chain, contract, tier, message, JSON.stringify(meme), ip, now, now + this.d.holdMinutes * 60_000, now);
    } catch {
      // lost a race for the plot or the meme (partial unique indexes)
      return err(409, 'plot_reserved', 'Someone grabbed this grave or this meme a moment ago. Try again.');
    }
    this.d.log.info('grave payment created', { payment: id, plot, contract, tier });
    this.d.onReservedChanged?.(this.reservedPlots());
    return this.view(this.row(id)!);
  }

  getPayment(id: unknown): PaymentView | GraveError {
    const row = typeof id === 'string' ? this.row(id) : undefined;
    return row ? this.view(row) : err(404, 'not_found', 'Payment not found.');
  }

  cancelPayment(id: unknown, now: number): PaymentView | GraveError {
    const row = typeof id === 'string' ? this.row(id) : undefined;
    if (!row) return err(404, 'not_found', 'Payment not found.');
    if (row.status === 'pending' && !row.tx_hash) {
      this.setStatus(row.id, 'expired', null, now);
      this.d.onReservedChanged?.(this.reservedPlots());
    }
    return this.view(this.row(row.id)!);
  }

  /** Records the transaction and verifies it. Safe to call repeatedly. */
  async confirmPayment(id: unknown, txHash: string, signerId: string, now: number): Promise<PaymentView | GraveError> {
    const row = typeof id === 'string' ? this.row(id) : undefined;
    if (!row) return err(404, 'not_found', 'Payment not found.');
    if (!NEAR_ACCOUNT_RE.test(signerId)) return err(400, 'bad_account', 'That is not a NEAR account.');
    if (row.status === 'fulfilled' || row.status === 'failed' || row.status === 'unfulfillable') {
      if (row.tx_hash && row.tx_hash !== txHash) return err(409, 'already_confirmed', 'This payment was already confirmed with another transaction.');
      return this.view(row);
    }
    if (row.tx_hash && row.tx_hash !== txHash) return err(409, 'already_confirmed', 'This payment is already being confirmed with another transaction.');
    const other = this.d.db.prepare('SELECT id FROM payments WHERE tx_hash = ? AND id <> ?').get(txHash, row.id);
    if (other) return err(409, 'tx_used', 'That transaction was already used for another grave.');

    if (!row.tx_hash) {
      // pending -> confirming keeps the hold; an expired hold keeps its status but remembers the tx
      const next: PaymentStatus = row.status === 'pending' ? 'confirming' : row.status;
      this.d.db.prepare('UPDATE payments SET status = ?, tx_hash = ?, payer = ?, error = NULL, updated_at = ? WHERE id = ?').run(next, txHash, signerId, now, row.id);
    }
    await this.verifyNow(row.id, now);
    return this.view(this.row(row.id)!);
  }

  /** Background job: expire unpaid holds and re-check interrupted verifications. */
  async sweep(now: number): Promise<void> {
    this.expireHolds(now);
    const open = this.d.db.prepare("SELECT id FROM payments WHERE tx_hash IS NOT NULL AND status IN ('confirming','expired')").all() as { id: string }[];
    for (const { id } of open) await this.verifyNow(id, now);
  }

  // ------------------------------------------------------------------ internals

  private async verifyNow(id: string, now: number): Promise<void> {
    if (this.verifying.has(id)) return;
    this.verifying.add(id);
    try {
      const row = this.row(id);
      if (!row || !row.tx_hash || !row.payer) return;
      const result = await this.d.verify({
        txHash: row.tx_hash, signerId: row.payer, token: this.d.token, receiver: this.d.receiver, memo: memoFor(row.id), minAmount: BigInt(row.amount),
      });
      if (result.status === 'pending') {
        if (now - row.expires_at > VERIFY_GIVE_UP_MS) {
          this.setStatus(row.id, 'failed', 'The transaction could not be found on NEAR.', now);
          this.d.onReservedChanged?.(this.reservedPlots());
        }
        return;
      }
      if (result.status === 'invalid') {
        // let the player retry with the right transaction while the hold lasts
        const back: PaymentStatus = now <= row.expires_at ? 'pending' : 'expired';
        this.d.db.prepare('UPDATE payments SET status = ?, tx_hash = NULL, payer = NULL, error = ?, updated_at = ? WHERE id = ?').run(back, result.reason, now, row.id);
        this.d.log.warn('grave payment rejected', { payment: row.id, reason: result.reason });
        if (back === 'expired') this.d.onReservedChanged?.(this.reservedPlots());
        return;
      }
      this.fulfill(row, result.payer, now);
    } catch (e) {
      this.d.log.error('payment verification failed', { payment: id, err: e });
    } finally {
      this.verifying.delete(id);
    }
  }

  private fulfill(row: PaymentRow, payer: string, now: number) {
    const meme = JSON.parse(row.meme_json) as MemeInfo;
    const outcome = transaction(this.d.db, () => {
      const fresh = this.row(row.id)!;
      if (fresh.status === 'fulfilled') return 'already';
      if (this.d.db.prepare('SELECT 1 FROM graves WHERE plot = ?').get(row.plot)) return 'Paid, but this plot was taken after your hold expired.';
      if (this.d.db.prepare('SELECT 1 FROM graves WHERE chain = ? AND contract = ?').get(row.chain, row.contract)) {
        return 'Paid, but this meme was buried by someone else after your hold expired.';
      }
      this.d.db.prepare(`INSERT INTO graves (plot, chain, contract, tier, name, symbol, decimals, icon, message, creator, payment_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.plot, row.chain, row.contract, row.tier, meme.name, meme.symbol, meme.decimals, meme.icon, row.message, payer, row.id, now);
      this.d.db.prepare("UPDATE payments SET status = 'fulfilled', payer = ?, error = NULL, updated_at = ? WHERE id = ?").run(payer, now, row.id);
      // a late but valid payment wins over someone else's newer, still-unpaid hold on the same plot or meme
      this.d.db.prepare(`UPDATE payments SET status = 'expired', error = 'Someone else completed payment for this grave first.', updated_at = ?
                         WHERE id <> ? AND status = 'pending' AND tx_hash IS NULL AND (plot = ? OR (chain = ? AND contract = ?))`)
        .run(now, row.id, row.plot, row.chain, row.contract);
      return 'created';
    });
    if (outcome === 'created') {
      const g = this.graveByContract(row.chain as ChainId, row.contract)!;
      this.d.log.info('grave created', { payment: row.id, grave: g.id, plot: g.plot, contract: g.meme.contract, creator: payer, tx: row.tx_hash });
      this.d.onGraveAdded?.(g);
      this.d.onReservedChanged?.(this.reservedPlots());
    } else if (outcome !== 'already') {
      this.setStatus(row.id, 'unfulfillable', outcome, now);
      // money arrived but no grave could be made: needs a manual refund — make it loud in the logs
      this.d.log.error('PAID BUT UNFULFILLABLE — refund needed', { payment: row.id, tx: row.tx_hash, payer, amount: row.amount, reason: outcome });
      this.d.onReservedChanged?.(this.reservedPlots());
    }
  }

  private expireHolds(now: number) {
    const res = this.d.db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE status = 'pending' AND tx_hash IS NULL AND expires_at < ?").run(now, now);
    if (Number(res.changes) > 0) this.d.onReservedChanged?.(this.reservedPlots());
  }

  private setStatus(id: string, status: PaymentStatus, error: string | null, now: number) {
    this.d.db.prepare('UPDATE payments SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, now, id);
  }

  private row(id: string): PaymentRow | undefined {
    return this.d.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as PaymentRow | undefined;
  }

  private view(r: PaymentRow): PaymentView {
    const grave = r.status === 'fulfilled'
      ? (this.d.db.prepare('SELECT * FROM graves WHERE payment_id = ?').get(r.id) as GraveRow | undefined)
      : undefined;
    return {
      id: r.id, memo: memoFor(r.id), status: r.status, amount: r.amount, token: this.d.token, receiver: this.d.receiver,
      plot: r.plot, tier: r.tier as GraveTier, meme: JSON.parse(r.meme_json) as MemeInfo, message: r.message,
      expiresAt: r.expires_at, txHash: r.tx_hash, payer: r.payer, error: r.error, grave: grave ? graveInfo(grave) : null,
    };
  }
}

export const memoFor = (paymentId: string) => `rip:${paymentId}`;

function parseMemeRef(chainRaw: unknown, contractRaw: unknown): { chain: ChainId; contract: string } | GraveError {
  if (!isChain(chainRaw)) return err(400, 'bad_chain', 'Unknown chain.');
  if (!chainLive(chainRaw)) return err(400, 'chain_unsupported', 'Only NEAR memes can be buried for now. Other chains are coming.');
  const contract = typeof contractRaw === 'string' ? contractRaw.trim().toLowerCase() : '';
  if (!NEAR_ACCOUNT_RE.test(contract)) return err(400, 'bad_contract', 'That does not look like a NEAR token contract address.');
  return { chain: chainRaw, contract };
}

function memeInfo(chain: ChainId, contract: string, m: FtMetadata): MemeInfo {
  return { chain, contract, name: m.name, symbol: m.symbol, decimals: m.decimals, icon: m.icon };
}

function graveInfo(r: GraveRow): GraveInfo {
  return {
    id: r.id, plot: r.plot, tier: r.tier as GraveTier, message: r.message, creator: r.creator, createdAt: r.created_at,
    meme: { chain: r.chain as ChainId, contract: r.contract, name: r.name, symbol: r.symbol, decimals: r.decimals, icon: r.icon },
  };
}

/** Parses "75000,370000,740000,3700000" into per-tier prices. */
export function parseTierPrices(raw: string, decimals: number, toUnits: (w: string, d: number) => bigint): { units: Record<GraveTier, bigint>; whole: Record<GraveTier, string> } {
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== GRAVE_TIERS.length) throw new Error(`GRAVE_PRICES_WTH needs ${GRAVE_TIERS.length} comma-separated amounts`);
  const units = {} as Record<GraveTier, bigint>, whole = {} as Record<GraveTier, string>;
  GRAVE_TIERS.forEach((t, i) => {
    const v = toUnits(parts[i], decimals);
    if (v <= 0n) throw new Error('grave prices must be positive');
    units[t.tier] = v; whole[t.tier] = parts[i];
  });
  return { units, whole };
}
