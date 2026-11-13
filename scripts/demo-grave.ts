/**
 * Adds (or removes) clearly labelled DEMO graves, one per memorial level, so a local copy of the game has
 * something to look at. They are not real memes, nobody paid for them, and their demo offerings are spread
 * over the items so the piles show. Never run this against the production database.
 *
 *   node scripts/demo-grave.ts            add the 4 demo graves (plots 37, 36, 29, 28: by the path near the gate)
 *   node scripts/demo-grave.ts --remove   remove them again
 *
 * Uses DB_PATH (default data/rip.sqlite). Refuses to run with NODE_ENV=production.
 */
import { openDb, transaction } from '../server/src/db.ts';
import sharp from 'sharp';
import { itemExp } from '../shared/graves.ts';

if (process.env.NODE_ENV === 'production') throw new Error('demo-grave refuses to run with NODE_ENV=production');
const DB_PATH = process.env.DB_PATH ?? 'data/rip.sqlite';
const PREFIX = 'demo-';

// walking in from the gate you pass them in level order
// EXP: RUG 4 (level 1), COPE 64 (level 2), NGMI 640 (level 3), WAGMI 6,400 (level 4)
const DEMOS = [
  { plot: 37, sym: 'RUG', name: 'Demo · Rug Pull', items: { candle: 2, flowers: 1 } },
  { plot: 36, sym: 'COPE', name: 'Demo · Cope Coin', items: { flowers: 12, candle: 10, noodles: 6 } },
  { plot: 29, sym: 'NGMI', name: 'Demo · Not Gonna Make It', items: { flowers: 60, candle: 70, noodles: 30, copium: 15, rug: 3 } },
  { plot: 28, sym: 'WAGMI', name: 'Demo · We All Gonna Make It', items: { flowers: 400, candle: 560, noodles: 160, copium: 70, rug: 25, diamond: 22 } },
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

// every demo grave wears the $WTH logo (display only)
const LOGO = 'data:image/webp;base64,' + (await sharp('brand/logo.webp').resize(128, 128).webp({ quality: 85 }).toBuffer()).toString('base64');

const now = Date.now();
transaction(db, () => {
  for (const [i, d] of DEMOS.entries()) {
    const contract = `${d.sym.toLowerCase()}.demo.restinpump.near`;
    const meme = { chain: 'near', contract, name: d.name, symbol: d.sym, decimals: 18, icon: LOGO };
    const pid = `${PREFIX}grave-${d.plot}`;
    const message = `Demo grave (level ${i + 1}). Not a real meme, just here so you can see one.`;
    db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, message, meme_json, payer, error, created_at, expires_at, updated_at)
                VALUES (?, 'grave', 'fulfilled', '0', ?, 'near', ?, ?, ?, 'demo', 'Demo grave: not paid', ?, ?, ?)`)
      .run(pid, d.plot, contract, message, JSON.stringify(meme), now, now, now);
    const exp = Object.entries(d.items).reduce((a, [item, n]) => a + itemExp(item) * n, 0);
    const r = db.prepare(`INSERT INTO graves (plot, chain, contract, name, symbol, decimals, icon, message, creator, payment_id, created_at, offering_count, exp)
                          VALUES (?, 'near', ?, ?, ?, 18, ?, ?, 'demo', ?, ?, ?, ?)`)
      .run(d.plot, contract, d.name, d.sym, LOGO, message, pid, now, Object.values(d.items).reduce((a, b) => a + b, 0), exp);
    const graveId = Number(r.lastInsertRowid);
    // demo offerings, so the piles show (display only; one row per offering, like real ones)
    let k = 0;
    for (const [item, count] of Object.entries(d.items)) for (let c = 0; c < count; c++, k++) {
      const opid = `${PREFIX}offering-${d.plot}-${k}`;
      db.prepare(`INSERT INTO payments (id, kind, status, amount, plot, chain, contract, grave_id, item, message, meme_json, payer, error, created_at, expires_at, updated_at)
                  VALUES (?, 'offering', 'fulfilled', '0', ?, 'near', ?, ?, ?, '', ?, 'demo', 'Demo offering: not paid', ?, ?, ?)`)
        .run(opid, d.plot, contract, graveId, item, JSON.stringify(meme), now, now, now);
      db.prepare('INSERT INTO offerings (grave_id, payment_id, payer, item, amount, exp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(graveId, opid, 'demo', item, '0', itemExp(item), now);
    }
  }
});
console.log(`added ${DEMOS.length} demo graves (levels 1-4) at plots ${DEMOS.map((d) => d.plot).join(', ')} in ${DB_PATH}`);
console.log('remove with: node scripts/demo-grave.ts --remove');
