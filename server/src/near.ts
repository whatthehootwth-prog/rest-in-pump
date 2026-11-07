/**
 * NEAR mainnet access over public JSON-RPC: reading token metadata and verifying WTH payments.
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

// ------------------------------------------------------------------ payment verification

export interface TransferCheck {
  txHash: string;
  signerId: string;
  token: string;
  receiver: string;
  memo: string;
  minAmount: bigint;
}

export type TransferResult =
  | { status: 'ok'; payer: string; amount: bigint }
  | { status: 'pending' }                       // not final yet / not visible yet: check again shortly
  | { status: 'invalid'; reason: string };      // final, and it is not a valid payment for this order

interface TxStatus {
  final_execution_status?: string;
  status?: Record<string, unknown>;
  transaction?: { signer_id?: string; hash?: string };
  receipts_outcome?: Array<{ outcome?: { executor_id?: string; logs?: string[]; status?: Record<string, unknown> } }>;
}

const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const isTxHash = (v: unknown): v is string => typeof v === 'string' && TX_HASH_RE.test(v);

/**
 * Verifies on-chain that `signerId` sent at least `minAmount` of `token` to `receiver` with exactly `memo`,
 * using the NEP-141 ft_transfer event emitted by the token contract in a successful receipt.
 */
export async function verifyFtTransfer(rpc: NearRpc, c: TransferCheck): Promise<TransferResult> {
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

  for (const r of tx.receipts_outcome ?? []) {
    const o = r.outcome;
    if (!o || o.executor_id !== c.token) continue;
    if (!o.status || !('SuccessValue' in o.status || 'SuccessReceiptId' in o.status)) continue;
    for (const log of o.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      let ev: { standard?: string; event?: string; data?: Array<Record<string, unknown>> };
      try { ev = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (ev.standard !== 'nep141' || ev.event !== 'ft_transfer' || !Array.isArray(ev.data)) continue;
      for (const d of ev.data) {
        if (d.old_owner_id !== c.signerId || d.new_owner_id !== c.receiver || d.memo !== c.memo) continue;
        let amount: bigint;
        try { amount = BigInt(String(d.amount)); } catch { continue; }
        if (amount < c.minAmount) return { status: 'invalid', reason: 'The amount sent is less than the price.' };
        return { status: 'ok', payer: c.signerId, amount };
      }
    }
  }
  return { status: 'invalid', reason: 'No matching WTH transfer to the treasury was found in that transaction.' };
}

/** Whole-token decimal string (e.g. "75000" or "12.5") -> smallest unit. */
export function toUnits(whole: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(whole)) throw new Error(`bad amount "${whole}"`);
  const [i, f = ''] = whole.split('.');
  if (f.length > decimals) throw new Error(`too many decimals in "${whole}"`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}
