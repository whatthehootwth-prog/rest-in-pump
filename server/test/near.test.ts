import { describe, expect, it } from 'vitest';
import { fetchFtMetadata, nearBalance, toUnits, verifyNearTransfer, RpcError, type NearRpc } from '../src/near.ts';
import { createNearPrice, usdToYocto } from '../src/price.ts';

const TOKEN = 'wth-0b2227.launchpad.justhoot.near', TREASURY = 'whatthehoot.near';
const HASH = '9FtHUFBQsZ2MG77K3x3MJ9wjX3UT8zE1TczCrhZEcG8U';

/** A tx status in the shape NEAR RPC returns for a successful plain NEAR transfer (EXPERIMENTAL_tx_status). */
const AMOUNT = 4_000_000_000_000_123_000_000_000n;   // 0.004 NEAR + a unique tail
const CREATED = 1_794_000_000_000;                    // order created (ms)
function txStatus(over: { signer?: string; receiver?: string; deposit?: string; fail?: boolean; final?: string; actions?: unknown[]; landed?: boolean } = {}) {
  const receiver = over.receiver ?? TREASURY;
  return {
    final_execution_status: over.final ?? 'FINAL',
    status: over.fail ? { Failure: { ActionError: {} } } : { SuccessValue: '' },
    transaction: { signer_id: over.signer ?? 'alice.near', receiver_id: receiver, hash: HASH, actions: over.actions ?? [{ Transfer: { deposit: over.deposit ?? AMOUNT.toString() } }] },
    transaction_outcome: { block_hash: 'BLOCKHASH' },
    receipts_outcome: [{ outcome: { executor_id: over.landed === false ? 'someone.near' : receiver, status: { SuccessValue: '' } } }],
  };
}
/** RPC that answers tx status and the block (with a block time in ns). */
const rpcFor = (tx: unknown, blockMs = CREATED + 30_000): NearRpc => ({
  call: async (method: string) => (method === 'block' ? { header: { timestamp_nanosec: (BigInt(blockMs) * 1_000_000n).toString() } } : tx) as never,
});
const rpcThrowing = (e: Error): NearRpc => ({ call: async () => { throw e; } });
const rpcReturning = (result: unknown): NearRpc => ({ call: async () => result as never });
const check = { txHash: HASH, signerId: 'alice.near', receiver: TREASURY, amount: AMOUNT, notBefore: CREATED };

describe('verifyNearTransfer', () => {
  it('accepts a matching, final, successful transfer made after the order', async () => {
    expect(await verifyNearTransfer(rpcFor(txStatus()), check)).toEqual({ status: 'ok', payer: 'alice.near', amount: AMOUNT });
  });
  it('rejects a different amount (even a bigger one), receiver, signer, non-transfer, failed or older tx', async () => {
    expect(await verifyNearTransfer(rpcFor(txStatus({ deposit: (AMOUNT + 1n).toString() })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyNearTransfer(rpcFor(txStatus({ deposit: '1' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyNearTransfer(rpcFor(txStatus({ receiver: 'thief.near' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyNearTransfer(rpcFor(txStatus({ signer: 'mallory.near' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyNearTransfer(rpcFor(txStatus({ actions: [{ FunctionCall: { method_name: 'x', deposit: AMOUNT.toString() } }] })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyNearTransfer(rpcFor(txStatus({ fail: true })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyNearTransfer(rpcFor(txStatus({ landed: false })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyNearTransfer(rpcFor(txStatus(), CREATED - 10 * 60_000), check)).toMatchObject({ status: 'invalid', reason: 'That transfer was made before this order.' });
  });
  it('waits (pending) when the tx is not final, not visible yet, or the RPC is down', async () => {
    expect(await verifyNearTransfer(rpcFor(txStatus({ final: 'EXECUTED_OPTIMISTIC' })), check)).toEqual({ status: 'pending' });
    expect(await verifyNearTransfer(rpcThrowing(new RpcError('Server error', 'TIMEOUT_ERROR')), check)).toEqual({ status: 'pending' });
    expect(await verifyNearTransfer(rpcThrowing(new RpcError('Server error', 'UNKNOWN_TRANSACTION')), check)).toEqual({ status: 'pending' });
    expect(await verifyNearTransfer(rpcThrowing(new Error('ECONNRESET')), check)).toEqual({ status: 'pending' });
  });
});

describe('nearBalance', () => {
  it('returns spendable NEAR (balance minus storage)', async () => {
    expect(await nearBalance(rpcReturning({ amount: (2n * 10n ** 24n).toString(), storage_usage: 100 }), 'alice.near')).toBe((2n * 10n ** 24n - 100n * 10n ** 19n).toString());
    expect(await nearBalance(rpcThrowing(new RpcError('x', 'UNKNOWN_ACCOUNT')), 'nobody.near')).toBe('0');
    expect(await nearBalance(rpcThrowing(new Error('down')), 'alice.near')).toBeNull();
  });
});

describe('NEAR price', () => {
  it('turns USD into NEAR, rounded up to 0.000001 NEAR', () => {
    expect(usdToYocto('0.01', 2.5)).toBe(4n * 10n ** 21n);          // exactly 0.004 NEAR
    expect(usdToYocto('0.01', 3)).toBe(3_334n * 10n ** 18n);        // 0.003333.. -> 0.003334
    expect(() => usdToYocto('abc', 3)).toThrow();
  });
  it('uses the first source that answers, caches it, and reports null when nothing answers', async () => {
    let t = 0, calls = 0;
    const p = createNearPrice([async () => { throw new Error('down'); }, async () => { calls++; return 3.1; }], undefined, () => t);
    expect(await p.usd()).toBe(3.1);
    t += 30_000;
    expect(await p.usd()).toBe(3.1);
    expect(calls).toBe(1);   // cached
    const dead = createNearPrice([async () => { throw new Error('down'); }], undefined, () => t);
    expect(await dead.usd()).toBeNull();
  });
});

describe('fetchFtMetadata', () => {
  const viewResult = (value: unknown) => rpcReturning({ result: [...Buffer.from(JSON.stringify(value))] });
  it('reads name, symbol, decimals and a data: logo', async () => {
    const r = await fetchFtMetadata(viewResult({ spec: 'ft-1.0.0', name: 'WHAT THE HOOT', symbol: 'WTH', decimals: 18, icon: 'data:image/webp;base64,UklGR' }), TOKEN);
    expect(r).toEqual({ ok: true, meta: { name: 'WHAT THE HOOT', symbol: 'WTH', decimals: 18, icon: 'data:image/webp;base64,UklGR' } });
  });
  it('drops logos that are not safe inline images', async () => {
    const r = await fetchFtMetadata(viewResult({ name: 'X', symbol: 'X', decimals: 8, icon: 'https://evil.example/x.png' }), 'x.near');
    expect(r).toMatchObject({ ok: true, meta: { icon: null } });
  });
  it('maps chain errors to clear reasons (shapes taken from real mainnet responses)', async () => {
    expect(await fetchFtMetadata(rpcThrowing(new RpcError('Server error', 'UNKNOWN_ACCOUNT')), 'x.near')).toMatchObject({ ok: false, code: 'not_found' });
    expect(await fetchFtMetadata(rpcReturning({ error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "x.near" })' }), 'x.near'))
      .toMatchObject({ ok: false, code: 'not_token' });
    expect(await fetchFtMetadata(rpcReturning({ error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }), 'x.near'))
      .toMatchObject({ ok: false, code: 'not_token' });
    expect(await fetchFtMetadata(rpcThrowing(new Error('all NEAR RPC endpoints failed')), 'x.near')).toMatchObject({ ok: false, code: 'unavailable' });
  });
});

describe('toUnits', () => {
  it('converts whole tokens exactly', () => {
    expect(toUnits('75000', 18)).toBe(75000n * 10n ** 18n);
    expect(toUnits('1.5', 2)).toBe(150n);
    expect(() => toUnits('1.234', 2)).toThrow();
    expect(() => toUnits('-1', 18)).toThrow();
  });
});
