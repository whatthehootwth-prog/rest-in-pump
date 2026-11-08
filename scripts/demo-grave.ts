/**
 * Adds (or removes) clearly labelled DEMO graves, one per memorial level, so a local copy of the game has
 * something to look at. They are not real memes, nobody paid for them, and their offering counts are set
 * directly for display. Never run this against the production database.
 *
 *   node scripts/demo-grave.ts            add the 4 demo graves (plots 37, 36, 29, 28: by the path near the gate)
 *   node scripts/demo-grave.ts --remove   remove them again
 *
 * Uses DB_PATH (default data/rip.sqlite). Refuses to run with NODE_ENV=production.
 */
import { openDb, transaction } from '../server/src/db.ts';
import { OFFERING_ITEMS } from '../shared/graves.ts';

if (process.env.NODE_ENV === 'production') throw new Error('demo-grave refuses to run with NODE_ENV=production');
const DB_PATH = process.env.DB_PATH ?? 'data/rip.sqlite';
const PREFIX = 'demo-';

// walking in from the gate you pass them in level order
const DEMOS = [
  { plot: 37, sym: 'RUG', name: 'Demo · Rug Pull', offerings: 3, items: 2 },
  { plot: 36, sym: 'COPE', name: 'Demo · Cope Coin', offerings: 42, items: 4 },
  { plot: 29, sym: 'NGMI', name: 'Demo · Not Gonna Make It', offerings: 420, items: 6 },
  { plot: 28, sym: 'WAGMI', name: 'Demo · We All Gonna Make It', offerings: 4200, items: 6 },
];

const db = openDb(DB_PATH);
const demoGraves = () => db.prepare(`SELECT id, plot FROM graves WHERE payment_id LIKE '${PREFIX}%'`).all() as { id: number; plot: number }[];

function removeAll() {
  const graves = demoGraves();
  for (const g of graves) {
    const real = db.prepare("SELECT COUNT(*) AS n FROM offerings WHERE grave_id = ? AND payment_id NOT LIKE ?").get(g.id, `${PREFIX}%`) as { n: number };
    if (real.n > 0) throw new Error(`demo grave at plot ${g.plot} has ${real.n} real offering(s); not removing it automatically`);
  }
  transaction(db, () => {
    for (const g of graves) {
      db.prepare('DELETE FROM memorials WHERE grave_id = ?').run(g.id);
      db.prepare('DELETE FROM offerings WHERE grave_id = ?').run(g.id);
      db.prepare('DELETE FROM payments WHERE grave_id = ?').run(g.id);
      db.prepare('DELETE FROM graves WHERE id = ?').run(g.id);
    }
    db.prepare(`DELETE FROM payments WHERE id LIKE '${PREFIX}%'`).run();
  });
  return graves.length;
}

const removed = removeAll();
if (process.argv.includes('--remove')) {
  console.log(`removed ${removed} demo grave(s) from ${DB_PATH}`);
  process.exit(0);
}

const taken = DEMOS.filter((d) => db.prepare('SELECT 1 FROM graves WHERE plot = ?').get(d.plot));
if (taken.length) throw new Error(`plot(s) ${taken.map((d) => d.plot).join(', ')} already have a real grave`);

const now = Date.now();
transaction(db, () => {
  for (const [i, d] of DEMOS.entries()) {
    const contract = `${d.sym.toLowerCase()}.demo.restinpump.near`;
    const meme = { chain: 'near', contract, name: d.name, symbol: d.sym, decimals: 18, icon: null };
    const pid = `${PREFIX}grave-${d.plot}`;
    const message = `Demo grave (level ${i + 1}). Not a real meme — just here so you can see one.`;
    db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, message, meme_json, payer, error, created_at, expires_at, updated_at)
                VALUES (?, 'grave', 'fulfilled', '0', ?, 'near', ?, ?, ?, 'demo', 'Demo grave: not paid', ?, ?, ?)`)
      .run(pid, d.plot, contract, message, JSON.stringify(meme), now, now, now);
    const r = db.prepare(`INSERT INTO graves (plot, chain, contract, name, symbol, decimals, icon, message, creator, payment_id, created_at, offering_count)
                          VALUES (?, 'near', ?, ?, ?, 18, NULL, ?, 'demo', ?, ?, ?)`)
      .run(d.plot, contract, d.name, d.sym, message, pid, now, d.offerings);
    const graveId = Number(r.lastInsertRowid);
    // a few offering items so the props show in front of the stone (display only)
    for (let k = 0; k < d.items; k++) {
      const opid = `${PREFIX}offering-${d.plot}-${k}`, item = OFFERING_ITEMS[k].id;
      db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, grave_id, item, message, meme_json, payer, error, created_at, expires_at, updated_at)
                  VALUES (?, 'offering', 'fulfilled', '0', ?, 'near', ?, ?, ?, '', ?, 'demo', 'Demo offering: not paid', ?, ?, ?)`)
        .run(opid, d.plot, contract, graveId, item, JSON.stringify(meme), now, now, now);
      db.prepare('INSERT INTO offerings (grave_id, payment_id, payer, item, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(graveId, opid, 'demo', item, '0', now);
    }
  }
});
console.log(`added ${DEMOS.length} demo graves (levels 1-4) at plots ${DEMOS.map((d) => d.plot).join(', ')} in ${DB_PATH}`);
console.log('remove with: node scripts/demo-grave.ts --remove');
