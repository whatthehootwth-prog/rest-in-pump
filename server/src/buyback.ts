import { Account } from '@near-js/accounts';
import { FailoverRpcProvider, JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';
import type { KeyPairString } from '@near-js/crypto';
import { transaction, type Db } from './db.ts';
import type { Logger } from './log.ts';
import { nearBalance, viewFunction, type NearRpc } from './near.ts';
import type { NearPrice } from './price.ts';

/**
 * Buyback rounds: game revenue (NEAR) collects in the buyback account; when it is worth THRESHOLD_USD,
 *   1. TEAM_PERCENT of it goes to the WTH wallet,
 *   2. the rest buys WTH on RHEA (WTH/NEAR DCL pool) with a slippage limit,
 *   3. the WTH bought is sent to WTH holders in proportion to their holdings (contracts, pools and small
 *      holders left out), in batches of ft_transfer.
 *
 * Every step is written to the database before it is attempted. If a step's outcome is unknown (for example the
 * RPC timed out after the transaction was sent), the round stops as `needs_check` instead of risking a double
 * send. Rounds and payouts are public (GET /api/buybacks).
 */

export const WTH = 'wth-0b2227.launchpad.justhoot.near';
export const WNEAR = 'wrap.near';
export const DCL = 'dclv2.ref-labs.near';
export const POOL = `${WNEAR}|${WTH}|10000`;
/** Contracts and wallets that never receive a share (pools, exchanges, launchpad, our own accounts). */
export const DEFAULT_EXCLUDE = [
  DCL, 'v2.ref-finance.near', 'intents.near', WTH, 'launchpad.justhoot.near', 'aa-router.justhoot.near', 'reward-distribute.justhoot.near',
];
const BATCH = 35;          // ft_transfers per transaction (35 x 8 Tgas fits in 300 Tgas)
const SLIPPAGE_BPS = 200n; // 2%

export interface Holder { account: string; balance: bigint }
export interface BuybackChain {
  /** Spendable NEAR of the buyback account (yocto). */
  nearBalance(): Promise<bigint>;
  wthBalance(): Promise<bigint>;
  /** Registers the buyback account for storage on wrap.near and WTH if needed. */
  ensureRegistered(): Promise<void>;
  sendNear(to: string, amount: bigint): Promise<string>;
  quoteWth(nearIn: bigint): Promise<bigint>;
  swapNearForWth(nearIn: bigint, minOut: bigint): Promise<string>;
  /** Largest WTH holders (as complete as the data source allows) and whether the list may be cut off. */
  holders(): Promise<{ holders: Holder[]; truncated: boolean }>;
  sendWth(batch: { account: string; amount: bigint }[]): Promise<string>;
}

export interface BuybackOptions {
  db: Db; log: Logger; chain: BuybackChain; price: NearPrice;
  account: string; teamWallet: string; thresholdUsd: number; teamPercent: number;
  reserve: bigint; minHolding: bigint; exclude: string[];
}

/** An unknown transaction outcome: never retried automatically. */
export class UnknownOutcome extends Error {}

interface RoundRow {
  id: number; status: 'running' | 'done' | 'failed' | 'needs_check'; step: string; near_total: string; near_team: string; near_buy: string;
  near_usd: number; team_tx: string | null; swap_tx: string | null; wth_bought: string | null; error: string | null; created_at: number; updated_at: number;
}

export class Buyback {
  private running = false;
  /** Last measured collected amount, for the public page. */
  collected: { near: string; usd: number | null; at: number } | null = null;
  private readonly o: BuybackOptions;
  private readonly exclude: Set<string>;
  constructor(o: BuybackOptions) {
    this.o = o;
    this.exclude = new Set([...DEFAULT_EXCLUDE, ...o.exclude, o.account, o.teamWallet]);
  }

  async run(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const open = this.o.db.prepare("SELECT * FROM buyback_rounds WHERE status = 'running' ORDER BY id LIMIT 1").get() as RoundRow | undefined;
      if (open) { await this.advance(open, now); return; }
      if (this.o.db.prepare("SELECT 1 FROM buyback_rounds WHERE status = 'needs_check'").get()) return;   // a human must look first
      const bal = await this.o.chain.nearBalance();
      const avail = bal > this.o.reserve ? bal - this.o.reserve : 0n;
      const usdPerNear = await this.o.price.usd();
      const usd = usdPerNear === null ? null : Number(avail / 10n ** 18n) / 1e6 * usdPerNear;
      this.collected = { near: avail.toString(), usd, at: now };
      if (usd === null || usd < this.o.thresholdUsd) return;
      const team = (avail * BigInt(Math.round(this.o.teamPercent * 100))) / 10_000n;
      const r = this.o.db.prepare(`INSERT INTO buyback_rounds (status, step, near_total, near_team, near_buy, near_usd, created_at, updated_at)
                                   VALUES ('running', 'team', ?, ?, ?, ?, ?, ?)`).run(avail.toString(), team.toString(), (avail - team).toString(), usd, now, now);
      this.o.log.info('buyback round started', { round: Number(r.lastInsertRowid), near: avail.toString(), usd });
      await this.advance(this.round(Number(r.lastInsertRowid))!, now);
    } catch (e) {
      this.o.log.error('buyback run failed', { err: String((e as Error)?.message ?? e) });
    } finally {
      this.running = false;
    }
  }

  private round(id: number) { return this.o.db.prepare('SELECT * FROM buyback_rounds WHERE id = ?').get(id) as RoundRow | undefined; }
  private setRound(id: number, fields: Partial<RoundRow>) {
    const keys = Object.keys(fields);
    this.o.db.prepare(`UPDATE buyback_rounds SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, string | number | null>)[k]), Date.now(), id);
  }
  private stop(id: number, status: 'failed' | 'needs_check', error: string) {
    this.setRound(id, { status, error });
    this.o.log.error(status === 'needs_check' ? 'BUYBACK NEEDS A MANUAL CHECK' : 'buyback round failed', { round: id, error });
  }

  /** Runs the remaining steps of a round. Each step is marked "…ing" before its transaction is sent. */
  private async advance(r: RoundRow, now: number) {
    const id = r.id, c = this.o.chain;
    try {
      if (r.step === 'team') {
        this.setRound(id, { step: 'team_sending' });
        const tx = await this.call(() => c.sendNear(this.o.teamWallet, BigInt(r.near_team)));
        this.setRound(id, { step: 'swap', team_tx: tx });
        r = this.round(id)!;
      } else if (r.step === 'team_sending' || r.step === 'swap_sending') {
        return this.stop(id, 'needs_check', `Interrupted while sending (${r.step}); check the account's transactions before resuming.`);
      }
      if (r.step === 'swap') {
        await c.ensureRegistered();
        const before = await c.wthBalance();
        const quote = await c.quoteWth(BigInt(r.near_buy));
        if (quote <= 0n) return this.stop(id, 'failed', 'RHEA returned no quote for the WTH/NEAR pool.');
        const minOut = (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        this.setRound(id, { step: 'swap_sending' });
        const tx = await this.call(() => c.swapNearForWth(BigInt(r.near_buy), minOut));
        const got = (await c.wthBalance()) - before;
        if (got <= 0n) return this.stop(id, 'needs_check', 'The swap transaction finished but no WTH arrived (the wNEAR may be left in the account).');
        this.setRound(id, { step: 'distribute', swap_tx: tx, wth_bought: got.toString() });
        r = this.round(id)!;
      }
      if (r.step === 'distribute') {
        if (!(this.o.db.prepare('SELECT 1 FROM buyback_payouts WHERE round_id = ?').get(id))) {
          const plan = await this.plan(BigInt(r.wth_bought!));
          if ('error' in plan) return this.stop(id, 'needs_check', plan.error);
          transaction(this.o.db, () => {
            for (const p of plan.payouts) this.o.db.prepare("INSERT INTO buyback_payouts (round_id, account, holding, amount, status) VALUES (?, ?, ?, ?, 'pending')")
              .run(id, p.account, p.holding.toString(), p.amount.toString());
          });
        }
        if (this.o.db.prepare("SELECT 1 FROM buyback_payouts WHERE round_id = ? AND status = 'sending'").get(id)) {
          return this.stop(id, 'needs_check', 'Interrupted while sending payouts; check which batch landed before resuming.');
        }
        for (;;) {
          const batch = this.o.db.prepare("SELECT account, amount FROM buyback_payouts WHERE round_id = ? AND status = 'pending' ORDER BY account LIMIT ?")
            .all(id, BATCH) as { account: string; amount: string }[];
          if (!batch.length) break;
          const mark = (status: string, tx: string | null) => transaction(this.o.db, () => {
            for (const b of batch) this.o.db.prepare('UPDATE buyback_payouts SET status = ?, tx = ? WHERE round_id = ? AND account = ?').run(status, tx, id, b.account);
          });
          mark('sending', null);
          const tx = await this.call(() => c.sendWth(batch.map((b) => ({ account: b.account, amount: BigInt(b.amount) }))));
          mark('sent', tx);
        }
        this.setRound(id, { step: 'done', status: 'done' });
        this.o.log.info('buyback round done', { round: id });
      }
    } catch (e) {
      if (e instanceof UnknownOutcome) return this.stop(id, 'needs_check', e.message);
      // a definite failure before anything was sent: undo the "…ing" marker so the next run retries this step
      const cur = this.round(id)!;
      if (cur.step.endsWith('_sending')) this.setRound(id, { step: cur.step.replace('_sending', '') });
      this.o.db.prepare("UPDATE buyback_payouts SET status = 'pending' WHERE round_id = ? AND status = 'sending'").run(id);
      this.setRound(id, { error: String((e as Error)?.message ?? e).slice(0, 300) });
      this.o.log.warn('buyback step failed, will retry', { round: id, err: String((e as Error)?.message ?? e) });
    }
    void now;
  }

  /** Runs a transaction; a timeout or lost response becomes UnknownOutcome (never retried automatically). */
  private async call(fn: () => Promise<string>): Promise<string> {
    try { return await fn(); } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/timeout|timed out|ECONNRESET|socket|network|fetch failed|aborted/i.test(msg)) throw new UnknownOutcome(`Transaction outcome unknown: ${msg.slice(0, 200)}`);
      throw e;
    }
  }

  /** Who gets how much: holders above the minimum, excluded accounts left out, in proportion to holdings. */
  async plan(total: bigint): Promise<{ payouts: { account: string; holding: bigint; amount: bigint }[] } | { error: string }> {
    const { holders, truncated } = await this.o.chain.holders();
    const eligible = holders.filter((h) => !this.exclude.has(h.account) && h.balance >= this.o.minHolding);
    if (truncated && holders.length && holders[holders.length - 1].balance >= this.o.minHolding) {
      return { error: 'The holder list may be cut off above the minimum holding; refusing to distribute an incomplete list.' };
    }
    if (!eligible.length) return { error: 'No eligible holders found.' };
    const sum = eligible.reduce((a, h) => a + h.balance, 0n);
    const payouts = eligible.map((h) => ({ account: h.account, holding: h.balance, amount: (total * h.balance) / sum })).filter((p) => p.amount > 0n);
    return { payouts };
  }

  /** Public history. */
  history(limit = 20) {
    const rounds = this.o.db.prepare('SELECT * FROM buyback_rounds ORDER BY id DESC LIMIT ?').all(limit) as unknown as RoundRow[];
    return rounds.map((r) => ({
      id: r.id, status: r.status, at: r.created_at, nearTotal: r.near_total, nearTeam: r.near_team, nearBuy: r.near_buy, usd: r.near_usd,
      teamTx: r.team_tx, swapTx: r.swap_tx, wthBought: r.wth_bought,
      payouts: (this.o.db.prepare('SELECT account, holding, amount, status, tx FROM buyback_payouts WHERE round_id = ? ORDER BY CAST(amount AS REAL) DESC').all(r.id) as
        { account: string; holding: string; amount: string; status: string; tx: string | null }[]),
    }));
  }
}

// ------------------------------------------------------------------ the real chain

export function nearBuybackChain(o: { rpc: NearRpc; rpcUrls: string[]; account: string; privateKey: string }): BuybackChain {
  const provider = new FailoverRpcProvider(o.rpcUrls.map((url) => new JsonRpcProvider({ url })));
  const acct = new Account(o.account, provider, KeyPairSigner.fromSecretKey(o.privateKey as KeyPairString));
  const view = async (contract: string, method: string, args: object) => {
    const r = await viewFunction(o.rpc, contract, method, args);
    if ('error' in r) throw new Error(`${contract}.${method}: ${r.error}`);
    return r.value;
  };
  const send = async (receiverId: string, actions: ReturnType<typeof actionCreators.transfer>[]) => {
    const out = await acct.signAndSendTransaction({ receiverId, actions, throwOnFailure: false });
    const st = out.status as { SuccessValue?: string; Failure?: unknown };
    if (typeof st !== 'object' || st.SuccessValue === undefined) throw new Error(`transaction failed: ${JSON.stringify(st?.Failure ?? st).slice(0, 300)}`);
    return out.transaction_outcome.id;
  };
  const TGAS = 1_000_000_000_000n;
  return {
    async nearBalance() { const b = await nearBalance(o.rpc, o.account); if (b === null) throw new Error('balance unavailable'); return BigInt(b); },
    async wthBalance() { return BigInt(String(await view(WTH, 'ft_balance_of', { account_id: o.account }))); },
    async ensureRegistered() {
      for (const token of [WNEAR, WTH]) {
        const s = await view(token, 'storage_balance_of', { account_id: o.account });
        if (s === null) await send(token, [actionCreators.functionCall('storage_deposit', { account_id: o.account, registration_only: true }, 30n * TGAS, 1_250_000_000_000_000_000_000n)]);
      }
    },
    sendNear: (to, amount) => send(to, [actionCreators.transfer(amount)]),
    async quoteWth(nearIn) {
      const q = await view(DCL, 'quote', { pool_ids: [POOL], input_token: WNEAR, output_token: WTH, input_amount: nearIn.toString(), tag: null }) as { amount?: string };
      return BigInt(q?.amount ?? '0');
    },
    swapNearForWth: (nearIn, minOut) => send(WNEAR, [
      actionCreators.functionCall('near_deposit', {}, 10n * TGAS, nearIn),
      actionCreators.functionCall('ft_transfer_call', {
        receiver_id: DCL, amount: nearIn.toString(),
        msg: JSON.stringify({ Swap: { pool_ids: [POOL], output_token: WTH, min_output_amount: minOut.toString(), skip_unwrap_near: true } }),
      }, 200n * TGAS, 1n),
    ]),
    async holders() {
      const r = await fetch(`https://api.fastnear.com/v1/ft/${WTH}/top`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`holder list ${r.status}`);
      const j = (await r.json()) as { accounts?: { account_id: string; balance: string }[] };
      const holders = (j.accounts ?? []).map((a) => ({ account: a.account_id, balance: BigInt(a.balance) })).sort((a, b) => (b.balance > a.balance ? 1 : -1));
      return { holders, truncated: holders.length >= 100 };
    },
    sendWth: (batch) => send(WTH, batch.map((b) => actionCreators.functionCall('ft_transfer', { receiver_id: b.account, amount: b.amount.toString(), memo: 'Rest In Pump buyback' }, 8n * TGAS, 1n))),
  };
}
