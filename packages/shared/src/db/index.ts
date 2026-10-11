import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export const DEFAULT_DB_PATH = "data/platypus.db";

/**
 * Opens the Platypus database and applies pending migrations.
 * Pass ":memory:" in tests. The path defaults to PLATYPUS_DB or data/platypus.db.
 */
export function openDb(path: string = process.env.PLATYPUS_DB ?? DEFAULT_DB_PATH): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

/**
 * Applies every migration file in order, once. Files ending in .sqlite.sql are
 * SQLite-specific (triggers); everything else is portable SQL.
 */
export function migrate(db: Db): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    db
      .prepare<[], { version: string }>("SELECT version FROM schema_migrations")
      .all()
      .map((r) => r.version),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    })();
    ran.push(file);
  }
  return ran;
}

export * from "./repo";
export * from "./seed";
