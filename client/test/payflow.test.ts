import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PaymentView } from '../../shared/graves.ts';

// PayFlow is browser code: give it the few browser globals it touches.
const saved = new Map<string, string>();
beforeAll(() => {
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, String(v)),
      removeItem: (k: string) => void saved.delete(k),
    },
    window: { setInterval: () => 1, clearInterval: () => {} },
    document: { getElementById: () => null },
  });
});

const { PayFlow } = await import('../src/ui/payflow.ts');
const { api } = await import('../src/net/api.ts');
const originals = { balance: api.balance, confirm: api.confirm };
afterEach(() => { Object.assign(api, originals); saved.clear(); });

const HASH = 'GvqXQ4g1Uo7Zt5hNCBxJmQyQvM2FQ3kD8n6tG5xKcRrA';
const order = (over: Partial<PaymentView> = {}) => ({
  id: 'order-1', kind: 'offering', status: 'pending', amount: '40000000000000000000000', receiver: 'whatthehoot.near',
  expiresAt: Date.now() + 60_000, txHash: null, error: null, ...over,
}) as PaymentView;
const host = { render() {}, isOpen: () => true, toast() {}, doneToast: () => '', close() {} };

describe('a sent transfer is never sent twice (audit S06)', () => {
  it('after a lost confirm and a reload, it confirms the saved transfer instead of opening the wallet again', async () => {
    const sent: unknown[] = [];
    const wallet = { account: 'alice.near', sendNear: async (tx: unknown) => { sent.push(tx); return HASH; } };
    api.balance = async () => ({ account: 'alice.near', balance: '100000000000000000000000000' });
    api.confirm = async () => { throw new Error('offline: never reached the server'); };
    const p = order();
    const a = new PayFlow(wallet as never, host, 'offering');
    await a.start(async () => p, () => true);
    expect(sent).toHaveLength(1);
    expect(a.state.s).toBe('error');
    // the hash was saved before the confirm request
    expect(JSON.parse(saved.get('rip.sentTx')!)).toEqual({ id: p.id, hash: HASH, account: 'alice.near' });

    // reload: the server still says pending (it never heard about the transfer)
    const confirms: string[] = [];
    api.confirm = async (_id, hash) => { confirms.push(hash); return order({ status: 'fulfilled', txHash: hash }); };
    const b = new PayFlow(wallet as never, host, 'offering');
    await b.resume(p, null);
    expect(confirms).toEqual([HASH]);
    expect(b.state.s).toBe('done');
    expect(sent).toHaveLength(1);   // no second transfer
    expect(saved.has('rip.sentTx')).toBe(false);
  });

  it('reopening the dialog for the same order also confirms instead of sending', async () => {
    const sent: unknown[] = [];
    const wallet = { account: 'alice.near', sendNear: async (tx: unknown) => { sent.push(tx); return HASH; } };
    api.balance = async () => ({ account: 'alice.near', balance: '100000000000000000000000000' });
    saved.set('rip.pendingPayment', 'order-1');
    saved.set('rip.sentTx', JSON.stringify({ id: 'order-1', hash: HASH, account: 'alice.near' }));
    api.confirm = async (_id, hash) => order({ status: 'fulfilled', txHash: hash });
    const f = new PayFlow(wallet as never, host, 'offering');
    await f.start(async () => order(), () => true);   // the server hands back the same open order
    expect(sent).toHaveLength(0);
    expect(f.state.s).toBe('done');
  });

  it('an unclear wallet error offers no instant retry, and a double click opens the wallet once', async () => {
    let calls = 0;
    let release!: () => void;
    const wallet = {
      account: 'alice.near',
      sendNear: async () => { calls++; await new Promise<void>((r) => { release = r; }); throw new Error('network glitch'); },
    };
    api.balance = async () => ({ account: 'alice.near', balance: '100000000000000000000000000' });
    const f = new PayFlow(wallet as never, host, 'offering');
    const one = f.start(async () => order(), () => true);
    const two = f.start(async () => order(), () => true);
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([one, two]);
    expect(calls).toBe(1);
    expect(f.state).toMatchObject({ s: 'error', retry: false });
  });
});
