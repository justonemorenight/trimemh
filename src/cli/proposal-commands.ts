import type { Command } from "commander";

import type { MemoryKind } from "../domain/schema";
import { loadConfig } from "../infrastructure/config";
import { closeDb, getDb, runMigrations } from "../persistence/db";
import { approve, propose, reject, status } from "../service";

export function registerProposalCommands(program: Command): void {
  // ─── propose ──────────────────────────────────────────────────────

  program
    .command("propose")
    .description("Create a pending proposal (for agent/reflect use)")
    .requiredOption("--kind <kind>", "Memory kind")
    .requiredOption("--text <text>", "Proposed memory text")
    .option("--by <source>", "Who proposed this", "cli:user")
    .option("--rationale <text>", "Why this memory should exist")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      const p = propose(db, {
        kind: opts.kind as MemoryKind,
        text: opts.text,
        projectId: config.projectId,
        proposedBy: opts.by,
        rationale: opts.rationale,
      });

      console.log(`[triMemh] Proposal created: ${p.id}`);
      console.log(`  kind: ${p.proposed_kind}`);
      console.log(`  risk: ${p.risk_level}`);
      console.log(`  status: ${p.status}`);
      console.log(
        `  Use "tritrimemh approve ${p.id.slice(0, 8)}" to accept or "tritrimemh reject ${p.id.slice(0, 8)}" to decline.`,
      );

      closeDb();
    });

  // ─── approve ──────────────────────────────────────────────────────

  program
    .command("approve")
    .description("Approve a pending proposal")
    .argument("<proposal-id>", "Proposal ID (or prefix)")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (proposalId, opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      try {
        const item = approve(db, config.projectId, proposalId, "user");
        if (item) {
          console.log(`[triMemh] Approved and created memory: ${item.id}`);
          console.log(`  kind: ${item.kind}`);
        } else {
          console.log("[triMemh] Approved (delete action — no new memory).");
        }
      } catch (err: unknown) {
        console.error(`[triMemh] Error: ${(err as Error).message}`);
        process.exit(1);
      }

      closeDb();
    });

  // ─── reject ───────────────────────────────────────────────────────

  program
    .command("reject")
    .description("Reject a pending proposal")
    .argument("<proposal-id>", "Proposal ID (or prefix)")
    .option("--note <text>", "Reason for rejection", "Rejected by user")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (proposalId, opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      try {
        const p = reject(db, config.projectId, proposalId, opts.note, "user");
        console.log(`[triMemh] Rejected: ${p.id}`);
        console.log(`  note: ${p.decision_note}`);
      } catch (err: unknown) {
        console.error(`[triMemh] Error: ${(err as Error).message}`);
        process.exit(1);
      }

      closeDb();
    });

  // ─── status ───────────────────────────────────────────────────────

  program
    .command("status")
    .description("Show memory statistics and pending proposals")
    .option("--db <path>", "Custom database path")
    // biome-ignore lint/suspicious/useAwait: warning suppression
    .action(async (opts) => {
      const config = loadConfig();
      const dbPath = opts.db ?? config.dbPath;
      const db = getDb(dbPath);
      runMigrations(db);

      const s = status(db, config.projectId);
      console.log(`[triMemh] Project: ${config.projectId}`);
      console.log(`[triMemh] DB path: ${dbPath}`);
      console.log();
      console.log("── Stats ──");
      console.log(`  Total active memories: ${s.stats.total}`);
      console.log(`  Pending proposals:    ${s.stats.pendingProposals}`);
      console.log("  By kind:", s.stats.byKind);
      console.log("  By status:", s.stats.byStatus);

      if (s.pendingProposals.length > 0) {
        console.log();
        console.log("── Pending Proposals ──");
        for (const p of s.pendingProposals) {
          const preview = p.proposed_text.replace(/\n/g, " ").slice(0, 80);
          console.log(
            `  ${p.id.slice(0, 8)} | ${p.risk_level.padEnd(8)} | ${p.proposed_kind.padEnd(16)} | ${preview}…`,
          );
        }
      }

      console.log();
      console.log("── Recent Audit (last 5) ──");
      for (const e of s.recentAudit.slice(0, 5)) {
        console.log(
          `  ${e.created_at.slice(0, 19)} | ${e.event_type.padEnd(18)} | ${e.entity_type}:${e.entity_id.slice(0, 8)}`,
        );
      }

      closeDb();
    });
}
