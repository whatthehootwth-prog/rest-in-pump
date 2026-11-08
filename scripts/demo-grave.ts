/**
 * Adds (or removes) ONE clearly labelled demo grave, so a local copy of the game has something to look at.
 * It is not a real meme and nobody paid for it. Never run this against the production database.
 *
 *   node scripts/demo-grave.ts            add the demo grave (plot 37, by the path near the gate)
 *   node scripts/demo-grave.ts --remove   remove it again
 *
 * Uses DB_PATH (default data/rip.sqlite). Refuses to run with NODE_ENV=production.
 */
import { readFileSync } from 'node:fs';
import { openDb, transaction } from '../server/src/db.ts';

if (process.env.NODE_ENV === 'production') throw new Error('demo-grave refuses to run with NODE_ENV=production');
const DB_PATH = process.env.DB_PATH ?? 'data/rip.sqlite';
const PAYMENT_ID = 'demo-grave';
const PLOT = 37;
const CONTRACT = 'demo.restinpump.near';

const db = openDb(DB_PATH);
const existing = db.prepare('SELECT id FROM graves WHERE payment_id = ?').get(PAYMENT_ID) as { id: number } | undefined;

if (process.argv.includes('--remove')) {
  if (!existing) { console.log('no demo grave in', DB_PATH); process.exit(0); }
  const used = db.prepare('SELECT COUNT(*) AS n FROM offerings WHERE grave_id = ?').get(existing.id) as { n: number };
  if (used.n > 0) throw new Error(`the demo grave has ${used.n} real offering(s); not removing it automatically`);
  transaction(db, () => {
    db.prepare('DELETE FROM memorials WHERE grave_id = ?').run(existing.id);
    db.prepare('DELETE FROM payments WHERE grave_id = ?').run(existing.id);
    db.prepare('DELETE FROM graves WHERE id = ?').run(existing.id);
    db.prepare('DELETE FROM payments WHERE id = ?').run(PAYMENT_ID);
  });
  console.log('removed the demo grave from', DB_PATH);
  process.exit(0);
}

if (existing) { console.log('demo grave already there (grave id', existing.id + ')'); process.exit(0); }
if (db.prepare('SELECT 1 FROM graves WHERE plot = ?').get(PLOT)) throw new Error(`plot ${PLOT} already has a grave`);

const icon = 'data:image/png;base64,' + readFileSync('client/public/logo-180.png').toString('base64');
const meme = { chain: 'near', contract: CONTRACT, name: 'Demo Meme', symbol: 'DEMO', decimals: 18, icon };
const now = Date.now();
transaction(db, () => {
  db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, message, meme_json, payer, error, created_at, expires_at, updated_at)
              VALUES (?, 'grave', 'fulfilled', '0', ?, 'near', ?, ?, ?, 'demo', 'Demo grave: not paid', ?, ?, ?)`)
    .run(PAYMENT_ID, PLOT, CONTRACT, 'Demo grave', JSON.stringify(meme), now, now, now);
  db.prepare(`INSERT INTO graves (plot, chain, contract, name, symbol, decimals, icon, message, creator, payment_id, created_at)
              VALUES (?, 'near', ?, ?, ?, 18, ?, ?, 'demo', ?, ?)`)
    .run(PLOT, CONTRACT, meme.name, meme.symbol, icon, 'Demo grave. Not a real meme — just here so you can see one.', PAYMENT_ID, now);
});
console.log(`added the demo grave at plot ${PLOT} in ${DB_PATH} (remove with: node scripts/demo-grave.ts --remove)`);
