import type { Command } from "commander";

import type { MemoryKind, Visibility } from "../domain/schema";
import { forget, listAll, recall, remember } from "../service";
import { withDb } from "./with-db";

export function registerMemoryCommands(program: Command): void {
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
    .option("--json", "Output JSON for editor integrations")
    .action(
      withDb((db, config, opts) => {
        const item = remember(db, {
          kind: opts.kind as MemoryKind,
          text: opts.text,
          projectId: config.projectId,
          confidence: parseFloat(opts.confidence),
          visibility: opts.visibility as Visibility,
          source: opts.source,
          expiresAt: opts.expires ?? undefined,
        });
        if (opts.json) {
          console.log(JSON.stringify({ success: true, data: item }, null, 2));
          return;
        }
        console.log(`[triMemh] Remembered: ${item.id}`);
        console.log(`  kind: ${item.kind}`);
        console.log(`  text: ${item.text.slice(0, 80)}${item.text.length > 80 ? "…" : ""}`);
      }),
    );

  // ─── recall ───────────────────────────────────────────────────────

  program
    .command("recall")
    .description("Search memories using FTS5")
    .argument("<query>", "Search query")
    .option("--limit <number>", "Max results", "10")
    .option("--db <path>", "Custom database path")
    .option("--json", "Output JSON for editor integrations")
    .action(
      withDb((db, config, query, opts) => {
        const memoryResults = recall(db, config.projectId, query, parseInt(opts.limit, 10));
        if (opts.json) {
          console.log(JSON.stringify({ success: true, data: memoryResults }, null, 2));
          return;
        }
        if (memoryResults.length === 0) {
          console.log("[triMemh] No memories found.");
        } else {
          for (const result of memoryResults) {
            console.log(
              `── ${result.item.id} (${result.item.kind}, confidence: ${result.item.confidence})`,
            );
            console.log(`   ${result.snippet}`);
            console.log();
          }
        }
      }),
    );

  // ─── list ─────────────────────────────────────────────────────────

  program
    .command("list")
    .description("List memories in current project")
    .option("--kind <kind>", "Filter by kind")
    .option("--status <status>", "Filter by status (active/archived/expired)")
    .option("--db <path>", "Custom database path")
    .option("--json", "Output JSON for editor integrations")
    .action(
      withDb((db, config, opts) => {
        const items = listAll(db, config.projectId, opts.kind, opts.status);
        if (opts.json) {
          console.log(JSON.stringify({ success: true, data: items }, null, 2));
          return;
        }
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
      }),
    );

  // ─── forget ───────────────────────────────────────────────────────

  program
    .command("forget")
    .description("Delete a memory by id")
    .argument("<id>", "Memory ID (or prefix)")
    .option("--db <path>", "Custom database path")
    .option("--json", "Output JSON for editor integrations")
    .action(
      withDb((db, config, id, opts) => {
        const deleted = forget(db, config.projectId, id);
        if (opts.json) {
          console.log(JSON.stringify({ success: true, data: { deleted, id } }, null, 2));
          return;
        }
        if (deleted) {
          console.log(`[triMemh] Forgotten: ${id}`);
        }
      }),
    );
}
