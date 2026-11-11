import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite through Node's built-in driver (no extra service or dependency).
 * Migrations are applied in order and tracked with PRAGMA user_version.
 */
export type Db = DatabaseSync;

interface Migration { sql: string; /** run with foreign keys off (table rebuilds), then checked */ rebuild?: boolean }

const MIGRATIONS: Migration[] = [
  // 1: graves + payments
  { sql: `
  CREATE TABLE payments (
    id           TEXT PRIMARY KEY,               -- also used in the transfer memo
    kind         TEXT NOT NULL CHECK (kind IN ('grave')),
    status       TEXT NOT NULL CHECK (status IN ('pending','confirming','fulfilled','expired','failed','unfulfillable')),
    amount       TEXT NOT NULL,                  -- required amount, smallest token unit
    plot         INTEGER NOT NULL,
    chain        TEXT NOT NULL,
    contract     TEXT NOT NULL,
    tier         INTEGER NOT NULL,
    message      TEXT NOT NULL,
    meme_json    TEXT NOT NULL,                  -- name/symbol/icon as resolved by the server
    tx_hash      TEXT UNIQUE,
    payer        TEXT,
    error        TEXT,
    client_ip    TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  -- a plot / a contract can be held by at most one unpaid payment at a time
  CREATE UNIQUE INDEX payments_open_plot ON payments(plot) WHERE status IN ('pending','confirming');
  CREATE UNIQUE INDEX payments_open_contract ON payments(chain, contract) WHERE status IN ('pending','confirming');
  CREATE INDEX payments_status ON payments(status, expires_at);

  CREATE TABLE graves (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plot         INTEGER NOT NULL UNIQUE,
    chain        TEXT NOT NULL,
    contract     TEXT NOT NULL,
    tier         INTEGER NOT NULL,
    name         TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    decimals     INTEGER,
    icon         TEXT,
    message      TEXT NOT NULL,
    creator      TEXT NOT NULL,
    payment_id   TEXT NOT NULL UNIQUE REFERENCES payments(id),
    created_at   INTEGER NOT NULL,
    UNIQUE (chain, contract)                     -- one grave per meme, ever
  );
  ` },

  // 2: offerings + Memorial NFTs. Tombstone tiers are replaced by levels from the offering count.
  { rebuild: true, sql: `
  CREATE TABLE payments_v2 (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('grave','offering')),
    status       TEXT NOT NULL CHECK (status IN ('pending','confirming','fulfilled','expired','failed','unfulfillable')),
    amount       TEXT NOT NULL,
    plot         INTEGER NOT NULL,
    chain        TEXT NOT NULL,
    contract     TEXT NOT NULL,
    grave_id     INTEGER REFERENCES graves(id),  -- offering: the grave it goes to
    item         TEXT,                           -- offering: the item left
    message      TEXT NOT NULL,
    meme_json    TEXT NOT NULL,
    tx_hash      TEXT UNIQUE,
    payer        TEXT,
    error        TEXT,
    client_ip    TEXT,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    CHECK ((kind = 'offering') = (grave_id IS NOT NULL AND item IS NOT NULL))
  );
  INSERT INTO payments_v2 (id, kind, status, amount, plot, chain, contract, message, meme_json, tx_hash, payer, error, client_ip, created_at, expires_at, updated_at)
    SELECT id, kind, status, amount, plot, chain, contract, message, meme_json, tx_hash, payer, error, client_ip, created_at, expires_at, updated_at FROM payments;
  DROP TABLE payments;
  ALTER TABLE payments_v2 RENAME TO payments;
  -- only grave creation holds a plot / a meme
  CREATE UNIQUE INDEX payments_open_plot ON payments(plot) WHERE kind = 'grave' AND status IN ('pending','confirming');
  CREATE UNIQUE INDEX payments_open_contract ON payments(chain, contract) WHERE kind = 'grave' AND status IN ('pending','confirming');
  CREATE INDEX payments_status ON payments(status, expires_at);

  ALTER TABLE graves DROP COLUMN tier;
  ALTER TABLE graves ADD COLUMN offering_count INTEGER NOT NULL DEFAULT 0;   -- successful offerings only

  -- one row per successful offering payment (never for failed or repeated confirmations)
  CREATE TABLE offerings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    grave_id     INTEGER NOT NULL REFERENCES graves(id),
    payment_id   TEXT NOT NULL UNIQUE REFERENCES payments(id),
    payer        TEXT NOT NULL,
    item         TEXT NOT NULL,
    amount       TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX offerings_grave ON offerings(grave_id, id);
  CREATE INDEX offerings_payer ON offerings(grave_id, payer);

  -- one Memorial NFT per wallet per grave, queued on the wallet's first offering and minted on NEAR
  CREATE TABLE memorials (
    grave_id          INTEGER NOT NULL REFERENCES graves(id),
    account_id        TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending','minting','minted','failed')),
    token_id          TEXT UNIQUE,
    serial            INTEGER,
    attempts          INTEGER NOT NULL DEFAULT 0,
    next_attempt_at   INTEGER NOT NULL DEFAULT 0,
    error             TEXT,
    mint_tx           TEXT,
    first_offering_at INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (grave_id, account_id)
  );
  CREATE INDEX memorials_queue ON memorials(status, next_attempt_at);
  ` },

  // 3: buyback rounds (revenue -> 20% WTH wallet, 80% buys WTH -> shared with holders) and their payouts
  { sql: `
  CREATE TABLE buyback_rounds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    status      TEXT NOT NULL CHECK (status IN ('running','done','failed','needs_check')),
    step        TEXT NOT NULL,
    near_total  TEXT NOT NULL,
    near_team   TEXT NOT NULL,
    near_buy    TEXT NOT NULL,
    near_usd    REAL NOT NULL,
    team_tx     TEXT,
    swap_tx     TEXT,
    wth_bought  TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE buyback_payouts (
    round_id    INTEGER NOT NULL REFERENCES buyback_rounds(id),
    account     TEXT NOT NULL,
    holding     TEXT NOT NULL,
    amount      TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pending','sending','sent')),
    tx          TEXT,
    PRIMARY KEY (round_id, account)
  );
  ` },

  // 4: gifts give EXP (each offering keeps the EXP it gave; a grave's level comes from its EXP total).
  //    Older offerings get the EXP of their item (same values as OFFERING_ITEMS in shared/graves.ts).
  { sql: `
  ALTER TABLE offerings ADD COLUMN exp INTEGER NOT NULL DEFAULT 0;
  UPDATE offerings SET exp = CASE item
    WHEN 'candle' THEN 1 WHEN 'flowers' THEN 2 WHEN 'noodles' THEN 5
    WHEN 'copium' THEN 12 WHEN 'rug' THEN 40 WHEN 'diamond' THEN 150 ELSE 1 END;
  ALTER TABLE graves ADD COLUMN exp INTEGER NOT NULL DEFAULT 0;
  UPDATE graves SET exp = (SELECT COALESCE(SUM(exp), 0) FROM offerings WHERE offerings.grave_id = graves.id);
  ` },

  // 5: an unfinished order belongs to the browser that made it (its random session id), not to whoever shares its IP.
  { sql: `
  ALTER TABLE payments ADD COLUMN client_session TEXT;
  CREATE INDEX payments_session ON payments (client_session, status);
  ` },
];

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v];
    // a table rebuild needs foreign keys off (it can't be switched inside a transaction)
    if (m.rebuild) db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      if (m.rebuild) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`foreign key check failed: ${JSON.stringify(broken.slice(0, 3))}`);
      }
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`database migration ${v + 1} failed: ${(err as Error).message}`);
    } finally {
      if (m.rebuild) db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

/** Runs fn inside a write transaction (all or nothing). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
