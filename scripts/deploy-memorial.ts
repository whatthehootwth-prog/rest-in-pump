/**
 * Sets up the Memorial NFTs on NEAR in two transactions, signed by the owner account:
 *
 *   1. creates memorial.<owner>, funds it, deploys the contract and initialises it
 *   2. creates minter.<owner>, funds it, and gives it a key that can ONLY call mint_memorial
 *
 * Then it prints the Railway variables. The owner's private key is asked for in this terminal (typing hidden),
 * used only to sign these two transactions, and never saved or sent anywhere else.
 *
 *   node scripts/deploy-memorial.ts --dry-run                 check everything, send nothing (no key needed)
 *   node scripts/deploy-memorial.ts                           mainnet, owner whatthehootbrain.near
 *   node scripts/deploy-memorial.ts --testnet --owner you.testnet
 *
 * Options: --owner <account>  --memorial-near 4  --minter-near 0.5  --base-uri https://rip.whatthehoot.lol/nft
 * Build the contract first: npm run contract:build
 */
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const testnet = args.includes('--testnet');
const dryRun = args.includes('--dry-run');
const network = testnet ? 'testnet' : 'mainnet';
const owner = opt('owner', testnet ? '' : 'whatthehootbrain.near');
if (!owner) { console.error('On testnet, say which account pays: --owner yourname.testnet'); process.exit(1); }
const memorial = `memorial.${owner}`;
const minter = `minter.${owner}`;
const baseUri = opt('base-uri', 'https://rip.whatthehoot.lol/nft');
const memorialNear = opt('memorial-near', '4');
const minterNear = opt('minter-near', '0.5');
const rpcUrl = testnet ? 'https://rpc.testnet.fastnear.com' : 'https://rpc.mainnet.fastnear.com';
const WASM = 'contracts/memorial/target/wasm32-unknown-unknown/release/rip_memorial.wasm';

const YOCTO = 10n ** 24n;
function near(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`not a NEAR amount: ${s}`);
  const [w, f = ''] = s.split('.');
  return BigInt(w) * YOCTO + BigInt(f.padEnd(24, '0'));
}
const fmt = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(4);
const TGAS = 10n ** 12n;
const MINTER_ALLOWANCE = near('0.25');   // gas the mint-only key may spend before it needs a new allowance

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const r = rl as unknown as { _writeToOutput: (s: string) => void };
    r._writeToOutput = (s: string) => { if (s.includes(question)) process.stdout.write(question); };
  }
  return new Promise((res) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a.trim()); }));
}

async function exists(provider: JsonRpcProvider, id: string): Promise<boolean> {
  try { await new Account(id, provider).getState(); return true; }
  catch (e) { if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(String((e as Error)?.message ?? e))) return false; throw e; }
}

async function main() {
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|testnet)$/.test(owner)) throw new Error(`not a ${network} account: ${owner}`);
  if (testnet !== owner.endsWith('.testnet')) throw new Error(`${owner} is not a ${network} account`);
  if (!existsSync(WASM)) throw new Error(`contract not built: run npm run contract:build first`);
  const code = readFileSync(WASM);
  const memorialYocto = near(memorialNear), minterYocto = near(minterNear);
  const codeStorage = BigInt(code.length) * 10n ** 19n;   // 1 NEAR per 100 KB
  if (memorialYocto < codeStorage + near('0.2')) throw new Error(`--memorial-near ${memorialNear} is too little: the code alone locks about ${fmt(codeStorage)} NEAR`);

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const state = await new Account(owner, provider).getState().catch(() => null);
  if (!state) throw new Error(`${owner} does not exist on ${network}`);
  const balance = BigInt(state.balance.available);
  const needed = memorialYocto + minterYocto + near('0.05');
  const taken = [memorial, minter].filter(Boolean);
  const already = [];
  for (const id of taken) if (await exists(provider, id)) already.push(id);

  console.log(`
  Network         ${network}
  Owner (pays)    ${owner}   available ${fmt(balance)} NEAR
  Contract        ${memorial}   gets ${memorialNear} NEAR (code locks ~${fmt(codeStorage)}, room for ~${Number((memorialYocto - codeStorage) / (10n ** 22n))} memorials)
  Minter          ${minter}   gets ${minterNear} NEAR (gas only)
  NFT links       ${baseUri}
  Contract file   ${WASM} (${(code.length / 1024).toFixed(0)} KB)
`);
  const problems: string[] = [];
  if (balance < needed) problems.push(`${owner} needs at least ${fmt(needed)} NEAR available (has ${fmt(balance)})`);
  for (const id of already) problems.push(`${id} already exists; this script only creates new accounts`);
  if (problems.length) { for (const p of problems) console.error('  PROBLEM: ' + p); process.exit(1); }
  if (dryRun) { console.log('  Dry run: everything checks out. Nothing was sent.'); return; }

  const secret = await ask(`Private key of ${owner} (ed25519:..., hidden): `, true);
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(secret)) throw new Error('that does not look like an ed25519 private key');
  const signer = KeyPairSigner.fromSecretKey(secret as KeyPairString);
  const ownerKey = await signer.getPublicKey();
  const access = await new Account(owner, provider).getAccessKey(ownerKey).catch(() => null);
  if (!access) throw new Error(`that key is not a key of ${owner}`);
  if (access.permission !== 'FullAccess') throw new Error(`that key of ${owner} is not a full access key`);

  if ((await ask(`Send ${fmt(memorialYocto + minterYocto)} NEAR from ${owner} and create both accounts? Type yes: `)).toLowerCase() !== 'yes') {
    console.log('Cancelled. Nothing was sent.'); return;
  }
  const account = new Account(owner, provider, signer);

  console.log(`\n1/2 Creating ${memorial} and deploying the contract...`);
  const t1 = await account.signAndSendTransaction({
    receiverId: memorial,
    actions: [
      actionCreators.createAccount(),
      actionCreators.transfer(memorialYocto),
      actionCreators.addKey(ownerKey, actionCreators.fullAccessKey()),   // the owner can upgrade the contract later
      actionCreators.deployContract(code),
      actionCreators.functionCall('new', { owner_id: owner, minter_id: minter, base_uri: baseUri }, 50n * TGAS, 0n),
    ],
  });
  console.log(`    done: ${t1.transaction.hash}`);

  console.log(`2/2 Creating ${minter} with a mint-only key...`);
  const mintKey = KeyPair.fromRandom('ed25519');
  const t2 = await account.signAndSendTransaction({
    receiverId: minter,
    actions: [
      actionCreators.createAccount(),
      actionCreators.transfer(minterYocto),
      actionCreators.addKey(ownerKey, actionCreators.fullAccessKey()),
      actionCreators.addKey(mintKey.getPublicKey(), actionCreators.functionCallAccessKey(memorial, ['mint_memorial'], MINTER_ALLOWANCE)),
    ],
  });
  console.log(`    done: ${t2.transaction.hash}`);

  const view = async (method: string) => {
    const r = await provider.callFunction(memorial, method, {});
    return r;
  };
  const gotMinter = await view('get_minter');
  const gotOwner = await view('get_owner');
  console.log(`\nCheck: contract owner ${gotOwner}, minter ${gotMinter}${gotMinter === minter && gotOwner === owner ? ' (correct)' : ' (UNEXPECTED, tell Claude)'}`);

  console.log(`
Paste these into Railway (service > Variables). The last one is secret: only put it in Railway.

NFT_CONTRACT=${memorial}
MINTER_ACCOUNT_ID=${minter}
PUBLIC_BASE_URL=${baseUri.replace(/\/nft$/, '')}
MINTER_PRIVATE_KEY=${mintKey.toString()}
`);
}

main().catch((e) => { console.error('\nStopped: ' + ((e as Error)?.message ?? e)); process.exit(1); });
