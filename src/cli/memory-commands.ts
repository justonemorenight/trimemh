import type { Command } from "commander";

import type { MemoryKind, Visibility } from "../domain/schema";
import { loadConfig } from "../infrastructure/config";
import { closeDb, getDb, runMigrations } from "../persistence/db";
import { forget, listAll, recall, remember } from "../service";

export function registerMemoryCommands(program: Command): void {
  // ─── init ─────────────────────────────────────────────────────────

  program
    .command("init")
    .description("Initialize memory database for the current project")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);
      console.log(`[triMemh] Initialized at ${dbPath}`);
      console.log(`[triMemh] Project ID: ${config.projectId}`);
      closeDb();
    });

  // ─── remember ─────────────────────────────────────────────────────

  program
    .command("remember")
    .description("Write a memory directly (low/medium risk only)")
    .requiredOption("--kind <kind>", "Memory kind: preference, fact, decision, etc.")
    .requiredOption("--text <text>", "Memory text content")
    .option("--confidence <number>", "Confidence 0-1", "0.5")
    .option("--visibility <visibility>", "private, team, or public", "private")
    .option("--source <source>", "Source label", "cli:user:explicit")
    .option("--expires <iso-date>", "Expiration date (ISO 8601)")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      try {
        const item = remember(db, {
          kind: opts.kind as MemoryKind,
          text: opts.text,
          projectId: config.projectId,
          confidence: parseFloat(opts.confidence),
          visibility: opts.visibility as Visibility,
          source: opts.source,
          expiresAt: opts.expires ?? undefined,
        });
        console.log(`[triMemh] Remembered: ${item.id}`);
        console.log(`  kind: ${item.kind}`);
        console.log(`  text: ${item.text.slice(0, 80)}${item.text.length > 80 ? "…" : ""}`);
      } catch (err: unknown) {
        console.error(`[triMemh] Error: ${(err as Error).message}`);
        process.exit(1);
      }

      closeDb();
    });

  // ─── recall ───────────────────────────────────────────────────────

  program
    .command("recall")
    .description("Search memories using FTS5")
    .argument("<query>", "Search query")
    .option("--limit <number>", "Max results", "10")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (query, opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      const results = recall(db, config.projectId, query, parseInt(opts.limit, 10));
      if (results.length === 0) {
        console.log("[triMemh] No memories found.");
      } else {
        for (const r of results) {
          console.log(`── ${r.item.id} (${r.item.kind}, confidence: ${r.item.confidence})`);
          console.log(`   ${r.snippet}`);
          console.log();
        }
      }

      closeDb();
    });

  // ─── list ─────────────────────────────────────────────────────────

  program
    .command("list")
    .description("List memories in current project")
    .option("--kind <kind>", "Filter by kind")
    .option("--status <status>", "Filter by status (active/archived/expired)")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      const items = listAll(db, config.projectId, opts.kind, opts.status);
      if (items.length === 0) {
        console.log("[triMemh] No memories found.");
      } else {
        for (const item of items) {
          const preview = item.text.replace(/\n/g, " ").slice(0, 100);
          console.log(
            `${item.id.slice(0, 8)} | ${item.kind.padEnd(16)} | ${item.status} | ${preview}${item.text.length > 100 ? "…" : ""}`,
          );
        }
        console.log(`\n[triMemh] ${items.length} memories total.`);
      }

      closeDb();
    });

  // ─── forget ───────────────────────────────────────────────────────

  program
    .command("forget")
    .description("Delete a memory by id")
    .argument("<id>", "Memory ID (or prefix)")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (id, opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      try {
        const deleted = forget(db, config.projectId, id);
        if (deleted) {
          console.log(`[triMemh] Forgotten: ${id}`);
        }
      } catch (err: unknown) {
        console.error(`[triMemh] Error: ${(err as Error).message}`);
        process.exit(1);
      }

      closeDb();
    });
}
