import { describe, expect, it, beforeEach } from 'vitest';
import { openDb } from '../src/db.ts';
import { GraveService, memoFor, parseTierPrices } from '../src/graves.ts';
import { toUnits, type MetadataResult, type TransferCheck, type TransferResult } from '../src/near.ts';
import { silentLogger } from '../src/log.ts';
import type { GraveInfo, PaymentView } from '../../shared/graves.ts';

const TOKEN = 'wth-0b2227.launchpad.justhoot.near', TREASURY = 'whatthehoot.near';
const META: Record<string, MetadataResult> = {
  'dogshit.near': { ok: true, meta: { name: 'Dog Shit', symbol: 'DOGSHIT', decimals: 18, icon: 'data:image/png;base64,AAAA' } },
  'rug.near': { ok: true, meta: { name: 'Rug', symbol: 'RUG', decimals: 24, icon: null } },
  'nothing.near': { ok: false, code: 'not_found', message: 'No NEAR account with that address.' },
};

let verifyResult: (c: TransferCheck) => TransferResult;
let svc: GraveService;
let added: GraveInfo[];
const H = (n: number) => 'H'.repeat(43) + String(n % 10).replace('0', 'a');   // valid-looking tx hashes

beforeEach(() => {
  added = [];
  verifyResult = (c) => ({ status: 'ok', payer: c.signerId, amount: c.minAmount });
  const prices = parseTierPrices('75000,370000,740000,3700000', 18, toUnits);
  svc = new GraveService({
    db: openDb(':memory:'), log: silentLogger, token: TOKEN, receiver: TREASURY, decimals: 18,
    tierUnits: prices.units, tierWhole: prices.whole, holdMinutes: 15,
    lookupNear: async (c) => META[c] ?? { ok: false, code: 'not_token', message: 'nope' },
    verify: async (c) => verifyResult(c),
    onGraveAdded: (g) => added.push(g),
  });
});

const create = (over: Record<string, unknown> = {}, ip = '1.1.1.1', now = 1000) =>
  svc.createPayment({ plot: 1, chain: 'near', contract: 'dogshit.near', tier: 2, message: 'gone too soon', ...over }, ip, now);
const ok = <T,>(v: T | { code: string }): T => { if (v && typeof v === 'object' && 'code' in v && 'status' in (v as object)) throw new Error(JSON.stringify(v)); return v as T; };

describe('GraveService', () => {
  it('creates a hold with the exact transfer to make', async () => {
    const p = ok(await create()) as PaymentView;
    expect(p.status).toBe('pending');
    expect(p.amount).toBe((370000n * 10n ** 18n).toString());
    expect(p.memo).toBe(memoFor(p.id));
    expect(p.receiver).toBe(TREASURY);
    expect(p.meme).toMatchObject({ name: 'Dog Shit', symbol: 'DOGSHIT', icon: 'data:image/png;base64,AAAA' });
    expect(svc.snapshot().reserved).toEqual([1]);
  });

  it('validates input', async () => {
    expect(await create({ plot: 41 })).toMatchObject({ code: 'bad_plot' });
    expect(await create({ tier: 5 })).toMatchObject({ code: 'bad_tier' });
    expect(await create({ message: 'x'.repeat(101) })).toMatchObject({ code: 'bad_message' });
    expect(await create({ message: '   ' })).toMatchObject({ code: 'bad_message' });
    expect(await create({ chain: 'solana' })).toMatchObject({ code: 'chain_unsupported' });
    expect(await create({ contract: 'NOT VALID!!' })).toMatchObject({ code: 'bad_contract' });
    expect(await create({ contract: 'nothing.near' })).toMatchObject({ code: 'not_found' });
  });

  it('holds the plot and the meme against other buyers', async () => {
    ok(await create());
    expect(await create({ contract: 'rug.near' }, '2.2.2.2')).toMatchObject({ code: 'plot_reserved' });
    expect(await create({ plot: 2 }, '2.2.2.2')).toMatchObject({ code: 'being_buried' });
  });

  it('returns the same hold when the same player asks again', async () => {
    const a = ok(await create()) as PaymentView, b = ok(await create()) as PaymentView;
    expect(b.id).toBe(a.id);
  });

  it('confirms a verified payment into a grave, exactly once', async () => {
    const p = ok(await create()) as PaymentView;
    const done = ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 2000)) as PaymentView;
    expect(done.status).toBe('fulfilled');
    expect(done.grave).toMatchObject({ plot: 1, tier: 2, creator: 'alice.near', message: 'gone too soon', meme: { contract: 'dogshit.near' } });
    expect(added).toHaveLength(1);
    // retries with the same tx are idempotent
    const again = ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 3000)) as PaymentView;
    expect(again.status).toBe('fulfilled');
    expect(svc.snapshot().graves).toHaveLength(1);
    expect(added).toHaveLength(1);
    // a different tx for the same payment is refused
    expect(await svc.confirmPayment(p.id, H(2), 'alice.near', 3000)).toMatchObject({ code: 'already_confirmed' });
  });

  it('never buries the same meme twice and never reuses a plot', async () => {
    const p = ok(await create()) as PaymentView;
    ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 2000));
    expect(await create({ plot: 2 }, '2.2.2.2')).toMatchObject({ code: 'already_buried' });
    expect(await create({ contract: 'rug.near' }, '2.2.2.2')).toMatchObject({ code: 'plot_taken' });
    const lookup = await svc.lookup('near', 'dogshit.near');
    expect(lookup).toMatchObject({ grave: { plot: 1 } });
  });

  it('refuses a transaction already used for another grave', async () => {
    const a = ok(await create()) as PaymentView;
    ok(await svc.confirmPayment(a.id, H(1), 'alice.near', 2000));
    const b = ok(await create({ plot: 2, contract: 'rug.near' }, '3.3.3.3')) as PaymentView;
    expect(await svc.confirmPayment(b.id, H(1), 'alice.near', 2500)).toMatchObject({ code: 'tx_used' });
  });

  it('keeps the hold while NEAR has not finalised the transaction, then completes in the background', async () => {
    verifyResult = () => ({ status: 'pending' });
    const p = ok(await create()) as PaymentView;
    const v = ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 2000)) as PaymentView;
    expect(v.status).toBe('confirming');
    expect(svc.snapshot().reserved).toEqual([1]);
    verifyResult = (c) => ({ status: 'ok', payer: c.signerId, amount: c.minAmount });
    await svc.sweep(5000);
    expect((svc.getPayment(p.id) as PaymentView).status).toBe('fulfilled');
  });

  it('lets the player retry after a wrong or underpaid transaction', async () => {
    verifyResult = () => ({ status: 'invalid', reason: 'The amount sent is less than the price.' });
    const p = ok(await create()) as PaymentView;
    const v = ok(await svc.confirmPayment(p.id, H(1), 'alice.near', 2000)) as PaymentView;
    expect(v).toMatchObject({ status: 'pending', txHash: null, error: 'The amount sent is less than the price.' });
    verifyResult = (c) => ({ status: 'ok', payer: c.signerId, amount: c.minAmount });
    expect((ok(await svc.confirmPayment(p.id, H(2), 'alice.near', 2500)) as PaymentView).status).toBe('fulfilled');
  });

  it('expires unpaid holds', async () => {
    const p = ok(await create({}, '1.1.1.1', 0));
    await svc.sweep(16 * 60_000);
    expect((svc.getPayment((p as PaymentView).id) as PaymentView).status).toBe('expired');
    expect(svc.snapshot().reserved).toEqual([]);
    ok(await create({ contract: 'rug.near' }, '2.2.2.2', 16 * 60_000));
  });

  it('accepts a late payment if the grave is still free, and flags it for refund if not', async () => {
    const late = ok(await create({}, '1.1.1.1', 0)) as PaymentView;
    await svc.sweep(16 * 60_000);
    const done = ok(await svc.confirmPayment(late.id, H(1), 'alice.near', 17 * 60_000)) as PaymentView;
    expect(done.status).toBe('fulfilled');

    const p2 = ok(await create({ plot: 5, contract: 'rug.near' }, '1.1.1.1', 0)) as PaymentView;
    await svc.sweep(16 * 60_000);
    const winner = ok(await create({ plot: 5, contract: 'rug.near' }, '9.9.9.9', 16 * 60_000)) as PaymentView;
    ok(await svc.confirmPayment(winner.id, H(2), 'bob.near', 16 * 60_000 + 1));
    const loser = ok(await svc.confirmPayment(p2.id, H(3), 'carol.near', 17 * 60_000)) as PaymentView;
    expect(loser.status).toBe('unfulfillable');
    expect(loser.error).toMatch(/taken|buried/);
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
