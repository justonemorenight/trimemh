import type { Database } from "bun:sqlite";

import type { TriMemhConfig } from "../domain/schema";
import { loadConfig } from "../infrastructure/config";
import { closeDb, getDb, runMigrations } from "../persistence/db";

/**
 * Commander action wrapper that bootstraps the DB connection, runs migrations,
 * and tears down automatically. Eliminates the repeated boilerplate:
 *
 *   const config = loadConfig();
 *   const dbPath = opts.db ?? config.dbPath;
 *   const db = getDb(dbPath);
 *   runMigrations(db);
 *   // ... work ...
 *   closeDb();
 *
 * Usage:
 *   .action(withDb((db, config, opts) => { ... }))
 *   .action(withDb((db, config, positional, opts) => { ... }))
 *
 * The Commander `opts` object is always the **last** argument.
 * Errors are logged and process.exit(1) is called automatically.
 */
type DbAction<Args extends unknown[]> = (
  db: Database,
  config: TriMemhConfig,
  ...args: Args
) => Promise<void> | void;

export function withDb<Args extends unknown[]>(
  action: DbAction<Args>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    const opts = (args[args.length - 1] ?? {}) as { db?: string };
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    try {
      await action(db, config, ...args);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      closeDb();
    }
  };
}
