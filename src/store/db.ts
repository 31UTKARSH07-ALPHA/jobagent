/**
 * SQLite connection + migrations. `node:sqlite` is built into Node — no native build,
 * no dependency.
 *
 * Everything durable in this project lives here (decision 001). If a stage is holding
 * state in a variable across stage boundaries, that is the bug.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');

export const DEFAULT_DB_PATH = process.env['JOBAGENT_DB'] ?? 'data/jobagent.db';

export type Db = DatabaseSync;

/**
 * Open the DB and bring it up to the latest migration. Safe to call repeatedly;
 * already-applied migrations are skipped.
 *
 * Pass `':memory:'` for tests.
 */
export function openDb(path: string = DEFAULT_DB_PATH): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
}

type Migration = { id: number; name: string; sql: string };

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      const id = Number.parseInt(name.slice(0, 3), 10);
      if (!Number.isInteger(id)) {
        throw new Error(`migration "${name}" must start with a 3-digit number`);
      }
      return { id, name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') };
    })
    .sort((a, b) => a.id - b.id);
}

/** Applies pending migrations, each in its own transaction. Idempotent. */
export function migrate(db: Db): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
  );

  let count = 0;
  for (const m of loadMigrations()) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      record.run(m.id, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
    }
    count++;
  }
  return count;
}

/**
 * Run `fn` in a transaction. Rolls back and rethrows on any error.
 * Not reentrant — SQLite has no nested transactions without savepoints.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
