import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { candidateUrls, createSolanaLookup, iconDataUri, imageKind, isPublicIp, publicFetch, readLimited, safeUrl } from '../src/solana.ts';

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

describe('logo fetching cannot reach private networks or use too much memory (audit S02-S04)', () => {
  it('rejects local-looking names, trailing dots, single labels, other ports and credentials', () => {
    for (const u of ['https://localhost./a.png', 'https://LOCALHOST/a.png', 'https://intranet/a.png', 'https://printer.lan/a.png', 'https://x.home.arpa/a.png',
      'https://img.example.com:8443/a.png', 'https://user:pw@img.example.com/a.png', 'https://2130706433/a.png', 'https://0x7f.1/a.png', 'https://[::ffff:127.0.0.1]/a.png']) {
      expect(safeUrl(u), u).toBeNull();
    }
    expect(safeUrl('https://img.example.com/a.png')?.hostname).toBe('img.example.com');
    expect(safeUrl('https://img.example.com:443/a.png')).not.toBeNull();
  });

  it('knows which addresses are public, including IPv4 hidden in IPv6', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1',
      'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::', 'not-an-ip']) {
      expect(isPublicIp(a), a).toBe(false);
    }
    for (const a of ['1.1.1.1', '104.16.0.1', '2606:4700::1111', '::ffff:1.1.1.1']) expect(isPublicIp(a), a).toBe(true);
  });

  it('the real fetcher refuses private IP literals before connecting', async () => {
    await expect(publicFetch('https://127.0.0.1/a.png')).rejects.toThrow(/not a public address/);
    await expect(publicFetch('https://[::ffff:10.0.0.1]/a.png')).rejects.toThrow(/not a public address/);
  });

  it('stops reading a body as soon as it goes over the cap, whatever it claimed', async () => {
    let pulled = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); },   // endless, no content-length
      cancel() { cancelled = true; },
    });
    expect(await readLimited(new Response(body), 256 * 1024)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);   // about 256 KB read, not the whole stream
    const lying = new Response(new Uint8Array(10), { headers: { 'content-length': String(10 * 1024 * 1024) } });
    expect(await readLimited(lying, 1024)).toBeNull();
    expect((await readLimited(new Response(new Uint8Array(100)), 1024))?.length).toBe(100);
  });

  it('only decodes PNG, JPEG, GIF, WebP and SVG, told apart by their bytes', async () => {
    expect(imageKind(png)).toBe('png');
    expect(imageKind(await sharp(png).jpeg().toBuffer())).toBe('jpeg');
    expect(imageKind(await sharp(png).webp().toBuffer())).toBe('webp');
    expect(imageKind(await sharp(png).gif().toBuffer())).toBe('gif');
    expect(imageKind(Buffer.from('﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('svg');
    expect(imageKind(await sharp(png).tiff().toBuffer())).toBeNull();
    expect(imageKind(await sharp(png).avif().toBuffer())).toBeNull();   // HEIF family: blocked
    expect(imageKind(Buffer.from('<html>nope</html>'))).toBeNull();
    const tiff = fakeFetch(() => json({}), async () => new Response(await sharp(png).tiff().toBuffer()));
    expect(await iconDataUri('https://img.test/logo.tiff', tiff.f)).toBeNull();
  });
});
