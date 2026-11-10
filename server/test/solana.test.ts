import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { candidateUrls, createSolanaLookup, iconDataUri } from '../src/solana.ts';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#f1c76b' } }).png().toBuffer();

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** A fake fetch: RPC posts go to `rpc`, everything else to `web`. Records every URL. */
function fakeFetch(rpc: Route, web: Route) {
  const seen: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input); seen.push(url);
    return init?.method === 'POST' ? rpc(url, init) : web(url, init);
  }) as typeof fetch;
  return { f, seen };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const account = (owner: string, info: Record<string, unknown>, type = 'mint') => json({ jsonrpc: '2.0', id: 1, result: { value: { owner, data: { parsed: { type, info } } } } });
const jup = (icon: string | null, symbol = 'Bonk') => json([{ id: 'OtherMint111111111111111111111111', name: 'Wrong', symbol: 'NO' }, { id: MINT, name: 'Bonk', symbol, icon }]);
const image = () => new Response(png, { headers: { 'content-type': 'image/png' } });

describe('solana token lookup', () => {
  it('reads a mint: decimals from Solana, name/ticker from Jupiter, logo shrunk to a 128px WebP', async () => {
    const { f, seen } = fakeFetch(() => account(SPL, { decimals: 5 }), (u) => (u.includes('jup.ag') ? jup('https://arweave.net/logo') : image()));
    const r = await createSolanaLookup({ rpcUrls: ['https://rpc.test'], fetchImpl: f })(MINT);
    expect(r).toMatchObject({ ok: true, meta: { name: 'Bonk', symbol: 'Bonk', decimals: 5 } });
    if (!r.ok) throw new Error();
    expect(r.meta.icon).toMatch(/^data:image\/webp;base64,/);
    const meta = await sharp(Buffer.from(r.meta.icon!.split(',')[1], 'base64')).metadata();
    expect([meta.width, meta.height, meta.format]).toEqual([128, 128, 'webp']);
    expect(seen).toContain('https://arweave.net/logo');
  });

  it('says clearly when the address is not a token, not found, or Solana is down', async () => {
    const web: Route = () => jup(null);
    const look = (rpc: Route, urls = ['https://a.test']) => createSolanaLookup({ rpcUrls: urls, fetchImpl: fakeFetch(rpc, web).f })(MINT);
    expect(await look(() => json({ result: { value: null } }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(await look(() => account('11111111111111111111111111111111', {}, 'account'))).toMatchObject({ ok: false, code: 'not_token' });
    expect(await look(() => account(SPL, { decimals: 6 }, 'account'))).toMatchObject({ ok: false, code: 'not_token' });   // a token account, not the mint
    expect(await look(() => json({}, 500))).toMatchObject({ ok: false, code: 'unavailable' });
    // the second RPC endpoint is tried when the first fails
    let n = 0;
    expect(await look(() => (n++ === 0 ? json({}, 502) : account(SPL, { decimals: 5 })), ['https://a.test', 'https://b.test'])).toMatchObject({ ok: true });
    expect(await createSolanaLookup({ rpcUrls: ['https://a.test'], fetchImpl: fakeFetch(() => account(SPL, {}), web).f })('not a mint')).toMatchObject({ ok: false });
  });

  it('falls back to Token-2022 metadata when Jupiter does not know the token, and gives up with no name at all', async () => {
    const t22 = () => account(T22, { decimals: 9, extensions: [{ extension: 'tokenMetadata', state: { name: 'Fresh​ Rug', symbol: 'FRUG', uri: 'https://meta.test/frug.json' } }] });
    const web: Route = (u) => u.includes('jup.ag') ? json([]) : u.endsWith('.json') ? json({ image: 'https://img.test/frug.png' }) : image();
    const r = await createSolanaLookup({ rpcUrls: ['https://a.test'], fetchImpl: fakeFetch(t22, web).f })(MINT);
    expect(r).toMatchObject({ ok: true, meta: { name: 'Fresh Rug', symbol: 'FRUG', decimals: 9 } });
    expect(r.ok && r.meta.icon).toMatch(/^data:image\/webp/);
    const bare = await createSolanaLookup({ rpcUrls: ['https://a.test'], fetchImpl: fakeFetch(() => account(SPL, { decimals: 6 }), () => json([])).f })(MINT);
    expect(bare).toMatchObject({ ok: false, code: 'not_token' });
  });

  it('a bad logo never blocks the grave: the token is found with no icon', async () => {
    const { f } = fakeFetch(() => account(SPL, { decimals: 5 }), (u) => (u.includes('jup.ag') ? jup('https://img.test/x.png', '$BONK') : new Response('<html>nope</html>')));
    expect(await createSolanaLookup({ rpcUrls: ['https://a.test'], fetchImpl: f })(MINT)).toMatchObject({ ok: true, meta: { icon: null, symbol: 'BONK' } });
  });
});

describe('solana logos are fetched safely', () => {
  it('only public https links; redirects are re-checked; size is capped', async () => {
    const { f, seen } = fakeFetch(() => json({}), () => image());
    for (const u of ['http://img.test/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://x.internal/a.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA']) {
      expect(await iconDataUri(u, f)).toBeNull();
    }
    expect(seen).toEqual([]);   // none of them were even requested
    const redirect = fakeFetch(() => json({}), (u) => (u.includes('start') ? new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } }) : image()));
    expect(await iconDataUri('https://img.test/start', redirect.f)).toBeNull();
    expect(redirect.seen).toEqual(['https://img.test/start']);
    const big = fakeFetch(() => json({}), () => new Response(new Uint8Array(5 * 1024 * 1024)));
    expect(await iconDataUri('https://img.test/huge.png', big.f)).toBeNull();
  });

  it('IPFS logos are tried on several gateways when one rate-limits', async () => {
    const cid = 'bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum';
    expect(candidateUrls(`ipfs://${cid}`)[0]).toBe(`https://ipfs.filebase.io/ipfs/${cid}`);
    expect(candidateUrls(`https://${cid}.ipfs.nftstorage.link`)).toContain(`https://4everland.io/ipfs/${cid}`);
    expect(candidateUrls(`https://ipfs.io/ipfs/${cid}/logo.png`)).toContain(`https://gateway.pinata.cloud/ipfs/${cid}/logo.png`);
    expect(candidateUrls('https://arweave.net/abc')).toEqual(['https://arweave.net/abc']);
    const { f, seen } = fakeFetch(() => json({}), (u) => (u.includes('nftstorage') ? new Response('slow down', { status: 429 }) : image()));
    expect(await iconDataUri(`https://${cid}.ipfs.nftstorage.link`, f)).toMatch(/^data:image\/webp/);
    expect(seen).toEqual([`https://${cid}.ipfs.nftstorage.link/`, `https://ipfs.filebase.io/ipfs/${cid}`]);
  });
});
