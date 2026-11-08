/**
 * NEAR mainnet access over public JSON-RPC: reading token metadata and balances, and verifying NEAR payments.
 * Several RPC endpoints are tried in order so one provider being down does not stop the game.
 */

export interface NearRpc {
  call<T = unknown>(method: string, params: unknown): Promise<T>;
}

export class RpcError extends Error {
  readonly cause_name: string | undefined;
  readonly data: unknown;
  constructor(message: string, causeName?: string, data?: unknown) {
    super(message);
    this.cause_name = causeName;
    this.data = data;
  }
}

export function createNearRpc(urls: string[], timeoutMs = 10000): NearRpc {
  return {
    async call<T>(method: string, params: unknown): Promise<T> {
      let lastErr: unknown = null;
      for (const url of urls) {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 'rip', method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (res.status >= 500 || res.status === 429) { lastErr = new Error(`${url} HTTP ${res.status}`); continue; }
          const body = (await res.json()) as { result?: T; error?: { message?: string; cause?: { name?: string }; data?: unknown } };
          if (body.error) {
            // a definite answer from the chain (unknown account, unknown tx...) — don't try other providers
            throw new RpcError(body.error.message ?? 'RPC error', body.error.cause?.name, body.error.data);
          }
          return body.result as T;
        } catch (err) {
          if (err instanceof RpcError) throw err;
          lastErr = err;
        }
      }
      throw new Error(`all NEAR RPC endpoints failed: ${(lastErr as Error)?.message ?? 'unknown'}`);
    },
  };
}

/** Calls a view method. Returns { error } for contract-level failures (method missing, panic). */
export async function viewFunction(rpc: NearRpc, account: string, method: string, args: object = {}): Promise<{ value: unknown } | { error: string }> {
  const res = await rpc.call<{ result?: number[]; error?: string }>('query', {
    request_type: 'call_function', finality: 'final', account_id: account, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  if (res.error) return { error: res.error };
  try {
    return { value: JSON.parse(Buffer.from(res.result ?? []).toString('utf8')) };
  } catch {
    return { error: 'unreadable result' };
  }
}

// ------------------------------------------------------------------ token metadata

export interface FtMetadata { name: string; symbol: string; decimals: number | null; icon: string | null }
export type MetadataResult =
  | { ok: true; meta: FtMetadata }
  | { ok: false; code: 'not_found' | 'not_token' | 'unavailable'; message: string };

const ICON_RE = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml)(;base64)?,/i;
const MAX_ICON_CHARS = 300_000;
const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Reads NEP-141 metadata (name, symbol, logo) straight from the token contract. */
export async function fetchFtMetadata(rpc: NearRpc, contract: string): Promise<MetadataResult> {
  let res: { value: unknown } | { error: string };
  try {
    res = await viewFunction(rpc, contract, 'ft_metadata');
  } catch (err) {
    if (err instanceof RpcError) {
      const c = err.cause_name ?? '';
      if (c === 'UNKNOWN_ACCOUNT') return { ok: false, code: 'not_found', message: 'No NEAR account with that address.' };
      if (c === 'NO_CONTRACT_CODE') return { ok: false, code: 'not_token', message: 'That account has no contract, so it is not a token.' };
      if (/MethodNotFound|CodeDoesNotExist/i.test(err.message + JSON.stringify(err.data ?? ''))) {
        return { ok: false, code: 'not_token', message: 'That contract is not a NEAR token (no ft_metadata).' };
      }
    }
    return { ok: false, code: 'unavailable', message: 'Could not reach NEAR right now. Try again in a moment.' };
  }
  if ('error' in res) {
    if (/MethodNotFound|CodeDoesNotExist|MethodResolveError/i.test(res.error)) {
      return { ok: false, code: 'not_token', message: 'That contract is not a NEAR token (no ft_metadata).' };
    }
    return { ok: false, code: 'not_token', message: 'That contract did not return token metadata.' };
  }
  const m = res.value as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return { ok: false, code: 'not_token', message: 'That contract did not return token metadata.' };
  const name = clean(m.name, 64), symbol = clean(m.symbol, 24);
  if (!name && !symbol) return { ok: false, code: 'not_token', message: 'That token has no name or symbol.' };
  const icon = typeof m.icon === 'string' && ICON_RE.test(m.icon) && m.icon.length <= MAX_ICON_CHARS ? m.icon : null;
  const decimals = Number.isInteger(m.decimals) && (m.decimals as number) >= 0 && (m.decimals as number) <= 40 ? (m.decimals as number) : null;
  return { ok: true, meta: { name: name || symbol, symbol: symbol || name, decimals, icon } };
}

// ------------------------------------------------------------------ payment verification (native NEAR)

export interface TransferCheck {
  txHash: string;
  signerId: string;
  receiver: string;
  /** Exact yoctoNEAR amount of this order. Each open order has a unique amount, which is how a transfer is matched to it. */
  amount: bigint;
  /** The transfer must be in a block at or after this time (ms): an older transfer can't pay a newer order. */
  notBefore: number;
}

export type TransferResult =
  | { status: 'ok'; payer: string; amount: bigint }
  | { status: 'pending' }                       // not final yet / not visible yet: check again shortly
  | { status: 'invalid'; reason: string };      // final, and it is not a valid payment for this order

interface TxStatus {
  final_execution_status?: string;
  status?: Record<string, unknown>;
  transaction?: { signer_id?: string; receiver_id?: string; hash?: string; actions?: unknown[] };
  transaction_outcome?: { block_hash?: string };
  receipts_outcome?: Array<{ outcome?: { executor_id?: string; status?: Record<string, unknown> } }>;
}

const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const isTxHash = (v: unknown): v is string => typeof v === 'string' && TX_HASH_RE.test(v);
/** Clock skew allowed between our server and NEAR block time. */
const SKEW_MS = 2 * 60_000;

/** The deposit of a plain Transfer action in an RPC transaction, or null. */
function transferDeposit(action: unknown): bigint | null {
  if (!action || typeof action !== 'object') return null;
  const t = (action as { Transfer?: { deposit?: unknown } }).Transfer;
  if (!t || typeof t.deposit !== 'string' || !/^\d+$/.test(t.deposit)) return null;
  return BigInt(t.deposit);
}

/**
 * Verifies on-chain that `signerId` sent exactly `amount` yoctoNEAR to `receiver` in a plain transfer, that the
 * transaction is final and successful, and that it happened after the order was created.
 */
export async function verifyNearTransfer(rpc: NearRpc, c: TransferCheck): Promise<TransferResult> {
  let tx: TxStatus;
  try {
    tx = await rpc.call<TxStatus>('EXPERIMENTAL_tx_status', { tx_hash: c.txHash, sender_account_id: c.signerId, wait_until: 'FINAL' });
  } catch (err) {
    if (err instanceof RpcError && /UNKNOWN_TRANSACTION|TIMEOUT_ERROR/.test(err.cause_name ?? '')) return { status: 'pending' };
    if (err instanceof RpcError && (err.cause_name === 'INVALID_TRANSACTION' || err.cause_name === 'PARSE_ERROR')) {
      return { status: 'invalid', reason: 'That transaction hash is not valid.' };
    }
    return { status: 'pending' };   // RPC trouble: retry later, never fail a payment because a provider hiccuped
  }
  if (tx.final_execution_status && tx.final_execution_status !== 'FINAL') return { status: 'pending' };
  if (!tx.status || 'Failure' in tx.status) return { status: 'invalid', reason: 'The transaction failed on NEAR.' };
  if (tx.transaction?.signer_id !== c.signerId) return { status: 'invalid', reason: 'The transaction was signed by a different account.' };
  if (tx.transaction?.receiver_id !== c.receiver) return { status: 'invalid', reason: 'That transaction did not send NEAR to the treasury.' };
  const deposits = (tx.transaction.actions ?? []).map(transferDeposit).filter((d): d is bigint => d !== null);
  if (!deposits.length) return { status: 'invalid', reason: 'That transaction is not a NEAR transfer.' };
  if (!deposits.includes(c.amount)) return { status: 'invalid', reason: 'The amount sent does not match this order.' };
  // the transfer receipt on the treasury must have succeeded
  const landed = (tx.receipts_outcome ?? []).some((r) => r.outcome?.executor_id === c.receiver && r.outcome.status && ('SuccessValue' in r.outcome.status || 'SuccessReceiptId' in r.outcome.status));
  if (!landed) return { status: 'invalid', reason: 'The NEAR transfer did not complete.' };
  // and it must be newer than the order (blocks carry nanosecond timestamps)
  const blockHash = tx.transaction_outcome?.block_hash;
  if (!blockHash) return { status: 'pending' };
  let tsNs: bigint;
  try {
    const block = await rpc.call<{ header?: { timestamp_nanosec?: string; timestamp?: number } }>('block', { block_id: blockHash });
    const raw = block.header?.timestamp_nanosec ?? (block.header?.timestamp !== undefined ? String(block.header.timestamp) : null);
    if (!raw || !/^\d+$/.test(raw)) return { status: 'pending' };
    tsNs = BigInt(raw);
  } catch {
    return { status: 'pending' };
  }
  if (tsNs / 1_000_000n < BigInt(c.notBefore - SKEW_MS)) return { status: 'invalid', reason: 'That transfer was made before this order.' };
  return { status: 'ok', payer: c.signerId, amount: c.amount };
}

/** Spendable NEAR of an account in yoctoNEAR (balance minus what its storage locks), or null if unknown. */
export async function nearBalance(rpc: NearRpc, account: string): Promise<string | null> {
  try {
    const r = await rpc.call<{ amount?: string; storage_usage?: number }>('query', { request_type: 'view_account', finality: 'final', account_id: account });
    if (typeof r.amount !== 'string' || !/^\d+$/.test(r.amount)) return null;
    const locked = BigInt(r.storage_usage ?? 0) * 10n ** 19n;   // 1e19 yocto per byte of storage
    const free = BigInt(r.amount) - locked;
    return (free > 0n ? free : 0n).toString();
  } catch (err) {
    if (err instanceof RpcError && err.cause_name === 'UNKNOWN_ACCOUNT') return '0';
    return null;
  }
}

/** Whole-token decimal string (e.g. "75000" or "12.5") -> smallest unit. */
export function toUnits(whole: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(whole)) throw new Error(`bad amount "${whole}"`);
  const [i, f = ''] = whole.split('.');
  if (f.length > decimals) throw new Error(`too many decimals in "${whole}"`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}
