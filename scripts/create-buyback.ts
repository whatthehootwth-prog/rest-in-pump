/**
 * Creates the buyback account (buyback.<owner>) in one transaction signed by the owner account, funds it with
 * a small reserve for gas and token storage, and gives it a new key for the server. Then it prints the Railway
 * variables. The owner's private key is asked for in this terminal (typing hidden), used only to sign this one
 * transaction, and never saved or sent anywhere else.
 *
 *   node scripts/create-buyback.ts --dry-run          check everything, send nothing (no key needed)
 *   node scripts/create-buyback.ts                    mainnet, owner whatthehootbrain.near, 1 NEAR
 *
 * Options: --owner <account>  --near 1  --team <account that gets the team share, default whatthehoot.near>
 */
import { createInterface } from 'node:readline';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const dryRun = args.includes('--dry-run');
const owner = opt('owner', 'whatthehootbrain.near');
const team = opt('team', 'whatthehoot.near');
const fund = opt('near', '1');
const buyback = `buyback.${owner}`;
const provider = new JsonRpcProvider({ url: 'https://rpc.mainnet.fastnear.com' });

const YOCTO = 10n ** 24n;
function near(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`not a NEAR amount: ${s}`);
  const [w, f = ''] = s.split('.');
  return BigInt(w) * YOCTO + BigInt(f.padEnd(24, '0'));
}
const fmt = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(4);

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const r = rl as unknown as { _writeToOutput: (s: string) => void };
    r._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(question); };
  }
  return new Promise((res) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); }));
}

async function exists(id: string): Promise<boolean> {
  try { await new Account(id, provider).getState(); return true; }
  catch (e) { if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String((e as Error)?.message ?? e))) return false; throw e; }
}

async function main() {
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.near$/.test(owner)) throw new Error(`not a mainnet account: ${owner}`);
  const amount = near(fund);
  if (amount < near('0.6')) throw new Error('--near must be at least 0.6 (0.5 stays as a reserve that buybacks never spend)');
  const state = await new Account(owner, provider).getState().catch(() => null);
  if (!state) throw new Error(`${owner} does not exist`);
  const balance = BigInt(state.balance.available);
  const teamExists = await exists(team);

  console.log(`
  Owner (pays)    ${owner}   available ${fmt(balance)} NEAR
  Buyback         ${buyback}   gets ${fund} NEAR (0.5 stays as reserve for gas and storage)
  Team share      ${team}   gets 20% of every round
`);
  const problems: string[] = [];
  if (balance < amount + near('0.02')) problems.push(`${owner} needs at least ${fmt(amount + near('0.02'))} NEAR available (has ${fmt(balance)})`);
  if (await exists(buyback)) problems.push(`${buyback} already exists; this script only creates a new account`);
  if (!teamExists) problems.push(`team wallet ${team} does not exist`);
  if (problems.length) { for (const p of problems) console.error('  PROBLEM: ' + p); process.exit(1); }
  if (dryRun) { console.log('  Dry run: everything checks out. Nothing was sent.'); return; }

  const secret = await ask(`Private key of ${owner} (ed25519:..., hidden): `, true);
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(secret)) throw new Error('that does not look like an ed25519 private key');
  const signer = KeyPairSigner.fromSecretKey(secret as KeyPairString);
  const ownerKey = await signer.getPublicKey();
  const access = await new Account(owner, provider).getAccessKey(ownerKey).catch(() => null);
  if (!access) throw new Error(`that key is not a key of ${owner}`);
  if (access.permission !== 'FullAccess') throw new Error(`that key of ${owner} is not a full access key`);
  if ((await ask(`Send ${fund} NEAR from ${owner} and create ${buyback}? Type yes: `)).toLowerCase() !== 'yes') {
    console.log('Cancelled. Nothing was sent.'); return;
  }

  // the server needs full access: it sends NEAR, wraps it, swaps on Ref and sends WTH to holders
  const serverKey = KeyPair.fromRandom('ed25519');
  const out = await new Account(owner, provider, signer).signAndSendTransaction({
    receiverId: buyback,
    actions: [
      actionCreators.createAccount(),
      actionCreators.transfer(amount),
      actionCreators.addKey(ownerKey, actionCreators.fullAccessKey()),   // so the owner can always reach the funds
      actionCreators.addKey(serverKey.getPublicKey(), actionCreators.fullAccessKey()),
    ],
  });
  console.log(`\nCreated ${buyback}: ${out.transaction.hash}`);
  console.log(`
Paste these into Railway (service > Variables). BUYBACK_PRIVATE_KEY is secret: only put it in Railway.
Change TREASURY_ACCOUNT at a quiet moment: orders opened before the switch still expect whatthehoot.near.

TREASURY_ACCOUNT=${buyback}
BUYBACK_ACCOUNT_ID=${buyback}
BUYBACK_TEAM_WALLET=${team}
BUYBACK_PRIVATE_KEY=${serverKey.toString()}
`);
}

main().catch((e) => { console.error('\nStopped: ' + ((e as Error)?.message ?? e)); process.exit(1); });
