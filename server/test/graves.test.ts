import { describe, expect, it, beforeEach } from 'vitest';
import { openDb, type Db } from '../src/db.ts';
import { GraveService, trimNear } from '../src/graves.ts';
import { MemorialMinter, describe as describeMemorial, type MemorialChain } from '../src/minter.ts';
import { memorialSvg } from '../src/nft.ts';
import type { MetadataResult, TransferCheck, TransferResult } from '../src/near.ts';
import { silentLogger } from '../src/log.ts';
import { levelFor, nextLevelIn, type GraveDetail, type GraveInfo, type PaymentView } from '../../shared/graves.ts';

const TOKEN = 'wth-0b2227.launchpad.justhoot.near', TREASURY = 'whatthehoot.near';
const META: Record<string, MetadataResult> = {
  'dogshit.near': { ok: true, meta: { name: 'Dog Shit', symbol: 'DOGSHIT', decimals: 18, icon: 'data:image/png;base64,AAAA' } },
  'rug.near': { ok: true, meta: { name: 'Rug', symbol: 'RUG', decimals: 24, icon: null } },
  'nothing.near': { ok: false, code: 'not_found', message: 'No NEAR account with that address.' },
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': { ok: true, meta: { name: 'Bonk', symbol: 'Bonk', decimals: 5, icon: 'data:image/webp;base64,AAAA' } },
};
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
let lookups: string[] = [];
const NEAR = 10n ** 24n;
const STEP = 10n ** 18n;          // 0.000001 NEAR
let nearUsd: number | null = 2.5; // $2.50 per NEAR in these tests, so $0.01 = 0.004 NEAR
/** The order amount is the base price plus a unique tail below 0.000001 NEAR. */
const baseOf = (amount: string) => (BigInt(amount) / STEP) * STEP;

let verifyResult: (c: TransferCheck) => TransferResult;
let db: Db;
let svc: GraveService;
let added: GraveInfo[];
let updates: { grave: GraveInfo; offering: { item: string; payer: string; levelUp: boolean } }[];
let queued: number;
let txn = 0;
const H = (n: number) => String(n).padStart(6, '0').replace(/0/g, 'a') + 'H'.repeat(38);   // valid-looking, unique tx hashes
const nextTx = () => H(++txn);

beforeEach(() => {
  added = []; updates = []; queued = 0; nearUsd = 2.5; lookups = [];
  verifyResult = (c) => ({ status: 'ok', payer: c.signerId, amount: c.amount });
  db = openDb(':memory:');
  svc = new GraveService({
    db, log: silentLogger, receiver: TREASURY,
    gravePriceUsd: '0.01', offeringMinUsd: '0.01', price: { usd: async () => nearUsd },
    holdMinutes: 15, nftContract: 'memorial.whatthehoot.near', mintingEnabled: true,
    lookupMeme: async (chain, c) => (lookups.push(`${chain}:${c}`), META[c]) ?? { ok: false, code: 'not_token', message: 'nope' },
    verify: async (c) => verifyResult(c),
    onGraveAdded: (g) => added.push(g),
    onGraveUpdated: (grave, offering) => updates.push({ grave, offering }),
    onMemorialQueued: () => { queued++; },
  });
});

const create = (over: Record<string, unknown> = {}, ip = '1.1.1.1', now = 1000) =>
  svc.createGrave({ plot: 1, chain: 'near', contract: 'dogshit.near', message: 'gone too soon', ...over }, ip, now);
const ok = <T,>(v: T | { code: string }): T => { if (v && typeof v === 'object' && 'code' in v && 'status' in (v as object)) throw new Error(JSON.stringify(v)); return v as T; };
const makeGrave = async (creator = 'alice.near', over: Record<string, unknown> = {}) => {
  const p = ok(await create(over)) as PaymentView;
  return (ok(await svc.confirmPayment(p.id, nextTx(), creator, 2000)) as PaymentView).grave!;
};
const offer = async (graveId: number, payer: string, over: Record<string, unknown> = {}, ip = '5.5.5.5', now = 3000) => {
  const p = ok(await svc.createOffering({ graveId, item: 'candle', amount: '0.01', ...over }, ip, now)) as PaymentView;
  return ok(await svc.confirmPayment(p.id, nextTx(), payer, now + 1)) as PaymentView;
};

describe('graves', () => {
  it('Solana memes: mint address keeps its case, is read from Solana, and is paid in NEAR', async () => {
    const r = await svc.lookup('solana', ` ${BONK} `);
    expect(r).toMatchObject({ meme: { chain: 'solana', contract: BONK, symbol: 'Bonk' }, grave: null });
    expect(lookups).toEqual([`solana:${BONK}`]);
    expect(await svc.lookup('solana', BONK.toLowerCase().replace(/l/g, 'L'))).toMatchObject({ code: 'not_token' });   // lowercased mint is a different address
    expect(await svc.lookup('solana', 'dogshit.near')).toMatchObject({ code: 'bad_contract' });
    expect(await svc.lookup('solana', '0OIl' + 'a'.repeat(40))).toMatchObject({ code: 'bad_contract' });   // not base58
    expect(await svc.lookup('near', BONK)).toMatchObject({ code: 'not_token' });   // lowercased it is a valid NEAR name, but no such token
    expect(await svc.lookup('base', '0xabc')).toMatchObject({ code: 'chain_unsupported' });
    const g = await makeGrave('alice.near', { chain: 'solana', contract: BONK });
    expect(g).toMatchObject({ meme: { chain: 'solana', contract: BONK, name: 'Bonk' }, plot: 1, level: 1 });
    expect(await create({ plot: 2, chain: 'solana', contract: BONK })).toMatchObject({ code: 'grave_exists' });
    expect((await svc.lookup('solana', BONK) as { grave: GraveInfo }).grave.id).toBe(g.id);
  });

  it('creates a hold with the exact transfer to make, at one grave price', async () => {
    const p = ok(await create()) as PaymentView;
    expect(p).toMatchObject({ kind: 'grave', status: 'pending', receiver: TREASURY });
    expect(baseOf(p.amount)).toBe(4n * NEAR / 1000n);                 // $0.01 at $2.50 = 0.004 NEAR
    expect(BigInt(p.amount)).toBeGreaterThan(baseOf(p.amount));         // + a unique tail
    expect(p.meme).toMatchObject({ name: 'Dog Shit', symbol: 'DOGSHIT', icon: 'data:image/png;base64,AAAA' });
    expect(svc.snapshot().reserved).toEqual([1]);
    expect(await svc.config()).toMatchObject({ currency: 'NEAR', gravePriceUsd: '0.01', offeringMinUsd: '0.01', nearUsd: 2.5, gravePrice: (4n * NEAR / 1000n).toString(), mintingEnabled: true });
  });

  it('validates input', async () => {
    expect(await create({ plot: 41 })).toMatchObject({ code: 'bad_plot' });
    expect(await create({ message: 'x'.repeat(101) })).toMatchObject({ code: 'bad_message' });
    expect(await create({ message: '   ' })).toMatchObject({ code: 'bad_message' });
    expect(await create({ chain: 'base' })).toMatchObject({ code: 'chain_unsupported' });
    expect(await create({ contract: 'NOT VALID!!' })).toMatchObject({ code: 'bad_contract' });
    expect(await create({ contract: 'nothing.near' })).toMatchObject({ code: 'not_found' });
  });

  it('holds the plot and the meme against other buyers', async () => {
    ok(await create());
    expect(await create({ contract: 'rug.near' }, '2.2.2.2')).toMatchObject({ code: 'plot_reserved' });
    expect(await create({ plot: 2 }, '2.2.2.2')).toMatchObject({ code: 'grave_in_progress' });
  });

  it('returns the same hold when the same player asks again', async () => {
    const a = ok(await create()) as PaymentView, b = ok(await create()) as PaymentView;
    expect(b.id).toBe(a.id);
  });

  it('confirms a verified payment into a level-1 grave, exactly once, without minting anything', async () => {
    const p = ok(await create()) as PaymentView;
    const done = ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 2000)) as PaymentView;
    expect(done.status).toBe('fulfilled');
    expect(done.grave).toMatchObject({ plot: 1, level: 1, offerings: 0, creator: 'alice.near', message: 'gone too soon', meme: { contract: 'dogshit.near' } });
    expect(added).toHaveLength(1);
    expect(queued).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memorials').get()).toMatchObject({ n: 0 });
    const again = ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 3000)) as PaymentView;
    expect(again.status).toBe('fulfilled');
    expect(svc.snapshot().graves).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(await svc.confirmPayment(p.id, H(2), 'alice.near', 3000)).toMatchObject({ code: 'already_confirmed' });
  });

  it('never makes two graves for one meme and never reuses a plot', async () => {
    await makeGrave();
    expect(await create({ plot: 2 }, '2.2.2.2')).toMatchObject({ code: 'grave_exists' });
    expect(await create({ contract: 'rug.near' }, '2.2.2.2')).toMatchObject({ code: 'plot_taken' });
    expect(await svc.lookup('near', 'dogshit.near')).toMatchObject({ grave: { plot: 1 } });
  });

  it('refuses a transaction already used for another payment', async () => {
    const a = ok(await create()) as PaymentView;
    ok(await svc.confirmPayment(a.id, H(1), 'alice.near', 2000));
    const b = ok(await create({ plot: 2, contract: 'rug.near' }, '3.3.3.3')) as PaymentView;
    expect(await svc.confirmPayment(b.id, H(1), 'alice.near', 2500)).toMatchObject({ code: 'tx_used' });
  });

  it('keeps the hold while NEAR has not finalised the transaction, then completes in the background', async () => {
    verifyResult = () => ({ status: 'pending' });
    const p = ok(await create()) as PaymentView;
    expect((ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 2000)) as PaymentView).status).toBe('confirming');
    expect(svc.snapshot().reserved).toEqual([1]);
    verifyResult = (c) => ({ status: 'ok', payer: c.signerId, amount: c.amount });
    await svc.sweep(5000);
    expect((svc.getPayment(p.id) as PaymentView).status).toBe('fulfilled');
  });

  it('lets the player retry after a wrong or underpaid transaction', async () => {
    verifyResult = () => ({ status: 'invalid', reason: 'The amount sent is less than the price.' });
    const p = ok(await create()) as PaymentView;
    expect(ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 2000))).toMatchObject({ status: 'pending', txHash: null, error: 'The amount sent is less than the price.' });
    verifyResult = (c) => ({ status: 'ok', payer: c.signerId, amount: c.amount });
    expect((ok(await svc.confirmPayment(p.id, H(2), 'alice.near', 2500)) as PaymentView).status).toBe('fulfilled');
  });

  it('expires unpaid holds', async () => {
    const p = ok(await create({}, '1.1.1.1', 0)) as PaymentView;
    await svc.sweep(16 * 60_000);
    expect((svc.getPayment(p.id) as PaymentView).status).toBe('expired');
    expect(svc.snapshot().reserved).toEqual([]);
    ok(await create({ contract: 'rug.near' }, '2.2.2.2', 16 * 60_000));
  });

  it('accepts a late payment if the grave is still free, and flags it for refund if not', async () => {
    const late = ok(await create({}, '1.1.1.1', 0)) as PaymentView;
    await svc.sweep(16 * 60_000);
    expect((ok(await svc.confirmPayment(late.id, H(1), 'alice.near', 17 * 60_000)) as PaymentView).status).toBe('fulfilled');

    const p2 = ok(await create({ plot: 5, contract: 'rug.near' }, '1.1.1.1', 0)) as PaymentView;
    await svc.sweep(16 * 60_000);
    const winner = ok(await create({ plot: 5, contract: 'rug.near' }, '9.9.9.9', 16 * 60_000)) as PaymentView;
    ok(await svc.confirmPayment(winner.id, H(2), 'bob.near', 16 * 60_000 + 1));
    const loser = ok(await svc.confirmPayment(p2.id, H(3), 'carol.near', 17 * 60_000)) as PaymentView;
    expect(loser.status).toBe('unfulfillable');
    expect(loser.error).toMatch(/taken|someone else/);
  });

  it('limits open holds per player and allows cancelling', async () => {
    const a = ok(await create({ plot: 1, contract: 'dogshit.near' })) as PaymentView;
    ok(await create({ plot: 2, contract: 'rug.near' }));
    META['third.near'] = META['rug.near'];
    expect(await create({ plot: 3, contract: 'third.near' })).toMatchObject({ code: 'too_many_holds' });
    expect((svc.cancelPayment(a.id, 2000) as PaymentView).status).toBe('expired');
    ok(await create({ plot: 3, contract: 'third.near' }));
  });
});

describe('NEAR pricing', () => {
  it('every order gets a unique exact amount, so a plain transfer can be matched to it', async () => {
    const g = await makeGrave();
    const amounts = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const p = ok(await svc.createOffering({ graveId: g.id, item: ['candle', 'rug', 'diamond'][i], amount: '0.01' }, `7.7.7.${i}`, 3000)) as PaymentView;
      amounts.add(p.amount);
      expect(baseOf(p.amount)).toBe(NEAR / 100n);
    }
    expect(amounts.size).toBe(3);
  });

  it('pauses orders with a clear message when no NEAR price is available', async () => {
    nearUsd = null;
    expect(await create()).toMatchObject({ code: 'price_unavailable', status: 503 });
    expect(await svc.config()).toMatchObject({ nearUsd: null, gravePrice: null, offeringMin: null });
  });

  it('allows a 3% price move between showing the minimum and ordering', async () => {
    const g = await makeGrave();
    nearUsd = 2.45;   // $0.01 is now ~0.004082 NEAR; 0.004 is within 3%
    ok(await svc.createOffering({ graveId: g.id, item: 'candle', amount: '0.004' }, '8.8.8.8', 3000));
    nearUsd = 2.0;    // $0.01 is now 0.005 NEAR; 0.004 is 20% short
    expect(await svc.createOffering({ graveId: g.id, item: 'rug', amount: '0.004' }, '8.8.8.9', 3000)).toMatchObject({ code: 'amount_too_low' });
  });

  it('formats NEAR amounts', () => {
    expect(trimNear(4n * NEAR / 1000n)).toBe('0.004');
    expect(trimNear(NEAR)).toBe('1');
  });
});

describe('offerings', () => {
  it('validates the grave, item and amount (minimum $0.01 in NEAR)', async () => {
    const g = await makeGrave();
    const o = (over: Record<string, unknown>) => svc.createOffering({ graveId: g.id, item: 'candle', amount: '0.01', ...over }, '5.5.5.5', 3000);
    expect(await o({ graveId: 99 })).toMatchObject({ code: 'not_found' });
    expect(await o({ item: 'lambo' })).toMatchObject({ code: 'bad_item' });
    expect(await o({ amount: '0.003' })).toMatchObject({ code: 'amount_too_low' });
    expect(await o({ amount: '0.0001234567' })).toMatchObject({ code: 'bad_amount' });   // more than 6 decimals
    expect(await o({ amount: 'lots' })).toMatchObject({ code: 'bad_amount' });
    expect(await o({ amount: 0.01 })).toMatchObject({ code: 'bad_amount' });
    const p = ok(await o({ amount: '0.0125', item: 'copium' })) as PaymentView;
    expect(p).toMatchObject({ kind: 'offering', status: 'pending', graveId: g.id, item: 'copium', plot: 1 });
    expect(baseOf(p.amount)).toBe(125n * NEAR / 10000n);
    // offerings never hold a plot
    expect(svc.snapshot().reserved).toEqual([]);
  });

  it('counts one per successful offering and queues one memorial per wallet per grave', async () => {
    const g = await makeGrave('alice.near');
    const first = await offer(g.id, 'bob.near');
    expect(first.status).toBe('fulfilled');
    expect(first.memorial).toMatchObject({ graveId: g.id, account: 'bob.near', status: 'pending', tokenId: null });
    expect(first.grave).toMatchObject({ offerings: 1, level: 1, recentItems: ['candle'], itemCounts: { candle: 1 } });
    await offer(g.id, 'bob.near', { item: 'rug', amount: '0.05' });
    await offer(g.id, 'carol.near', { item: 'flowers' });
    expect(queued).toBe(2);   // bob once, carol once
    expect(db.prepare('SELECT account_id FROM memorials ORDER BY account_id').all().map((r) => (r as { account_id: string }).account_id)).toEqual(['bob.near', 'carol.near']);
    const d = ok(svc.detail(g.id, 'bob.near')) as GraveDetail;
    expect(d).toMatchObject({ grave: { offerings: 3, recentItems: ['flowers', 'rug', 'candle'], itemCounts: { candle: 1, rug: 1, flowers: 1 } }, memorials: 2, myOfferings: 2, mine: { status: 'pending' } });
    expect(d.recent[0]).toMatchObject({ item: 'flowers', payer: 'carol.near' });
    expect(updates.map((u) => u.grave.offerings)).toEqual([1, 2, 3]);
  });

  it('the creator gets a memorial only by making an offering like anyone else', async () => {
    const g = await makeGrave('alice.near');
    expect((ok(svc.detail(g.id, 'alice.near')) as GraveDetail).mine).toBeNull();
    const p = await offer(g.id, 'alice.near');
    expect(p.memorial).toMatchObject({ account: 'alice.near', status: 'pending' });
  });

  it('never counts repeated confirmations, failed transactions or reused transactions', async () => {
    const g = await makeGrave();
    const p = ok(await svc.createOffering({ graveId: g.id, item: 'candle', amount: '0.01' }, '5.5.5.5', 3000)) as PaymentView;
    verifyResult = () => ({ status: 'invalid', reason: 'That transaction failed on NEAR.' });
    expect(ok(await svc.confirmPayment(p.id, H(900), 'bob.near', 3001))).toMatchObject({ status: 'pending', error: 'That transaction failed on NEAR.' });
    expect(svc.grave(g.id)!.offerings).toBe(0);
    verifyResult = (c) => ({ status: 'ok', payer: c.signerId, amount: c.amount });
    ok(await svc.confirmPayment(p.id, H(901), 'bob.near', 3002));
    ok(await svc.confirmPayment(p.id, H(901), 'bob.near', 3003));
    await svc.sweep(3004);
    expect(svc.grave(g.id)!.offerings).toBe(1);
    const p2 = ok(await svc.createOffering({ graveId: g.id, item: 'rug', amount: '0.01' }, '5.5.5.5', 3005)) as PaymentView;
    expect(await svc.confirmPayment(p2.id, H(901), 'bob.near', 3006)).toMatchObject({ code: 'tx_used' });
    expect(svc.grave(g.id)!.offerings).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM offerings').get()).toMatchObject({ n: 1 });
  });

  it('the NFT goes to the wallet that actually paid (verified signer)', async () => {
    const g = await makeGrave();
    verifyResult = (c) => ({ status: 'ok', payer: 'realpayer.near', amount: c.amount });
    const p = await offer(g.id, 'realpayer.near');
    expect(p.memorial?.account).toBe('realpayer.near');
  });

  it('resumes the same open offering and limits open offerings per visitor', async () => {
    const g = await makeGrave();
    const a = ok(await svc.createOffering({ graveId: g.id, item: 'candle', amount: '0.01' }, '5.5.5.5', 3000)) as PaymentView;
    const b = ok(await svc.createOffering({ graveId: g.id, item: 'candle', amount: '0.01' }, '5.5.5.5', 3000)) as PaymentView;
    expect(b.id).toBe(a.id);
    ok(await svc.createOffering({ graveId: g.id, item: 'rug', amount: '0.01' }, '5.5.5.5', 3000));
    ok(await svc.createOffering({ graveId: g.id, item: 'diamond', amount: '0.01' }, '5.5.5.5', 3000));
    expect(await svc.createOffering({ graveId: g.id, item: 'noodles', amount: '0.01' }, '5.5.5.5', 3000)).toMatchObject({ code: 'too_many_open' });
    svc.cancelPayment(a.id, 3100);
    ok(await svc.createOffering({ graveId: g.id, item: 'noodles', amount: '0.01' }, '5.5.5.5', 3200));
  });

  it('reaches the memorial levels at 10, 100 and 1000 offerings', async () => {
    expect([0, 1, 9, 10, 99, 100, 999, 1000, 5000].map(levelFor)).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect([0, 9, 10, 999, 1000].map(nextLevelIn)).toEqual([10, 1, 90, 1, null]);
    const g = await makeGrave();
    for (let i = 0; i < 10; i++) await offer(g.id, `w${i}.near`, {}, `10.0.0.${i}`);
    expect(svc.grave(g.id)).toMatchObject({ offerings: 10, level: 2 });
    expect(updates.map((u) => u.offering.levelUp)).toEqual([false, false, false, false, false, false, false, false, false, true]);
  });
});

describe('memorial minting', () => {
  class FakeChain implements MemorialChain {
    minted = new Map<string, string>();
    counts = new Map<number, number>();
    calls: { graveId: number; receiver: string; namePrefix: string }[] = [];
    failNext = 0;
    landButFail = false;
    async minterOf() { return 'minter.test'; }
    async memorialOf(graveId: number, account: string) { return this.minted.get(`${graveId}:${account}`) ?? null; }
    async mint(a: { graveId: number; receiver: string; namePrefix: string; description: string }) {
      this.calls.push(a);
      if (this.failNext > 0) { this.failNext--; throw new Error('RPC timeout'); }
      if (this.minted.has(`${a.graveId}:${a.receiver}`)) throw new Error('Smart contract panicked: This account already has a memorial for this grave');
      const serial = (this.counts.get(a.graveId) ?? 0) + 1;
      this.counts.set(a.graveId, serial);
      const tokenId = `${a.graveId}-${serial}`;
      this.minted.set(`${a.graveId}:${a.receiver}`, tokenId);
      if (this.landButFail) { this.landButFail = false; throw new Error('timeout waiting for the transaction'); }
      return { tokenId, txHash: 'MINTTX' };
    }
  }

  it('mints queued memorials once, with the grave ticker in the name', async () => {
    const chain = new FakeChain();
    const minter = new MemorialMinter({ db, log: silentLogger, graves: svc, chain, minterId: 'minter.test' });
    const g = await makeGrave();
    await offer(g.id, 'bob.near');
    await offer(g.id, 'bob.near');
    await offer(g.id, 'carol.near');
    await minter.run(10_000);
    expect(chain.calls.map((c) => [c.receiver, c.namePrefix])).toEqual([['bob.near', '$DOGSHIT'], ['carol.near', '$DOGSHIT']]);
    expect(svc.memorial(g.id, 'bob.near')).toMatchObject({ status: 'minted', tokenId: `${g.id}-1`, serial: 1, error: null });
    expect(svc.memorial(g.id, 'carol.near')).toMatchObject({ status: 'minted', tokenId: `${g.id}-2`, serial: 2 });
    await minter.run(20_000);
    expect(chain.calls).toHaveLength(2);
    expect(svc.memorialByToken(`${g.id}-1`)).toMatchObject({ personalOfferings: 2, memorial: { account_id: 'bob.near' } });
  });

  it('retries with backoff, and recovers when a mint landed but the reply was lost', async () => {
    const chain = new FakeChain();
    const minter = new MemorialMinter({ db, log: silentLogger, graves: svc, chain, minterId: 'minter.test' });
    const g = await makeGrave();
    await offer(g.id, 'bob.near');
    chain.failNext = 1;
    await minter.run(10_000);
    expect(svc.memorial(g.id, 'bob.near')).toMatchObject({ status: 'pending', error: 'Minting is being retried.' });
    await minter.run(10_001);   // not due yet
    expect(chain.calls).toHaveLength(1);
    chain.landButFail = true;
    await minter.run(10_000 + 31_000);
    expect(svc.memorial(g.id, 'bob.near')!.status).toBe('pending');
    await minter.run(10_000 + 31_000 + 61_000);   // memorial_of finds it: no second mint
    expect(chain.calls).toHaveLength(2);
    expect(svc.memorial(g.id, 'bob.near')).toMatchObject({ status: 'minted', tokenId: `${g.id}-1` });
  });

  it('does not mint when the contract names a different minter', async () => {
    const chain = new FakeChain();
    chain.minterOf = async () => 'someone-else.near';
    const minter = new MemorialMinter({ db, log: silentLogger, graves: svc, chain, minterId: 'minter.test' });
    const g = await makeGrave();
    await offer(g.id, 'bob.near');
    await minter.run(10_000);
    expect(chain.calls).toHaveLength(0);
    expect(svc.memorial(g.id, 'bob.near')!.status).toBe('pending');
  });

  it('names and describes memorials safely', () => {
    expect(describeMemorial('$RUG', 'rug.near', 7).namePrefix).toBe('$RUG');
    expect(describeMemorial('‮RUG\u0000', 'rug.near', 7).namePrefix).toBe('$RUG');
    expect(describeMemorial('', 'rug.near', 7).namePrefix).toBe('$MEME');
    expect(describeMemorial('X'.repeat(200), 'a'.repeat(64), 40).description.length).toBeLessThanOrEqual(1000);
  });
});

describe('memorial artwork', () => {
  const grave = (offerings: number, over: Partial<GraveInfo['meme']> = {}): GraveInfo => ({
    id: 3, plot: 3, message: 'm', creator: 'a.near', createdAt: 0, offerings, level: levelFor(offerings), recentItems: [], itemCounts: {},
    meme: { chain: 'near', contract: 'rug.near', name: 'Rug', symbol: 'RUG', decimals: 18, icon: null, ...over },
  });

  it('changes with the level and shows ticker and count', () => {
    const arts = [0, 10, 100, 1000].map((n) => memorialSvg(grave(n)));
    expect(new Set(arts).size).toBe(4);
    expect(arts[0]).toContain('LEVEL 1 · FORGOTTEN GRAVE');
    expect(arts[3]).toContain('LEVEL 4 · LEGENDARY GRAVE');
    expect(arts[2]).toContain('$RUG');
    expect(arts[2]).toContain('100 OFFERINGS');
    expect(arts[3]).toContain('MAX LEVEL');
  });

  it('escapes meme metadata and only embeds image data URIs', () => {
    const svg = memorialSvg(grave(5, { symbol: '<script>alert(1)</script>', icon: 'javascript:alert(1)' }));
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('javascript:');
    const withIcon = memorialSvg(grave(5, { icon: 'data:image/png;base64,AAAA"/><script>' }));
    expect(withIcon).not.toContain('"/><script>');
  });
});

describe('database migration', () => {
  it('upgrades a version-1 database and keeps existing graves', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'rip-mig-'));
    const file = path.join(dir, 'v1.sqlite');
    try {
      const v1 = new DatabaseSync(file);
      v1.exec(`
        CREATE TABLE payments (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('grave')), status TEXT NOT NULL, amount TEXT NOT NULL,
          plot INTEGER NOT NULL, chain TEXT NOT NULL, contract TEXT NOT NULL, tier INTEGER NOT NULL, message TEXT NOT NULL, meme_json TEXT NOT NULL,
          tx_hash TEXT UNIQUE, payer TEXT, error TEXT, client_ip TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE graves (id INTEGER PRIMARY KEY AUTOINCREMENT, plot INTEGER NOT NULL UNIQUE, chain TEXT NOT NULL, contract TEXT NOT NULL,
          tier INTEGER NOT NULL, name TEXT NOT NULL, symbol TEXT NOT NULL, decimals INTEGER, icon TEXT, message TEXT NOT NULL, creator TEXT NOT NULL,
          payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id), created_at INTEGER NOT NULL, UNIQUE (chain, contract));
        INSERT INTO payments VALUES ('p1','grave','fulfilled','1',3,'near','x.near',2,'hi','{}','tx1','a.near',NULL,NULL,1,2,3);
        INSERT INTO graves (plot,chain,contract,tier,name,symbol,message,creator,payment_id,created_at) VALUES (3,'near','x.near',2,'X','X','hi','a.near','p1',1);
        PRAGMA user_version = 1;`);
      v1.close();
      const v2 = openDb(file);
      expect(v2.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
      expect(v2.prepare('SELECT plot, offering_count FROM graves').all()).toMatchObject([{ plot: 3, offering_count: 0 }]);
      expect(v2.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
      expect(v2.prepare("SELECT kind FROM payments WHERE id = 'p1'").get()).toMatchObject({ kind: 'grave' });
      v2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
