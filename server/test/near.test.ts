import { describe, expect, it } from 'vitest';
import { fetchFtMetadata, toUnits, verifyFtTransfer, RpcError, type NearRpc } from '../src/near.ts';

const TOKEN = 'wth-0b2227.launchpad.justhoot.near', TREASURY = 'whatthehoot.near';
const HASH = '9FtHUFBQsZ2MG77K3x3MJ9wjX3UT8zE1TczCrhZEcG8U';

/** A tx status in the shape NEAR RPC returns for a successful ft_transfer (EXPERIMENTAL_tx_status). */
function txStatus(over: { signer?: string; amount?: string; memo?: string; receiver?: string; executor?: string; fail?: boolean; final?: string } = {}) {
  const event = { standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [{
    old_owner_id: over.signer ?? 'alice.near', new_owner_id: over.receiver ?? TREASURY, amount: over.amount ?? '370000000000000000000000', memo: over.memo ?? 'rip:abc',
  }] };
  return {
    final_execution_status: over.final ?? 'FINAL',
    status: over.fail ? { Failure: { ActionError: {} } } : { SuccessValue: '' },
    transaction: { signer_id: over.signer ?? 'alice.near', hash: HASH, receiver_id: TOKEN },
    receipts_outcome: [
      { outcome: { executor_id: over.executor ?? TOKEN, logs: [`EVENT_JSON:${JSON.stringify(event)}`], status: { SuccessValue: '' } } },
      { outcome: { executor_id: 'alice.near', logs: [], status: { SuccessValue: '' } } },
    ],
  };
}
const rpcReturning = (result: unknown): NearRpc => ({ call: async () => result as never });
const rpcThrowing = (e: Error): NearRpc => ({ call: async () => { throw e; } });
const check = { txHash: HASH, signerId: 'alice.near', token: TOKEN, receiver: TREASURY, memo: 'rip:abc', minAmount: 370000n * 10n ** 18n };

describe('verifyFtTransfer', () => {
  it('accepts a matching, final, successful transfer', async () => {
    expect(await verifyFtTransfer(rpcReturning(txStatus()), check)).toEqual({ status: 'ok', payer: 'alice.near', amount: 370000n * 10n ** 18n });
  });
  it('rejects wrong amount, memo, receiver, token, signer or a failed tx', async () => {
    expect(await verifyFtTransfer(rpcReturning(txStatus({ amount: '1' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyFtTransfer(rpcReturning(txStatus({ memo: 'rip:other' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyFtTransfer(rpcReturning(txStatus({ receiver: 'thief.near' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyFtTransfer(rpcReturning(txStatus({ executor: 'fake-wth.near' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyFtTransfer(rpcReturning(txStatus({ signer: 'mallory.near' })), check)).toMatchObject({ status: 'invalid' });
    expect(await verifyFtTransfer(rpcReturning(txStatus({ fail: true })), check)).toMatchObject({ status: 'invalid' });
  });
  it('waits (pending) when the tx is not final, not visible yet, or the RPC is down', async () => {
    expect(await verifyFtTransfer(rpcReturning(txStatus({ final: 'EXECUTED_OPTIMISTIC' })), check)).toEqual({ status: 'pending' });
    expect(await verifyFtTransfer(rpcThrowing(new RpcError('Server error', 'TIMEOUT_ERROR')), check)).toEqual({ status: 'pending' });
    expect(await verifyFtTransfer(rpcThrowing(new RpcError('Server error', 'UNKNOWN_TRANSACTION')), check)).toEqual({ status: 'pending' });
    expect(await verifyFtTransfer(rpcThrowing(new Error('ECONNRESET')), check)).toEqual({ status: 'pending' });
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
