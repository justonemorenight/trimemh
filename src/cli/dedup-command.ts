import type { Command } from "commander";

import { loadConfig } from "../infrastructure/config";
import { closeDb, getDb, runMigrations } from "../persistence/db";
import { dedupMerge, dedupScan } from "../service";

export function registerDedupCommand(program: Command): void {
  program
    .command("dedup")
    .description("Scan for near-duplicate memories using semantic similarity")
    .option("--db <path>", "Custom database path")
    .option("--threshold <number>", "Cosine similarity threshold (0-1)", "0.90")
    .option("--fix", "Auto-merge near-duplicates (older kept, newer merged)")
    .option("--dry-run", "Show what would be merged without executing")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      const threshold = parseFloat(opts.threshold);
      if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
        console.error("[triMemh] Invalid threshold. Must be between 0 and 1.");
        closeDb();
        process.exit(1);
      }

      const report = dedupScan(db, config.projectId, threshold);

      console.log(`[triMemh] Project: ${config.projectId}`);
      console.log(`[triMemh] Memories with embeddings: ${report.totalMemoriesWithEmbeddings}`);
      console.log(`[triMemh] Threshold: ${report.threshold}`);
      console.log(`[triMemh] Near-duplicate pairs found: ${report.pairs.length}`);
      console.log();

      if (report.pairs.length === 0) {
        console.log("No near-duplicates detected.");
        closeDb();
        return;
      }

      for (const pair of report.pairs) {
        console.log(`── ${(pair.similarity * 100).toFixed(1)}% similar ──`);
        console.log(
          `  A [${pair.memoryA.kind}] ${pair.memoryA.id.slice(0, 8)}: ${pair.memoryA.text}…`,
        );
        console.log(
          `  B [${pair.memoryB.kind}] ${pair.memoryB.id.slice(0, 8)}: ${pair.memoryB.text}…`,
        );
        console.log();
      }

      if (opts.fix && !opts.dryRun) {
        console.log("── Merging near-duplicates ──");
        for (const pair of report.pairs) {
          try {
            const merged = dedupMerge(db, config.projectId, pair.memoryB.id, pair.memoryA.id);
            console.log(`  Merged ${pair.memoryB.id.slice(0, 8)} → ${merged.id.slice(0, 8)}`);
          } catch (err) {
            console.error(`  Failed: ${(err as Error).message}`);
          }
        }
      } else if (opts.fix && opts.dryRun) {
        console.log("── Dry run (no changes made) ──");
      }

      closeDb();
    });
}
