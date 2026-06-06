import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import * as sqliteVec from "sqlite-vec";

import { CONFIG } from "../config";
import { registerUdfCosineSimilarity } from "../retrieval/vector";

export { runMigrations } from "./migrations";

let db: Database | null = null;
let customSqliteConfigured = false;
const writeTransactionDepth = new WeakMap<Database, number>();

// ─── SQLite configuration ──────────────────────────────────────────

function configureCustomSqlite(): void {
  if (customSqliteConfigured) {
    return;
  }
  customSqliteConfigured = true;

  const candidates = [
    process.env.TRIMEMH_SQLITE_DYLIB,
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    if (existsSync(path)) {
      Database.setCustomSQLite(path);
      return;
    }
  }
}

function loadSqliteVec(database: Database): string {
  try {
    sqliteVec.load(database);
    const row = database.query("SELECT vec_version() AS version;").get() as
      | { version: string }
      | undefined;
    if (!row?.version) {
      throw new Error("vec_version() returned no version.");
    }
    (database as Database & { sqliteVecLoaded?: boolean }).sqliteVecLoaded = true;
    (database as Database & { sqliteVecVersion?: string }).sqliteVecVersion = row.version;
    return row.version;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // biome-ignore lint/nursery/useErrorCause: warning suppression
    throw new Error(
      [
        "sqlite-vec is required for triMemh vector search, but it could not be loaded.",
        `Underlying error: ${detail}`,
        "Run `bun install` to install sqlite-vec.",
        "On macOS, install vanilla SQLite with `brew install sqlite`, or set TRIMEMH_SQLITE_DYLIB to libsqlite3.dylib.",
      ].join(" "),
    );
  }
}

// ─── Get or open database ──────────────────────────────────────────

export function getDb(dbPath: string): Database {
  if (db) {
    return db;
  }

  configureCustomSqlite();

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  const sqliteVecVersion = loadSqliteVec(db);
  console.log(`[triMemh] sqlite-vec ${sqliteVecVersion} loaded`);

  registerUdfCosineSimilarity(db);
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA temp_store = MEMORY;");
  db.run(`PRAGMA busy_timeout = ${CONFIG.db.busyTimeoutMs};`);
  db.run(`PRAGMA cache_size = ${CONFIG.db.cacheSizePages};`);
  db.run(`PRAGMA wal_autocheckpoint = ${CONFIG.db.walAutoCheckpointPages};`);
  db.run(`PRAGMA journal_size_limit = ${CONFIG.db.journalSizeLimitBytes};`);
  db.run(`PRAGMA mmap_size = ${CONFIG.db.mmapSizeBytes};`);

  return db;
}

// ─── Write transactions ───────────────────────────────────────────

export function withWriteTransaction<T>(database: Database, fn: () => T): T {
  const depth = writeTransactionDepth.get(database) ?? 0;
  if (depth > 0) {
    writeTransactionDepth.set(database, depth + 1);
    try {
      return fn();
    } finally {
      writeTransactionDepth.set(database, depth);
    }
  }

  writeTransactionDepth.set(database, 1);
  database.run("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    database.run("COMMIT;");
    return result;
  } catch (err) {
    try {
      database.run("ROLLBACK;");
    } finally {
      writeTransactionDepth.delete(database);
    }
    throw err;
  } finally {
    if ((writeTransactionDepth.get(database) ?? 0) === 1) {
      writeTransactionDepth.delete(database);
    }
  }
}

// ─── Close database ────────────────────────────────────────────────

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
