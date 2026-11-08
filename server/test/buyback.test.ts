import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.ts';
import { Buyback, DCL, type BuybackChain, type Holder } from '../src/buyback.ts';
import { silentLogger } from '../src/log.ts';

const NEAR = 10n ** 24n, WTHU = 10n ** 18n;

class FakeChain implements BuybackChain {
  near = 0n; wth = 0n;
  sentNear: { to: string; amount: bigint }[] = [];
  swaps: { nearIn: bigint; minOut: bigint }[] = [];
  wthSent: { account: string; amount: bigint }[] = [];
  holderList: Holder[] = [];
  truncated = false;
  failNext: Error | null = null;
  rate = 270_000n;   // WTH per NEAR
  private maybeFail() { if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; } }
  async nearBalance() { return this.near; }
  async wthBalance() { return this.wth; }
  async ensureRegistered() {}
  async sendNear(to: string, amount: bigint) { this.maybeFail(); this.near -= amount; this.sentNear.push({ to, amount }); return 'TX_TEAM'; }
  async quoteWth(nearIn: bigint) { return (nearIn * this.rate * WTHU) / NEAR; }
  async swapNearForWth(nearIn: bigint, minOut: bigint) { this.maybeFail(); this.near -= nearIn; this.wth += (nearIn * this.rate * WTHU) / NEAR; this.swaps.push({ nearIn, minOut }); return 'TX_SWAP'; }
  async holders() { return { holders: this.holderList, truncated: this.truncated }; }
  async sendWth(batch: { account: string; amount: bigint }[]) { this.maybeFail(); for (const b of batch) { this.wth -= b.amount; this.wthSent.push(b); } return `TX_PAY_${this.wthSent.length}`; }
}

let db: Db, chain: FakeChain, bb: Buyback;
const make = (usd: number | null = 4) => new Buyback({
  db, log: silentLogger, chain, price: { usd: async () => usd },
  account: 'buyback.whatthehoot.near', teamWallet: 'whatthehoot.near', thresholdUsd: 20, teamPercent: 20,
  reserve: NEAR / 2n, minHolding: 100_000n * WTHU, exclude: [],
});
const W = (n: number) => BigInt(n) * WTHU;

beforeEach(() => {
  db = openDb(':memory:');
  chain = new FakeChain();
  chain.holderList = [
    { account: DCL, balance: W(541_000_000) },                    // the Ref pool: left out
    { account: 'root.near', balance: W(134_000_000) },            // a holder: included
    { account: 'intents.near', balance: W(22_000_000) },          // left out
    { account: 'whatthehoot.near', balance: W(18_000_000) },      // the team wallet: left out
    { account: 'alice.near', balance: W(16_000_000) },
    { account: 'small.near', balance: W(50_000) },                // below 100,000 WTH: left out
  ];
  bb = make();
});

describe('buyback', () => {
  it('waits until $20 has collected (above the 0.5 NEAR reserve)', async () => {
    chain.near = 5n * NEAR;            // 4.5 NEAR usable x $4 = $18
    await bb.run();
    expect(chain.sentNear).toHaveLength(0);
    expect(bb.collected?.usd).toBeCloseTo(18);
    expect(db.prepare('SELECT COUNT(*) AS n FROM buyback_rounds').get()).toMatchObject({ n: 0 });
  });

  it('runs a round: 20% to the WTH wallet, 80% buys WTH, shared with eligible holders by holding', async () => {
    chain.near = 6n * NEAR;            // 5.5 NEAR usable x $4 = $22
    await bb.run();
    const usable = 55n * NEAR / 10n;
    expect(chain.sentNear).toEqual([{ to: 'whatthehoot.near', amount: usable / 5n }]);
    expect(chain.swaps[0].nearIn).toBe(usable - usable / 5n);
    expect(chain.swaps[0].minOut).toBe((await chain.quoteWth(chain.swaps[0].nearIn)) * 98n / 100n);
    const got = (chain.swaps[0].nearIn * chain.rate * WTHU) / NEAR;
    const paid = Object.fromEntries(chain.wthSent.map((p) => [p.account, p.amount]));
    expect(Object.keys(paid).sort()).toEqual(['alice.near', 'root.near']);
    expect(paid['root.near']).toBe((got * W(134_000_000)) / W(150_000_000));
    expect(paid['alice.near']).toBe((got * W(16_000_000)) / W(150_000_000));
    const h = bb.history();
    expect(h[0]).toMatchObject({ status: 'done', teamTx: 'TX_TEAM', swapTx: 'TX_SWAP' });
    expect(h[0].payouts.every((p) => p.status === 'sent' && p.tx)).toBe(true);
  });

  it('never sends twice when a transaction outcome is unknown: stops for a manual check', async () => {
    chain.near = 6n * NEAR;
    chain.failNext = new Error('request timed out');
    await bb.run();
    expect(bb.history()[0]).toMatchObject({ status: 'needs_check' });
    chain.near = 100n * NEAR;
    await bb.run();
    await bb.run();
    expect(chain.sentNear).toHaveLength(0);                 // nothing resent, no new round while one needs checking
    expect(db.prepare('SELECT COUNT(*) AS n FROM buyback_rounds').get()).toMatchObject({ n: 1 });
  });

  it('retries a step that definitely failed (nothing was sent)', async () => {
    chain.near = 6n * NEAR;
    chain.failNext = new Error('InvalidNonce');
    await bb.run();
    expect(bb.history()[0]).toMatchObject({ status: 'running' });
    await bb.run();
    expect(bb.history()[0]).toMatchObject({ status: 'done' });
    expect(chain.sentNear).toHaveLength(1);
  });

  it('refuses to share out from a holder list that may be cut off above the minimum', async () => {
    chain.near = 6n * NEAR;
    chain.truncated = true;   // the list ends with alice (16M WTH) above the 100,000 minimum
    chain.holderList = chain.holderList.filter((h) => h.account !== 'small.near');
    await bb.run();
    expect(bb.history()[0]).toMatchObject({ status: 'needs_check' });
    expect(chain.wthSent).toHaveLength(0);
  });

  it('does nothing without a NEAR price', async () => {
    bb = make(null);
    chain.near = 100n * NEAR;
    await bb.run();
    expect(chain.sentNear).toHaveLength(0);
  });
});
