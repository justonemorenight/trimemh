import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { applyLearnings, mineFailures } from "../learning/learn";
import { withDb } from "./with-db";

export function registerLearnCommand(program: Command): void {
  program
    .command("learn")
    .description("Mine failed agent sessions and propose memory corrections")
    .argument("<file>", "Path to conversation log (JSONL or plain text)")
    .option(
      "--auto-approve <level>",
      "Auto-approve up to this risk level (low/medium/high/critical)",
      "low",
    )
    .option(
      "--min-confidence <number>",
      "Minimum confidence for a failure to trigger correction (0-1)",
      "0.5",
    )
    .option("--max-corrections <number>", "Max corrections to propose", "10")
    .option("--dry-run", "Analyze but don't apply any corrections")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, file, opts) => {
        let raw: string;
        try {
          raw = readFileSync(file, "utf-8");
        } catch {
          console.error(`[triMemh] Cannot read file: ${file}`);
          process.exit(1);
        }

        const result = mineFailures(raw, {
          autoApproveUpTo: opts.autoApprove,
          minConfidence: parseFloat(opts.minConfidence),
          maxCorrections: parseInt(opts.maxCorrections, 10),
        });

        console.log("[triMemh] Session analysis complete:");
        console.log(`  Failures detected: ${result.failuresDetected}`);
        console.log(`  Recovery pairs: ${result.recoveryPairsDetected}`);
        console.log(`  Corrections proposed: ${result.correctionsProposed}`);

        for (const correction of result.corrections) {
          console.log(
            `\n  [${correction.risk.toUpperCase()}] ${correction.action}: ${correction.proposedText.slice(0, 100)}...`,
          );
          console.log(`    Rationale: ${correction.rationale}`);
          if (
            correction.evidence.includes("Failed:") &&
            correction.evidence.includes("Recovered:")
          ) {
            console.log(`    Pattern: recovery (failed → successful action)`);
          }
        }

        if (opts.dryRun) {
          console.log("\n[triMemh] Dry run — no corrections applied.");
          return;
        }

        const applied = applyLearnings(db, config.projectId, result, {
          autoApproveUpTo: opts.autoApprove,
        });

        console.log(
          `\n[triMemh] Applied: ${applied.applied} auto-approved, ${applied.proposed} pending approval.`,
        );
        if (applied.proposed > 0) {
          console.log("[triMemh] Review pending proposals with: trimemh proposals");
        }
      }),
    );
}
