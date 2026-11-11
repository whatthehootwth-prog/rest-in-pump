import { randomBytes, randomInt } from 'node:crypto';
import {
  NEAR_ACCOUNT_RE, OFFERING_ITEMS, RECENT_ITEMS, itemExp, memeAddress, chainLive, isChain, isOfferingItem, isPlotId, levelFor, parseUnits, plotById, sanitizeMessage,
  type ChainId, type GraveDetail, type GraveInfo, type GravesSnapshot, type MemeInfo, type MemorialStatus, type MemorialView,
  type PaymentStatus, type PaymentView, type PriceConfig,
} from '../../shared/graves.ts';
import { transaction, type Db } from './db.ts';
import type { Logger } from './log.ts';
import type { FtMetadata, MetadataResult, TransferCheck, TransferResult } from './near.ts';
import { usdToYocto, type NearPrice } from './price.ts';

/**
 * Graves and offerings, both paid in NEAR (priced in USD at the live NEAR price) and verified on chain.
 *
 * Grave:    createGrave HOLDS an empty plot + the meme for a few minutes and returns the exact transfer to make;
 *           confirmPayment verifies the transfer and creates the grave in one transaction.
 * Offering: createOffering returns the transfer for an offering (item + amount >= the minimum) to an existing grave.
 *           Once verified, the grave gets exactly one offering and the gift's EXP, and if it is this wallet's
 *           first offering to the grave, a Memorial NFT is queued for it (see minter.ts). Retries, duplicate
 *           confirmations and failed transactions never count: one payment row = at most one offering row.
 * A background sweep expires unpaid holds and re-checks payments whose verification was interrupted.
 */

export interface GraveServiceDeps {
  db: Db;
  log: Logger;
  /** Account that receives the NEAR. */
  receiver: string;
  /** Price to create a grave in USD (exact decimal string like "1"). Gift prices are in OFFERING_ITEMS. */
  gravePriceUsd: string;
  /** Live NEAR/USD price. */
  price: NearPrice;
  holdMinutes: number;
  /** Memorial NFT contract when minting is configured, else null (memorials still queue). */
  nftContract: string | null;
  mintingEnabled: boolean;
  /** Reads a meme's name, ticker and logo from its own chain. */
  lookupMeme(chain: ChainId, contract: string): Promise<MetadataResult>;
  verify(check: TransferCheck): Promise<TransferResult>;
  onGraveAdded?(g: GraveInfo): void;
  onGraveUpdated?(g: GraveInfo, offering: { item: string; payer: string; levelUp: boolean }): void;
  onReservedChanged?(reserved: number[]): void;
  onMemorialQueued?(): void;
}

export type GraveError = { code: string; message: string; status: number };
const err = (status: number, code: string, message: string): GraveError => ({ status, code, message });
/** SQL: the order is this browser's (by session), or, for a caller without a session, an old-style order from its IP. */
const OWNER = '((? IS NOT NULL AND client_session = ?) OR (client_session IS NULL AND client_ip = ?))';

interface PaymentRow {
  id: string; kind: 'grave' | 'offering'; status: PaymentStatus; amount: string; plot: number; chain: string; contract: string;
  grave_id: number | null; item: string | null; message: string; meme_json: string; tx_hash: string | null; payer: string | null;
  error: string | null; client_ip: string | null; client_session: string | null; created_at: number; expires_at: number; updated_at: number;
}
/** Orders made with a session can only be confirmed / cancelled from that browser. */
const owns = (row: PaymentRow, session: string | null) => !row.client_session || row.client_session === session;

interface GraveRow {
  id: number; plot: number; chain: string; contract: string; name: string; symbol: string; decimals: number | null;
  icon: string | null; message: string; creator: string; payment_id: string; created_at: number; offering_count: number; exp: number;
}
export interface MemorialRow {
  grave_id: number; account_id: string; status: MemorialStatus; token_id: string | null; serial: number | null;
  attempts: number; next_attempt_at: number; error: string | null; mint_tx: string | null;
  first_offering_at: number; created_at: number; updated_at: number;
}

/** Plots one IP can hold at once (waiting for payment or being confirmed). */
const MAX_HOLDS_PER_IP = 2;
/** Unpaid gifts one browser can have open, and one IP (many people can share an IP). */
const MAX_OPEN_OFFERINGS_PER_SESSION = 3;
const MAX_OPEN_OFFERINGS_PER_IP = 10;
/** A submitted transaction NEAR has not seen after this long stops holding its plot (it is still re-checked). */
const UNSEEN_RELEASE_MS = 10 * 60 * 1000;
/** Verifications started straight from confirm requests at once; the rest are left to the background sweep. */
const MAX_LIVE_VERIFY = 8;
const RECENT_OFFERINGS = 10;
/** After a hold expires, how long we keep re-checking a submitted transaction before giving up. */
const VERIFY_GIVE_UP_MS = 30 * 60 * 1000;

const META_TTL_MS = 10 * 60_000;
const META_CACHE_MAX = 500;
const META_MISS_TTL_MS = 60_000;

export class GraveService {
  private readonly d: GraveServiceDeps;
  /** Recently read coin metadata (name, ticker, logo), so lookups and NFT previews don't hit the chains every time. */
  private readonly metaCache = new Map<string, { at: number; meta: FtMetadata }>();
  private readonly metaMisses = new Map<string, { at: number; res: MetadataResult }>();
  private readonly metaRunning = new Map<string, Promise<MetadataResult>>();
  private readonly verifying = new Set<string>();

  constructor(deps: GraveServiceDeps) { this.d = deps; }

  async config(): Promise<PriceConfig> {
    const nearUsd = await this.d.price.usd();
    return {
      currency: 'NEAR', decimals: 24, receiver: this.d.receiver,
      gravePriceUsd: this.d.gravePriceUsd, nearUsd,
      gravePrice: nearUsd ? usdToYocto(this.d.gravePriceUsd, nearUsd).toString() : null,
      gifts: OFFERING_ITEMS.map((it) => ({ id: it.id, usd: it.usd, exp: it.exp, price: nearUsd ? usdToYocto(it.usd, nearUsd).toString() : null })),
      holdMinutes: this.d.holdMinutes, mintingEnabled: this.d.mintingEnabled, nftContract: this.d.nftContract,
    };
  }

  /**
   * base (a whole number of 0.000001 NEAR) + a random tail below 0.000001 NEAR that no other recent order has.
   * The exact amount is how a plain NEAR transfer (which has no memo) is matched to its order.
   */
  private uniqueAmount(base: bigint): bigint {
    for (let i = 0; i < 50; i++) {
      const amount = base + BigInt(randomInt(1, 1_000_000)) * 10n ** 12n;
      if (!this.d.db.prepare('SELECT 1 FROM payments WHERE amount = ?').get(amount.toString())) return amount;
    }
    throw new Error('could not find a unique amount');
  }

  snapshot(): GravesSnapshot {
    const rows = this.d.db.prepare('SELECT * FROM graves ORDER BY id').all() as unknown as GraveRow[];
    const recent = this.recentItems(null), counts = this.itemCounts(null);
    return { graves: rows.map((r) => graveInfo(r, recent.get(r.id) ?? [], counts.get(r.id) ?? {})), reserved: this.reservedPlots() };
  }

  reservedPlots(): number[] {
    const rows = this.d.db.prepare("SELECT plot FROM payments WHERE kind = 'grave' AND status IN ('pending','confirming') ORDER BY plot").all() as { plot: number }[];
    return rows.map((r) => r.plot);
  }

  grave(id: number): GraveInfo | null {
    const row = this.d.db.prepare('SELECT * FROM graves WHERE id = ?').get(id) as GraveRow | undefined;
    return row ? graveInfo(row, this.recentItems(id).get(id) ?? [], this.itemCounts(id).get(id) ?? {}) : null;
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

  /** Coin metadata from its chain, cached for a few minutes (only successful reads are cached). */
  private async meta(chain: ChainId, contract: string): Promise<MetadataResult> {
    const key = `${chain}:${contract}`, hit = this.metaCache.get(key), now = Date.now();
    if (hit && now - hit.at < META_TTL_MS) return { ok: true, meta: hit.meta };
    const miss = this.metaMisses.get(key);
    if (miss && now - miss.at < META_MISS_TTL_MS) return miss.res;
    // the same coin looked up by many requests at once: one chain lookup (and one logo download) for all of them
    const running = this.metaRunning.get(key);
    if (running) return running;
    const p = this.d.lookupMeme(chain, contract).then((res) => {
      if (res.ok) {
        this.metaCache.delete(key);
        this.metaCache.set(key, { at: Date.now(), meta: res.meta });
        if (this.metaCache.size > META_CACHE_MAX) this.metaCache.delete(this.metaCache.keys().next().value!);
      } else if (res.code !== 'unavailable') {
        // "no such token" answers are remembered for a minute, so repeating a bad address costs nothing
        this.metaMisses.set(key, { at: Date.now(), res });
        if (this.metaMisses.size > META_CACHE_MAX) this.metaMisses.delete(this.metaMisses.keys().next().value!);
      }
      return res;
    }).finally(() => this.metaRunning.delete(key));
    this.metaRunning.set(key, p);
    return p;
  }

  /** Resolves a meme by contract. Also says whether it already has a grave. */
  async lookup(chainRaw: unknown, contractRaw: unknown): Promise<{ meme: MemeInfo; grave: GraveInfo | null } | GraveError> {
    const parsed = parseMemeRef(chainRaw, contractRaw);
    if ('code' in parsed) return parsed;
    const { chain, contract } = parsed;
    const res = await this.meta(chain, contract);
    if (!res.ok) return err(res.code === 'unavailable' ? 503 : 404, res.code, res.message);
    return { meme: memeInfo(chain, contract, res.meta), grave: this.graveByContract(chain, contract) };
  }

  async createGrave(input: { plot: unknown; chain: unknown; contract: unknown; message: unknown }, ip: string, now: number, session: string | null = null): Promise<PaymentView | GraveError> {
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
    const mine = db.prepare(`SELECT * FROM payments WHERE kind = 'grave' AND plot = ? AND chain = ? AND contract = ? AND ${OWNER} AND status IN ('pending','confirming')`)
      .get(plot, chain, contract, session, session, ip) as PaymentRow | undefined;
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
    // holds being confirmed count too: a made-up transaction hash must not free up the limit
    const holds = (db.prepare("SELECT COUNT(*) AS n FROM payments WHERE kind = 'grave' AND client_ip = ? AND status IN ('pending','confirming')").get(ip) as { n: number }).n;
    if (holds >= MAX_HOLDS_PER_IP) return err(429, 'too_many_holds', 'Finish or cancel your other grave first.');

    // never trust metadata from the browser: resolve it here
    const res = await this.meta(chain, contract);
    if (!res.ok) return err(res.code === 'unavailable' ? 503 : 404, res.code, res.message);
    const meme = memeInfo(chain, contract, res.meta);

    const nearUsd = await this.d.price.usd();
    if (!nearUsd) return err(503, 'price_unavailable', 'Could not get the NEAR price right now. Try again in a minute.');
    const amount = this.uniqueAmount(usdToYocto(this.d.gravePriceUsd, nearUsd));
    const id = newId();
    try {
      db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, message, meme_json, client_ip, client_session, created_at, expires_at, updated_at)
                  VALUES (?, 'grave', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, amount.toString(), plot, chain, contract, message, JSON.stringify(meme), ip, session, now, now + this.d.holdMinutes * 60_000, now);
    } catch {
      // lost a race for the plot or the meme (partial unique indexes)
      return err(409, 'plot_reserved', 'Someone grabbed this plot or this meme a moment ago. Try again.');
    }
    this.d.log.info('grave payment created', { payment: id, plot, contract });
    this.d.onReservedChanged?.(this.reservedPlots());
    return this.view(this.row(id)!);
  }

  /** A gift at a grave. The price comes from the gift (its USD price at the live NEAR price), never from the browser. */
  async createOffering(input: { graveId: unknown; item: unknown }, ip: string, now: number, session: string | null = null): Promise<PaymentView | GraveError> {
    this.expireHolds(now);
    const graveId = Number(input.graveId);
    const grave = Number.isInteger(graveId) && graveId > 0 ? this.grave(graveId) : null;
    if (!grave) return err(404, 'not_found', 'That grave does not exist.');
    if (!isOfferingItem(input.item)) return err(400, 'bad_item', 'Pick something to leave at the grave.');
    const db = this.d.db;
    const item = input.item;
    // same gift still waiting for payment from this browser (closed the dialog, came back): resume it.
    // Never by IP alone: two wallets on one Wi-Fi must not share an order (only one of their transfers could count).
    const same = session ? db.prepare("SELECT * FROM payments WHERE kind = 'offering' AND grave_id = ? AND item = ? AND client_session = ? AND status = 'pending' AND tx_hash IS NULL ORDER BY created_at DESC")
      .get(graveId, item, session) as PaymentRow | undefined : undefined;
    if (same) return this.view(same);
    const nearUsd = await this.d.price.usd();
    if (!nearUsd) return err(503, 'price_unavailable', 'Could not get the NEAR price right now. Try again in a minute.');
    const amount = this.uniqueAmount(usdToYocto(OFFERING_ITEMS.find((i) => i.id === item)!.usd, nearUsd));
    const openBy = (col: 'client_ip' | 'client_session', v: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE kind = 'offering' AND ${col} = ? AND status = 'pending' AND tx_hash IS NULL`).get(v) as { n: number }).n;
    if ((session && openBy('client_session', session) >= MAX_OPEN_OFFERINGS_PER_SESSION) || openBy('client_ip', ip) >= MAX_OPEN_OFFERINGS_PER_IP) {
      return err(429, 'too_many_open', 'Finish or cancel your other offerings first.');
    }

    const id = newId();
    db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, grave_id, item, message, meme_json, client_ip, client_session, created_at, expires_at, updated_at)
                VALUES (?, 'offering', 'pending', ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`)
      .run(id, amount.toString(), grave.plot, grave.meme.chain, grave.meme.contract, graveId, item, JSON.stringify(grave.meme), ip, session, now, now + this.d.holdMinutes * 60_000, now);
    this.d.log.info('offering payment created', { payment: id, grave: graveId, item, amount: amount.toString() });
    return this.view(this.row(id)!);
  }

  getPayment(id: unknown): PaymentView | GraveError {
    const row = typeof id === 'string' ? this.row(id) : undefined;
    return row ? this.view(row) : err(404, 'not_found', 'Not found.');
  }

  cancelPayment(id: unknown, now: number, session: string | null = null): PaymentView | GraveError {
    const row = typeof id === 'string' ? this.row(id) : undefined;
    if (!row) return err(404, 'not_found', 'Not found.');
    if (!owns(row, session)) return err(403, 'not_yours', 'This order was started in another browser.');
    if (row.status === 'pending' && !row.tx_hash) {
      this.setStatus(row.id, 'expired', null, now);
      if (row.kind === 'grave') this.d.onReservedChanged?.(this.reservedPlots());
    }
    return this.view(this.row(row.id)!);
  }

  /** Records the transaction and verifies it. Safe to call repeatedly. */
  async confirmPayment(id: unknown, txHash: string, signerId: string, now: number, session: string | null = null): Promise<PaymentView | GraveError> {
    const row = typeof id === 'string' ? this.row(id) : undefined;
    if (!row) return err(404, 'not_found', 'Not found.');
    if (!owns(row, session)) return err(403, 'not_yours', 'This order was started in another browser.');
    if (!NEAR_ACCOUNT_RE.test(signerId)) return err(400, 'bad_account', 'That is not a NEAR account.');
    if (row.status === 'fulfilled' || row.status === 'failed' || row.status === 'unfulfillable') {
      if (row.tx_hash && row.tx_hash !== txHash) return err(409, 'already_confirmed', 'This was already confirmed with another transaction.');
      return this.view(row);
    }
    if (row.tx_hash && row.tx_hash !== txHash) return err(409, 'already_confirmed', 'This is already being confirmed with another transaction.');
    const other = this.d.db.prepare('SELECT id FROM payments WHERE tx_hash = ? AND id <> ?').get(txHash, row.id);
    if (other) return err(409, 'tx_used', 'That transaction was already used.');

    if (!row.tx_hash) {
      // pending -> confirming keeps the hold; an expired hold keeps its status but remembers the tx
      const next: PaymentStatus = row.status === 'pending' ? 'confirming' : row.status;
      this.d.db.prepare('UPDATE payments SET status = ?, tx_hash = ?, payer = ?, error = NULL, updated_at = ? WHERE id = ?').run(next, txHash, signerId, now, row.id);
    }
    // under a flood of confirms, the background sweep checks the rest (the hash is saved either way)
    if (this.verifying.size < MAX_LIVE_VERIFY) await this.verifyNow(row.id, now);
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
        txHash: row.tx_hash, signerId: row.payer, receiver: this.d.receiver, amount: BigInt(row.amount), notBefore: row.created_at,
      });
      if (result.status === 'pending') {
        if (row.status === 'confirming' && now > row.expires_at && now - row.updated_at > UNSEEN_RELEASE_MS) {
          // a hash NEAR has never seen stops holding the plot; the record (and its hash) stays and is still checked,
          // so a real but slow payment is still fulfilled (or flagged for a refund if the plot went to someone else)
          this.d.db.prepare("UPDATE payments SET status = 'expired', error = ?, updated_at = ? WHERE id = ? AND status = 'confirming'")
            .run('Your transaction has not shown up on NEAR yet. We keep checking it.', now, row.id);
          if (row.kind === 'grave') this.d.onReservedChanged?.(this.reservedPlots());
          return;
        }
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
      if (this.d.db.prepare('SELECT 1 FROM graves WHERE plot = ?').get(row.plot)) return 'Your NEAR arrived, but this plot was taken after your reservation expired.';
      if (this.d.db.prepare('SELECT 1 FROM graves WHERE chain = ? AND contract = ?').get(row.chain, row.contract)) {
        return 'Your NEAR arrived, but someone else created a grave for this meme after your reservation expired.';
      }
      const ins = this.d.db.prepare(`INSERT INTO graves (plot, chain, contract, name, symbol, decimals, icon, message, creator, payment_id, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.plot, row.chain, row.contract, meme.name, meme.symbol, meme.decimals, meme.icon, row.message, payer, row.id, now);
      // the creator gets the grave's first Memorial NFT (#001: it is queued before anyone can leave a gift)
      this.d.db.prepare(`INSERT INTO memorials (grave_id, account_id, status, first_offering_at, created_at, updated_at)
                         VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT (grave_id, account_id) DO NOTHING`)
        .run(Number(ins.lastInsertRowid), payer, now, now, now);
      this.d.db.prepare("UPDATE payments SET status = 'fulfilled', payer = ?, error = NULL, updated_at = ? WHERE id = ?").run(payer, now, row.id);
      // a late but valid payment wins over someone else's newer, still-unpaid hold on the same plot or meme
      this.d.db.prepare(`UPDATE payments SET status = 'expired', error = 'Someone else created this grave first.', updated_at = ?
                         WHERE kind = 'grave' AND id <> ? AND status = 'pending' AND tx_hash IS NULL AND (plot = ? OR (chain = ? AND contract = ?))`)
        .run(now, row.id, row.plot, row.chain, row.contract);
      return 'created';
    });
    if (outcome === 'created') {
      const g = this.graveByContract(row.chain as ChainId, row.contract)!;
      this.d.log.info('grave created', { payment: row.id, grave: g.id, plot: g.plot, contract: g.meme.contract, creator: payer, tx: row.tx_hash });
      this.d.onGraveAdded?.(g);
      this.d.onReservedChanged?.(this.reservedPlots());
      this.d.onMemorialQueued?.();
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
      const g = db.prepare('SELECT exp FROM graves WHERE id = ?').get(row.grave_id) as { exp: number } | undefined;
      if (!g) return { kind: 'error' as const, reason: 'Your NEAR arrived, but this grave no longer exists.' };
      // payment_id is UNIQUE: a payment can only ever become one offering
      const exp = itemExp(row.item ?? '');
      db.prepare('INSERT INTO offerings (grave_id, payment_id, payer, item, amount, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.grave_id, row.id, payer, row.item, row.amount, exp, now);
      db.prepare('UPDATE graves SET offering_count = offering_count + 1, exp = exp + ? WHERE id = ?').run(exp, row.grave_id);
      // first offering by this wallet to this grave: queue its Memorial NFT (one per wallet per grave)
      const queued = db.prepare(`INSERT INTO memorials (grave_id, account_id, status, first_offering_at, created_at, updated_at)
                                 VALUES (?, ?, 'pending', ?, ?, ?) ON CONFLICT (grave_id, account_id) DO NOTHING`)
        .run(row.grave_id, payer, now, now, now);
      db.prepare("UPDATE payments SET status = 'fulfilled', payer = ?, error = NULL, updated_at = ? WHERE id = ?").run(payer, now, row.id);
      return { kind: 'done' as const, before: g.exp, firstMemorial: Number(queued.changes) > 0 };
    });
    if (outcome.kind === 'done') {
      const g = this.grave(row.grave_id!)!;
      const levelUp = levelFor(outcome.before) !== g.level;
      this.d.log.info('offering made', { payment: row.id, grave: g.id, item: row.item, payer, amount: row.amount, offerings: g.offerings, exp: g.exp, level: g.level, tx: row.tx_hash });
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
  /** Offerings per item per grave (all graves when id is null). */
  private itemCounts(id: number | null): Map<number, Record<string, number>> {
    const rows = this.d.db.prepare(`SELECT grave_id, item, COUNT(*) AS n FROM offerings ${id === null ? '' : 'WHERE grave_id = ?'} GROUP BY grave_id, item`)
      .all(...(id === null ? [] : [id])) as { grave_id: number; item: string; n: number }[];
    const out = new Map<number, Record<string, number>>();
    for (const r of rows) {
      const m = out.get(r.grave_id) ?? {};
      m[r.item] = r.n;
      out.set(r.grave_id, m);
    }
    return out;
  }

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
      id: r.id, kind: r.kind, status: r.status, amount: r.amount, receiver: this.d.receiver,
      plot: r.plot, meme: JSON.parse(r.meme_json) as MemeInfo, message: r.message, graveId: r.grave_id, item: r.item,
      expiresAt: r.expires_at, txHash: r.tx_hash, payer: r.payer, error: r.error, grave, memorial,
    };
  }
}

/** yoctoNEAR -> "0.003571" (trailing zeros trimmed, 6 decimals max). */
export function trimNear(yocto: bigint): string {
  const micro = (yocto + 10n ** 18n - 1n) / 10n ** 18n;
  const whole = micro / 1_000_000n, frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
const newId = () => randomBytes(12).toString('base64url');

function parseMemeRef(chainRaw: unknown, contractRaw: unknown): { chain: ChainId; contract: string } | GraveError {
  if (!isChain(chainRaw)) return err(400, 'bad_chain', 'Unknown chain.');
  if (!chainLive(chainRaw)) return err(400, 'chain_unsupported', 'Only NEAR and Solana memes can have graves for now.');
  const contract = memeAddress(chainRaw, contractRaw);
  if (!contract) return err(400, 'bad_contract', chainRaw === 'solana' ? 'That does not look like a Solana token address.' : 'That does not look like a NEAR token contract address.');
  return { chain: chainRaw, contract };
}

function memeInfo(chain: ChainId, contract: string, m: FtMetadata): MemeInfo {
  return { chain, contract, name: m.name, symbol: m.symbol, decimals: m.decimals, icon: m.icon };
}

function graveInfo(r: GraveRow, recentItems: string[], itemCounts: Record<string, number>): GraveInfo {
  return {
    id: r.id, plot: r.plot, message: r.message, creator: r.creator, createdAt: r.created_at,
    offerings: r.offering_count, exp: r.exp, level: levelFor(r.exp), recentItems, itemCounts,
    meme: { chain: r.chain as ChainId, contract: r.contract, name: r.name, symbol: r.symbol, decimals: r.decimals, icon: r.icon },
  };
}

export function memorialView(r: MemorialRow): MemorialView {
  return { graveId: r.grave_id, account: r.account_id, status: r.status, tokenId: r.token_id, serial: r.serial, error: r.status === 'minted' ? null : r.error };
}
