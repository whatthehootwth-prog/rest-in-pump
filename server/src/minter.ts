import { Account } from '@near-js/accounts';
import { FailoverRpcProvider, JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import type { KeyPairString } from '@near-js/crypto';
import type { Db } from './db.ts';
import type { GraveService, MemorialRow } from './graves.ts';
import type { Logger } from './log.ts';
import { viewFunction, type NearRpc } from './near.ts';

/**
 * Mints queued Memorial NFTs on NEAR (memorials table, filled by GraveService on a wallet's first offering).
 *
 * Safe to retry at any point: before minting it asks the contract whether the wallet already has a memorial
 * for that grave, and the contract itself refuses a second one. Failures back off and retry; after
 * MAX_ATTEMPTS a memorial is marked failed (visible to the player, and logged loudly for the operator).
 */

export interface MemorialChain {
  /** The account the contract accepts mints from. */
  minterOf(): Promise<string>;
  /** Token id already minted to this wallet for this grave, or null. */
  memorialOf(graveId: number, account: string): Promise<string | null>;
  mint(args: { graveId: number; receiver: string; namePrefix: string; description: string }): Promise<{ tokenId: string; txHash: string | null }>;
}

interface MinterOptions {
  db: Db; log: Logger; graves: GraveService; chain: MemorialChain; minterId: string;
  onMinted?(graveId: number, account: string): void;
}

const MAX_ATTEMPTS = 10;
const BATCH = 5;
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** Math.max(attempt - 1, 0), 30 * 60_000);
const ALREADY = /already has a memorial/i;

export class MemorialMinter {
  private running = false;
  private again = false;
  private minterChecked = false;
  private readonly o: MinterOptions;
  constructor(o: MinterOptions) {
    this.o = o;
    // a mint interrupted by a restart is retried (the memorial_of check makes that safe)
    o.db.prepare("UPDATE memorials SET status = 'pending', next_attempt_at = 0 WHERE status = 'minting'").run();
  }

  /** Processes due memorials. Calls made while a run is in progress trigger one more run after it. */
  async run(now = Date.now()): Promise<void> {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        if (!(await this.checkMinter())) return;
        const due = this.o.db.prepare("SELECT * FROM memorials WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT ?")
          .all(now, BATCH) as unknown as MemorialRow[];
        for (const m of due) await this.mintOne(m, now);
        if (due.length === BATCH) this.again = true;
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  private async checkMinter(): Promise<boolean> {
    if (this.minterChecked) return true;
    try {
      const onChain = await this.o.chain.minterOf();
      if (onChain !== this.o.minterId) {
        this.o.log.error('Memorial NFT contract does not accept mints from MINTER_ACCOUNT_ID — not minting', { contractMinter: onChain, configured: this.o.minterId });
        return false;
      }
      this.minterChecked = true;
      return true;
    } catch (e) {
      this.o.log.warn('could not reach the Memorial NFT contract', { err: e });
      return false;
    }
  }

  private async mintOne(m: MemorialRow, now: number) {
    const db = this.o.db;
    const claimed = db.prepare("UPDATE memorials SET status = 'minting', attempts = attempts + 1, updated_at = ? WHERE grave_id = ? AND account_id = ? AND status = 'pending'")
      .run(now, m.grave_id, m.account_id);
    if (Number(claimed.changes) === 0) return;
    const attempt = m.attempts + 1;
    try {
      let tokenId = await this.o.chain.memorialOf(m.grave_id, m.account_id);
      let txHash: string | null = null;
      if (!tokenId) {
        const grave = this.o.graves.grave(m.grave_id);
        if (!grave) throw new Error('grave not found');
        try {
          ({ tokenId, txHash } = await this.o.chain.mint({ graveId: m.grave_id, receiver: m.account_id, ...describe(grave.meme.symbol, grave.meme.contract, grave.plot) }));
        } catch (e) {
          // a previous attempt landed after all
          if (!ALREADY.test(String((e as Error)?.message ?? e))) throw e;
          tokenId = await this.o.chain.memorialOf(m.grave_id, m.account_id);
          if (!tokenId) throw e;
        }
      }
      const serial = Number(tokenId.split('-')[1]);
      db.prepare("UPDATE memorials SET status = 'minted', token_id = ?, serial = ?, mint_tx = COALESCE(?, mint_tx), error = NULL, updated_at = ? WHERE grave_id = ? AND account_id = ?")
        .run(tokenId, Number.isInteger(serial) ? serial : null, txHash, Date.now(), m.grave_id, m.account_id);
      this.o.log.info('memorial minted', { grave: m.grave_id, account: m.account_id, token: tokenId, tx: txHash });
      this.o.onMinted?.(m.grave_id, m.account_id);
    } catch (e) {
      const message = String((e as Error)?.message ?? e).slice(0, 300);
      const giveUp = attempt >= MAX_ATTEMPTS;
      db.prepare('UPDATE memorials SET status = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE grave_id = ? AND account_id = ?')
        .run(giveUp ? 'failed' : 'pending', giveUp ? 'Minting failed after several tries. It is flagged in the server log for the team to retry.' : 'Minting is being retried.',
          now + backoffMs(attempt), Date.now(), m.grave_id, m.account_id);
      if (giveUp) this.o.log.error('MEMORIAL MINT FAILED — gave up, needs attention', { grave: m.grave_id, account: m.account_id, attempts: attempt, err: message });
      else this.o.log.warn('memorial mint failed, will retry', { grave: m.grave_id, account: m.account_id, attempt, err: message });
    }
  }
}

/** On-chain title prefix and description of a grave's memorials. */
export function describe(symbol: string, contract: string, plot: number): { namePrefix: string; description: string } {
  const ticker = symbol.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/^\$+/, '').trim().slice(0, 24) || 'MEME';
  return {
    namePrefix: `$${ticker}`,
    description: `A Memorial NFT for $${ticker} (${contract.slice(0, 64)}) at grave plot #${plot} in Rest In Pump. `
      + 'It was earned with a first offering to the grave, and its artwork evolves as the community keeps the memory alive.',
  };
}

/** The real chain: views over our RPC helper, mints signed with the minter key. */
export function nearMemorialChain(o: { rpc: NearRpc; rpcUrls: string[]; contract: string; minterId: string; privateKey: string }): MemorialChain {
  const provider = new FailoverRpcProvider(o.rpcUrls.map((url) => new JsonRpcProvider({ url })));
  const signer = KeyPairSigner.fromSecretKey(o.privateKey as KeyPairString);
  const account = new Account(o.minterId, provider, signer);
  const view = async (method: string, args: object) => {
    const r = await viewFunction(o.rpc, o.contract, method, args);
    if ('error' in r) throw new Error(`${method}: ${r.error}`);
    return r.value;
  };
  return {
    async minterOf() { return String(await view('get_minter', {})); },
    async memorialOf(graveId, account_id) {
      const v = await view('memorial_of', { grave_id: graveId, account_id });
      return typeof v === 'string' ? v : null;
    },
    async mint({ graveId, receiver, namePrefix, description }) {
      const outcome = await account.callFunctionRaw({
        contractId: o.contract, methodName: 'mint_memorial', gas: 50_000_000_000_000n, deposit: 0n,
        args: { grave_id: graveId, receiver_id: receiver, name_prefix: namePrefix, description },
      });
      const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
      if (typeof status !== 'object' || status.SuccessValue === undefined) {
        throw new Error(`mint failed: ${JSON.stringify(status && typeof status === 'object' ? status.Failure ?? status : status).slice(0, 300)}`);
      }
      const token = JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString('utf8')) as { token_id?: unknown };
      if (typeof token?.token_id !== 'string') throw new Error('mint returned no token');
      return { tokenId: token.token_id, txHash: outcome.transaction_outcome?.id ?? null };
    },
  };
}
