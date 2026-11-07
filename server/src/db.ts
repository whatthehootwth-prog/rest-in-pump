import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite through Node's built-in driver (no extra service or dependency).
 * Migrations are applied in order and tracked with PRAGMA user_version.
 */
export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // 1: graves + payments
  `
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
  `,
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
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`database migration ${v + 1} failed: ${(err as Error).message}`);
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
