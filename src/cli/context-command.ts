import type { Command } from "commander";

import { assembleMemoryContext } from "../context/context-runtime";
import { loadConfig } from "../infrastructure/config";
import { closeDb, getDb, runMigrations } from "../persistence/db";

function csv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description("Assemble progressive memory context XML for the current turn")
    .option("--query <text>", "Current task/query text for semantic and operational triggers")
    .option("--paths <csv>", "Comma-separated open code paths")
    .option("--lineage <csv>", "Comma-separated memory IDs to include one-turn lineage for")
    .option("--tokens <number>", "Model context window tokens", "32000")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      try {
        const assembled = assembleMemoryContext({
          db,
          projectId: config.projectId,
          query: opts.query,
          openPaths: csv(opts.paths),
          includeLineageForIds: csv(opts.lineage),
          modelContextTokens: parseInt(opts.tokens, 10),
        });
        console.log(assembled.xml);
        console.error(
          `[triMemh] selected details: ${assembled.selectedDetailIds.join(", ") || "none"}`,
        );
        if (assembled.overBudget) {
          console.error(
            "[triMemh] warning: memory context remains over budget after compaction/eviction.",
          );
        }
      } catch (err: unknown) {
        console.error(`[triMemh] Error: ${(err as Error).message}`);
        process.exit(1);
      }

      closeDb();
    });
}
