import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { insideDir, startServer, type GameServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';

describe('static files stay inside the client folder (audit S08)', () => {
  it('compares whole path parts, not a string prefix', () => {
    const root = path.resolve('/srv/dist/client');
    expect(insideDir(root, path.join(root, 'index.html'))).toBe(true);
    expect(insideDir(root, path.join(root, 'assets', '..foo.js'))).toBe(true);
    expect(insideDir(root, root)).toBe(true);
    expect(insideDir(root, path.resolve('/srv/dist/client-private/proof.txt'))).toBe(false);
    expect(insideDir(root, path.resolve('/srv/dist/client/../server/index.js'))).toBe(false);
  });

  const dir = mkdtempSync(path.join(tmpdir(), 'rip-static-'));
  const client = path.join(dir, 'client');
  mkdirSync(client); mkdirSync(path.join(dir, 'client-private'));
  writeFileSync(path.join(client, 'index.html'), '<!doctype html><title>game</title>');
  writeFileSync(path.join(dir, 'client-private', 'proof.txt'), 'SECRET');
  let server: GameServer | null = null;
  afterAll(async () => { await server?.close(); rmSync(dir, { recursive: true, force: true }); });

  it('refuses encoded backslashes and never serves a sibling folder', async () => {
    server = await startServer(loadConfig({ PORT: '0', STATIC_DIR: client, DB_PATH: ':memory:' }), silentLogger);
    const base = `http://127.0.0.1:${server.port}`;
    for (const p of ['/..%5cclient-private%5cproof.txt', '/%5c..%5cclient-private%5cproof.txt', '/..%2fclient-private%2fproof.txt', '/a%00.html']) {
      const r = await fetch(base + p);
      expect(await r.text(), p).not.toContain('SECRET');
    }
    const home = await fetch(base + '/');
    expect(home.status).toBe(200);
    expect(home.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
  });
});
