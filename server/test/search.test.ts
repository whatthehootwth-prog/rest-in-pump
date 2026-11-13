import { describe, expect, it } from 'vitest';
import { createTokenSearch, rank } from '../src/search.ts';

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const LIST = {
  'nkok.tkn.near': { name: 'Nearkok', symbol: 'nKOK', icon: '' },
  'bdkok-292.meme-cooking.near': { name: 'Bad Kok', symbol: 'BDKOK', icon: '' },
  'blackdragon.tkn.near': { name: 'Black Dragon', symbol: 'BLACKDRAGON', icon: 'data:image/png;base64,bm90IGFuIGltYWdl' },
  'wrap.near': { name: 'Wrapped NEAR', symbol: 'wNEAR', icon: '' },
};

function fake() {
  const seen: string[] = [];
  const f = (async (u: string | URL) => {
    const url = String(u); seen.push(url);
    if (url.includes('list-token')) return json(LIST);
    if (url.includes('jup.ag')) return json([{ id: 'FiqmsrQ3WVVQVVFHbjhkCAUrabBrfAiHHknX5VT2pump', name: 'Nicolas Kokkalis', symbol: 'nkokkalis' }, { id: 'bad id', name: 'x', symbol: 'x' }]);
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}

describe('coin search', () => {
  it('ranks an exact ticker above partial matches', () => {
    expect(rank({ contract: 'nkok.tkn.near', name: 'Nearkok', symbol: 'nKOK' }, 'nkok')).toBe(0);
    expect(rank({ contract: 'bdkok-292.meme-cooking.near', name: 'Bad Kok', symbol: 'BDKOK' }, 'kok')).toBe(6);
    expect(rank({ contract: 'wrap.near', name: 'Wrapped NEAR', symbol: 'wNEAR' }, 'kok')).toBeNull();
  });

  it('finds dead NEAR coins in the RHEA list, buried ones first with their plot, bad logos dropped', async () => {
    const { f, seen } = fake();
    const s = createTokenSearch({ fetchImpl: f, buried: () => [{ chain: 'near', contract: 'bdkok-292.meme-cooking.near', name: 'Bad Kok', symbol: 'BDKOK', plot: 12 }] });
    const r = await s.search('near', 'kok');
    expect(r.map((x) => x.contract)).toEqual(['bdkok-292.meme-cooking.near', 'nkok.tkn.near']);
    expect(r[0].plot).toBe(12);
    expect(r[1].plot).toBeNull();
    const d = await s.search('near', '$black');
    expect(d[0]).toMatchObject({ contract: 'blackdragon.tkn.near', icon: null });
    await s.search('near', 'KOK');   // cached (case does not matter on NEAR)
    expect(seen.filter((u) => u.includes('list-token'))).toHaveLength(1);
  });

  it('asks Jupiter for Solana coins and keeps only real mint addresses', async () => {
    const { f, seen } = fake();
    const r = await createTokenSearch({ fetchImpl: f, buried: () => [] }).search('solana', 'nkok');
    expect(r).toEqual([{ contract: 'FiqmsrQ3WVVQVVFHbjhkCAUrabBrfAiHHknX5VT2pump', name: 'Nicolas Kokkalis', symbol: 'nkokkalis', icon: null, plot: null }]);
    expect(seen.some((u) => u.includes('query=nkok'))).toBe(true);
  });

  it('ignores one-letter queries and unsupported chains', async () => {
    const { f, seen } = fake();
    const s = createTokenSearch({ fetchImpl: f, buried: () => [] });
    expect(await s.search('near', 'k')).toEqual([]);
    expect(await s.search('base', 'kok')).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});
