import { randomBytes } from 'node:crypto';
import {
  NEAR_ACCOUNT_RE, RECENT_ITEMS, chainLive, isChain, isOfferingItem, isPlotId, levelFor, parseUnits, plotById, sanitizeMessage,
  type ChainId, type GraveDetail, type GraveInfo, type GravesSnapshot, type MemeInfo, type MemorialStatus, type MemorialView,
  type PaymentStatus, type PaymentView, type PriceConfig,
} from '../../shared/graves.ts';
import { transaction, type Db } from './db.ts';
import type { Logger } from './log.ts';
import type { FtMetadata, MetadataResult, TransferCheck, TransferResult } from './near.ts';

/**
 * Graves and offerings, both paid in WTH and verified on NEAR.
 *
 * Grave:    createGrave HOLDS an empty plot + the meme for a few minutes and returns the exact transfer to make;
 *           confirmPayment verifies the transfer and creates the grave in one transaction.
 * Offering: createOffering returns the transfer for an offering (item + amount >= the minimum) to an existing grave.
 *           Once verified, the grave's community offering count goes up by exactly one, and if it is this wallet's
 *           first offering to the grave, a Memorial NFT is queued for it (see minter.ts). Retries, duplicate
 *           confirmations and failed transactions never count: one payment row = at most one offering row.
 * A background sweep expires unpaid holds and re-checks payments whose verification was interrupted.
 */

export interface GraveServiceDeps {
  db: Db;
  log: Logger;
  token: string;
  receiver: string;
  decimals: number;
  /** Price to create a grave, in the token's smallest unit and as whole tokens (exact decimal string). */
  gravePrice: { units: bigint; whole: string };
  /** Minimum offering, same two forms. */
  offeringMin: { units: bigint; whole: string };
  holdMinutes: number;
  /** Memorial NFT contract when minting is configured, else null (memorials still queue). */
  nftContract: string | null;
  mintingEnabled: boolean;
  lookupNear(contract: string): Promise<MetadataResult>;
  verify(check: TransferCheck): Promise<TransferResult>;
  onGraveAdded?(g: GraveInfo): void;
  onGraveUpdated?(g: GraveInfo, offering: { item: string; payer: string; levelUp: boolean }): void;
  onReservedChanged?(reserved: number[]): void;
  onMemorialQueued?(): void;
}

export type GraveError = { code: string; message: string; status: number };
const err = (status: number, code: string, message: string): GraveError => ({ status, code, message });

interface PaymentRow {
  id: string; kind: 'grave' | 'offering'; status: PaymentStatus; amount: string; plot: number; chain: string; contract: string;
  grave_id: number | null; item: string | null; message: string; meme_json: string; tx_hash: string | null; payer: string | null;
  error: string | null; client_ip: string | null; created_at: number; expires_at: number; updated_at: number;
}
interface GraveRow {
  id: number; plot: number; chain: string; contract: string; name: string; symbol: string; decimals: number | null;
  icon: string | null; message: string; creator: string; payment_id: string; created_at: number; offering_count: number;
}
export interface MemorialRow {
  grave_id: number; account_id: string; status: MemorialStatus; token_id: string | null; serial: number | null;
  attempts: number; next_attempt_at: number; error: string | null; mint_tx: string | null;
  first_offering_at: number; created_at: number; updated_at: number;
}

const MAX_HOLDS_PER_IP = 2;
const MAX_OPEN_OFFERINGS_PER_IP = 3;
const RECENT_OFFERINGS = 10;
/** After a hold expires, how long we keep re-checking a submitted transaction before giving up. */
const VERIFY_GIVE_UP_MS = 30 * 60 * 1000;

export class GraveService {
  private readonly d: GraveServiceDeps;
  private readonly verifying = new Set<string>();

  constructor(deps: GraveServiceDeps) { this.d = deps; }

  config(): PriceConfig {
    return {
      token: this.d.token, receiver: this.d.receiver, decimals: this.d.decimals,
      gravePrice: this.d.gravePrice.whole, offeringMin: this.d.offeringMin.whole, holdMinutes: this.d.holdMinutes,
      mintingEnabled: this.d.mintingEnabled, nftContract: this.d.nftContract,
    };
  }

  snapshot(): GravesSnapshot {
    const rows = this.d.db.prepare('SELECT * FROM graves ORDER BY id').all() as unknown as GraveRow[];
    const recent = this.recentItems(null);
    return { graves: rows.map((r) => graveInfo(r, recent.get(r.id) ?? [])), reserved: this.reservedPlots() };
  }

  reservedPlots(): number[] {
    const rows = this.d.db.prepare("SELECT plot FROM payments WHERE kind = 'grave' AND status IN ('pending','confirming') ORDER BY plot").all() as { plot: number }[];
    return rows.map((r) => r.plot);
  }

  grave(id: number): GraveInfo | null {
    const row = this.d.db.prepare('SELECT * FROM graves WHERE id = ?').get(id) as GraveRow | undefined;
    return row ? graveInfo(row, this.recentItems(id).get(id) ?? []) : null;
  }

  graveByContract(chain: ChainId, contract: string): GraveInfo | null {
    const row = this.d.db.prepare('SELECT id FROM graves WHERE chain = ? AND contract = ?').get(chain, contract) as { id: number } | undefined;
    return row ? this.grave(row.id) : null;
  }

  /** A grave with its recent offerings, and the asking wallet's memorial + offering count. */
  detail(idRaw: unknown, accountRaw: unknown): GraveDetail | GraveError {
    const id = Number(idRaw);
    const grave = Number.isInteger(id) && id > 0 ? this.grave(id) : null;
    if (!grave) return err(404, 'not_found', 'Grave not found.');
    let account: string | null = null;
    if (accountRaw !== null && accountRaw !== undefined && accountRaw !== '') {
      if (typeof accountRaw !== 'string' || !NEAR_ACCOUNT_RE.test(accountRaw)) return err(400, 'bad_account', 'That is not a NEAR account.');
      account = accountRaw;
    }
    const db = this.d.db;
    const recent = (db.prepare('SELECT item, payer, amount, created_at FROM offerings WHERE grave_id = ? ORDER BY id DESC LIMIT ?').all(id, RECENT_OFFERINGS) as
      { item: string; payer: string; amount: string; created_at: number }[]).map((r) => ({ item: r.item, payer: r.payer, amount: r.amount, at: r.created_at }));
    const memorials = (db.prepare('SELECT COUNT(*) AS n FROM memorials WHERE grave_id = ?').get(id) as { n: number }).n;
    const mine = account ? this.memorial(id, account) : null;
    const myOfferings = account ? (db.prepare('SELECT COUNT(*) AS n FROM offerings WHERE grave_id = ? AND payer = ?').get(id, account) as { n: number }).n : 0;
    return { grave, recent, memorials, mine, myOfferings };
  }

  memorial(graveId: number, account: string): MemorialView | null {
    const row = this.d.db.prepare('SELECT * FROM memorials WHERE grave_id = ? AND account_id = ?').get(graveId, account) as MemorialRow | undefined;
    return row ? memorialView(row) : null;
  }

  /** Everything the NFT metadata (token JSON) needs for a minted memorial. */
  memorialByToken(tokenId: string): { memorial: MemorialRow; grave: GraveInfo; personalOfferings: number } | null {
    const m = this.d.db.prepare("SELECT * FROM memorials WHERE token_id = ? AND status = 'minted'").get(tokenId) as MemorialRow | undefined;
    if (!m) return null;
    const grave = this.grave(m.grave_id);
    if (!grave) return null;
    const personalOfferings = (this.d.db.prepare('SELECT COUNT(*) AS n FROM offerings WHERE grave_id = ? AND payer = ?').get(m.grave_id, m.account_id) as { n: number }).n;
    return { memorial: m, grave, personalOfferings };
  }

  memorialCount(graveId: number): number {
    return (this.d.db.prepare("SELECT COUNT(*) AS n FROM memorials WHERE grave_id = ? AND status = 'minted'").get(graveId) as { n: number }).n;
  }

  /** Resolves a meme by contract. Also says whether it already has a grave. */
  async lookup(chainRaw: unknown, contractRaw: unknown): Promise<{ meme: MemeInfo; grave: GraveInfo | null } | GraveError> {
    const parsed = parseMemeRef(chainRaw, contractRaw);
    if ('code' in parsed) return parsed;
    const { chain, contract } = parsed;
    const res = await this.d.lookupNear(contract);
    if (!res.ok) return err(res.code === 'unavailable' ? 503 : 404, res.code, res.message);
    return { meme: memeInfo(chain, contract, res.meta), grave: this.graveByContract(chain, contract) };
  }

  async createGrave(input: { plot: unknown; chain: unknown; contract: unknown; message: unknown }, ip: string, now: number): Promise<PaymentView | GraveError> {
    this.expireHolds(now);
    if (!isPlotId(input.plot) || !plotById(input.plot)) return err(400, 'bad_plot', 'That is not an empty grave plot.');
    const message = sanitizeMessage(input.message);
    if (!message) return err(400, 'bad_message', 'Leave a message of 1–100 characters.');
    const parsed = parseMemeRef(input.chain, input.contract);
    if ('code' in parsed) return parsed;
    const { chain, contract } = parsed;
    const plot = input.plot;
    const db = this.d.db;

    // resuming an open hold for exactly the same grave (e.g. after closing the dialog) returns it
    const mine = db.prepare("SELECT * FROM payments WHERE kind = 'grave' AND plot = ? AND chain = ? AND contract = ? AND client_ip = ? AND status IN ('pending','confirming')")
      .get(plot, chain, contract, ip) as PaymentRow | undefined;
    if (mine && mine.message === message) return this.view(mine);
    if (mine && mine.status === 'pending' && !mine.tx_hash) this.setStatus(mine.id, 'expired', null, now);   // changed their mind: replace it

    if (db.prepare('SELECT 1 FROM graves WHERE plot = ?').get(plot)) return err(409, 'plot_taken', 'Someone already has a grave here.');
    if (db.prepare("SELECT 1 FROM payments WHERE kind = 'grave' AND plot = ? AND status IN ('pending','confirming')").get(plot)) {
      return err(409, 'plot_reserved', 'Someone is creating a grave here right now. Try another empty plot.');
    }
    const existing = this.graveByContract(chain, contract);
    if (existing) return err(409, 'grave_exists', `${existing.meme.symbol} already has a grave (plot #${existing.plot}). Leave an offering there instead.`);
    if (db.prepare("SELECT 1 FROM payments WHERE kind = 'grave' AND chain = ? AND contract = ? AND status IN ('pending','confirming')").get(chain, contract)) {
      return err(409, 'grave_in_progress', 'Someone is creating a grave for this meme right now.');
    }
    const holds = (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE kind = 'grave' AND client_ip = ? AND status = 'pending'").get(ip) as { n: number }).n;
    if (holds >= MAX_HOLDS_PER_IP) return err(429, 'too_many_holds', 'Finish or cancel your other grave first.');

    // never trust metadata from the browser: resolve it here
    const res = await this.d.lookupNear(contract);
    if (!res.ok) return err(res.code === 'unavailable' ? 503 : 404, res.code, res.message);
    const meme = memeInfo(chain, contract, res.meta);

    const id = newId();
    try {
      db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, message, meme_json, client_ip, created_at, expires_at, updated_at)
                  VALUES (?, 'grave', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, this.d.gravePrice.units.toString(), plot, chain, contract, message, JSON.stringify(meme), ip, now, now + this.d.holdMinutes * 60_000, now);
    } catch {
      // lost a race for the plot or the meme (partial unique indexes)
      return err(409, 'plot_reserved', 'Someone grabbed this plot or this meme a moment ago. Try again.');
    }
    this.d.log.info('grave payment created', { payment: id, plot, contract });
    this.d.onReservedChanged?.(this.reservedPlots());
    return this.view(this.row(id)!);
  }

  async createOffering(input: { graveId: unknown; item: unknown; amount: unknown }, ip: string, now: number): Promise<PaymentView | GraveError> {
    this.expireHolds(now);
    const graveId = Number(input.graveId);
    const grave = Number.isInteger(graveId) && graveId > 0 ? this.grave(graveId) : null;
    if (!grave) return err(404, 'not_found', 'That grave does not exist.');
    if (!isOfferingItem(input.item)) return err(400, 'bad_item', 'Pick something to leave at the grave.');
    let amount: bigint;
    try {
      if (typeof input.amount !== 'string') throw new Error('not a string');
      amount = parseUnits(input.amount.trim(), this.d.decimals);
    } catch {
      return err(400, 'bad_amount', 'Enter a WTH amount, like 10000.');
    }
    if (amount < this.d.offeringMin.units) return err(400, 'amount_too_low', `The minimum offering is ${this.d.offeringMin.whole} WTH.`);
    const db = this.d.db;
    const item = input.item;

    // same offering still waiting for payment from this visitor (closed the dialog, came back): resume it
    const same = db.prepare("SELECT * FROM payments WHERE kind = 'offering' AND grave_id = ? AND item = ? AND amount = ? AND client_ip = ? AND status = 'pending' AND tx_hash IS NULL")
      .get(graveId, item, amount.toString(), ip) as PaymentRow | undefined;
    if (same) return this.view(same);
    const open = (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE kind = 'offering' AND client_ip = ? AND status = 'pending' AND tx_hash IS NULL").get(ip) as { n: number }).n;
    if (open >= MAX_OPEN_OFFERINGS_PER_IP) return err(429, 'too_many_open', 'Finish or cancel your other offerings first.');

    const id = newId();
    db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, grave_id, item, message, meme_json, client_ip, created_at, expires_at, updated_at)
                VALUES (?, 'offering', 'pending', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`)
      .run(id, amount.toString(), grave.plot, grave.meme.chain, grave.meme.contract, graveId, item, JSON.stringify(grave.meme), ip, now, now + this.d.holdMinutes * 60_000, now);
    this.d.log.info('offering payment created', { payment: id, grave: graveId, item, amount: amount.toString() });
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
      if (row.kind === 'grave') this.d.onReservedChanged?.(this.reservedPlots());
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
    if (other) return err(409, 'tx_used', 'That transaction was already used for another payment.');

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
          if (row.kind === 'grave') this.d.onReservedChanged?.(this.reservedPlots());
        }
        return;
      }
      if (result.status === 'invalid') {
        // let the player retry with the right transaction while the hold lasts
        const back: PaymentStatus = now <= row.expires_at ? 'pending' : 'expired';
        this.d.db.prepare('UPDATE payments SET status = ?, tx_hash = NULL, payer = NULL, error = ?, updated_at = ? WHERE id = ?').run(back, result.reason, now, row.id);
        this.d.log.warn('payment rejected', { payment: row.id, kind: row.kind, reason: result.reason });
        if (back === 'expired' && row.kind === 'grave') this.d.onReservedChanged?.(this.reservedPlots());
        return;
      }
      if (row.kind === 'grave') this.fulfillGrave(row, result.payer, now);
      else this.fulfillOffering(row, result.payer, now);
    } catch (e) {
      this.d.log.error('payment verification failed', { payment: id, err: e });
    } finally {
      this.verifying.delete(id);
    }
  }

  private fulfillGrave(row: PaymentRow, payer: string, now: number) {
    const meme = JSON.parse(row.meme_json) as MemeInfo;
    const outcome = transaction(this.d.db, () => {
      const fresh = this.row(row.id)!;
      if (fresh.status === 'fulfilled') return 'already';
      if (this.d.db.prepare('SELECT 1 FROM graves WHERE plot = ?').get(row.plot)) return 'Paid, but this plot was taken after your hold expired.';
      if (this.d.db.prepare('SELECT 1 FROM graves WHERE chain = ? AND contract = ?').get(row.chain, row.contract)) {
        return 'Paid, but someone else created a grave for this meme after your hold expired.';
      }
      // creating a grave does not mint an NFT; the creator gets one by making an offering like anyone else
      this.d.db.prepare(`INSERT INTO graves (plot, chain, contract, name, symbol, decimals, icon, message, creator, payment_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.plot, row.chain, row.contract, meme.name, meme.symbol, meme.decimals, meme.icon, row.message, payer, row.id, now);
      this.d.db.prepare("UPDATE payments SET status = 'fulfilled', payer = ?, error = NULL, updated_at = ? WHERE id = ?").run(payer, now, row.id);
      // a late but valid payment wins over someone else's newer, still-unpaid hold on the same plot or meme
      this.d.db.prepare(`UPDATE payments SET status = 'expired', error = 'Someone else completed payment for this grave first.', updated_at = ?
                         WHERE kind = 'grave' AND id <> ? AND status = 'pending' AND tx_hash IS NULL AND (plot = ? OR (chain = ? AND contract = ?))`)
        .run(now, row.id, row.plot, row.chain, row.contract);
      return 'created';
    });
    if (outcome === 'created') {
      const g = this.graveByContract(row.chain as ChainId, row.contract)!;
      this.d.log.info('grave created', { payment: row.id, grave: g.id, plot: g.plot, contract: g.meme.contract, creator: payer, tx: row.tx_hash });
      this.d.onGraveAdded?.(g);
      this.d.onReservedChanged?.(this.reservedPlots());
    } else if (outcome !== 'already') {
      this.markUnfulfillable(row, payer, outcome, now);
      this.d.onReservedChanged?.(this.reservedPlots());
    }
  }

  private fulfillOffering(row: PaymentRow, payer: string, now: number) {
    const db = this.d.db;
    const outcome = transaction(db, () => {
      const fresh = this.row(row.id)!;
      if (fresh.status === 'fulfilled') return { kind: 'already' as const };
      const g = db.prepare('SELECT offering_count FROM graves WHERE id = ?').get(row.grave_id) as { offering_count: number } | undefined;
      if (!g) return { kind: 'error' as const, reason: 'Paid, but this grave no longer exists.' };
      // payment_id is UNIQUE: a payment can only ever become one offering
      db.prepare('INSERT INTO offerings (grave_id, payment_id, payer, item, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.grave_id, row.id, payer, row.item, row.amount, now);
      db.prepare('UPDATE graves SET offering_count = offering_count + 1 WHERE id = ?').run(row.grave_id);
      // first offering by this wallet to this grave: queue its Memorial NFT (one per wallet per grave)
      const queued = db.prepare(`INSERT INTO memorials (grave_id, account_id, status, first_offering_at, created_at, updated_at)
                                 VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT (grave_id, account_id) DO NOTHING`)
        .run(row.grave_id, payer, now, now, now);
      db.prepare("UPDATE payments SET status = 'fulfilled', payer = ?, error = NULL, updated_at = ? WHERE id = ?").run(payer, now, row.id);
      return { kind: 'done' as const, before: g.offering_count, firstMemorial: Number(queued.changes) > 0 };
    });
    if (outcome.kind === 'done') {
      const g = this.grave(row.grave_id!)!;
      const levelUp = levelFor(outcome.before) !== g.level;
      this.d.log.info('offering made', { payment: row.id, grave: g.id, item: row.item, payer, amount: row.amount, offerings: g.offerings, level: g.level, tx: row.tx_hash });
      this.d.onGraveUpdated?.(g, { item: row.item!, payer, levelUp });
      if (outcome.firstMemorial) this.d.onMemorialQueued?.();
    } else if (outcome.kind === 'error') {
      this.markUnfulfillable(row, payer, outcome.reason, now);
    }
  }

  private markUnfulfillable(row: PaymentRow, payer: string, reason: string, now: number) {
    this.setStatus(row.id, 'unfulfillable', reason, now);
    // money arrived but nothing could be made from it: needs a manual refund — make it loud in the logs
    this.d.log.error('PAID BUT UNFULFILLABLE — refund needed', { payment: row.id, kind: row.kind, tx: row.tx_hash, payer, amount: row.amount, reason });
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

  /** Newest offering items per grave (all graves when id is null). */
  private recentItems(id: number | null): Map<number, string[]> {
    const rows = this.d.db.prepare(`SELECT grave_id, item FROM (
        SELECT grave_id, item, id, ROW_NUMBER() OVER (PARTITION BY grave_id ORDER BY id DESC) AS rn FROM offerings ${id === null ? '' : 'WHERE grave_id = ?'}
      ) WHERE rn <= ? ORDER BY grave_id, id DESC`).all(...(id === null ? [RECENT_ITEMS] : [id, RECENT_ITEMS])) as { grave_id: number; item: string }[];
    const out = new Map<number, string[]>();
    for (const r of rows) {
      const list = out.get(r.grave_id) ?? [];
      list.push(r.item);
      out.set(r.grave_id, list);
    }
    return out;
  }

  private view(r: PaymentRow): PaymentView {
    let grave: GraveInfo | null = null;
    if (r.kind === 'grave' && r.status === 'fulfilled') {
      const g = this.d.db.prepare('SELECT id FROM graves WHERE payment_id = ?').get(r.id) as { id: number } | undefined;
      grave = g ? this.grave(g.id) : null;
    } else if (r.kind === 'offering' && r.grave_id !== null) {
      grave = this.grave(r.grave_id);
    }
    const memorial = r.kind === 'offering' && r.status === 'fulfilled' && r.payer && r.grave_id !== null ? this.memorial(r.grave_id, r.payer) : null;
    return {
      id: r.id, kind: r.kind, memo: memoFor(r.id), status: r.status, amount: r.amount, token: this.d.token, receiver: this.d.receiver,
      plot: r.plot, meme: JSON.parse(r.meme_json) as MemeInfo, message: r.message, graveId: r.grave_id, item: r.item,
      expiresAt: r.expires_at, txHash: r.tx_hash, payer: r.payer, error: r.error, grave, memorial,
    };
  }
}

export const memoFor = (paymentId: string) => `rip:${paymentId}`;
const newId = () => randomBytes(12).toString('base64url');

function parseMemeRef(chainRaw: unknown, contractRaw: unknown): { chain: ChainId; contract: string } | GraveError {
  if (!isChain(chainRaw)) return err(400, 'bad_chain', 'Unknown chain.');
  if (!chainLive(chainRaw)) return err(400, 'chain_unsupported', 'Only NEAR memes can have graves for now. Other chains are coming.');
  const contract = typeof contractRaw === 'string' ? contractRaw.trim().toLowerCase() : '';
  if (!NEAR_ACCOUNT_RE.test(contract)) return err(400, 'bad_contract', 'That does not look like a NEAR token contract address.');
  return { chain: chainRaw, contract };
}

function memeInfo(chain: ChainId, contract: string, m: FtMetadata): MemeInfo {
  return { chain, contract, name: m.name, symbol: m.symbol, decimals: m.decimals, icon: m.icon };
}

function graveInfo(r: GraveRow, recentItems: string[]): GraveInfo {
  return {
    id: r.id, plot: r.plot, message: r.message, creator: r.creator, createdAt: r.created_at,
    offerings: r.offering_count, level: levelFor(r.offering_count), recentItems,
    meme: { chain: r.chain as ChainId, contract: r.contract, name: r.name, symbol: r.symbol, decimals: r.decimals, icon: r.icon },
  };
}

export function memorialView(r: MemorialRow): MemorialView {
  return { graveId: r.grave_id, account: r.account_id, status: r.status, tokenId: r.token_id, serial: r.serial, error: r.status === 'minted' ? null : r.error };
}

/** "75000" whole tokens -> both forms, positive. */
export function parsePrice(name: string, whole: string, decimals: number): { units: bigint; whole: string } {
  let units: bigint;
  try { units = parseUnits(whole.trim(), decimals); } catch { throw new Error(`${name} must be a WTH amount like 75000`); }
  if (units <= 0n) throw new Error(`${name} must be positive`);
  return { units, whole: whole.trim() };
}
