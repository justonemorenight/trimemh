import { readFileSync } from "node:fs";

import { Command } from "commander";

import {
  type RetrievalEvalCase,
  formatRetrievalEvalMarkdown,
  runRetrievalEval,
} from "../retrieval/eval";
import { withDb } from "./with-db";

function readDataset(path: string): RetrievalEvalCase[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed as RetrievalEvalCase[];
  }
  if (Array.isArray(parsed.cases)) {
    return parsed.cases as RetrievalEvalCase[];
  }
  throw new Error("Retrieval dataset must be an array or an object with a cases array.");
}

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

export function registerEvalCommand(program: Command): void {
  program
    .command("eval")
    .description("Evaluation harnesses")
    .addCommand(
      new Command("retrieval")
        .description("Evaluate retrieval quality against a JSON dataset")
        .requiredOption("--dataset <path>", "JSON dataset path")
        .option("--limit <number>", "Recall limit", "5")
        .option("--mode <mode>", "Retrieval mode: fts, vector, hybrid", "hybrid")
        .option("--format <format>", "Output format: json or markdown", "json")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const cases = readDataset(opts.dataset);
            const report = runRetrievalEval(db, cases, {
              projectId: config.projectId,
              limit: parsePositiveInteger(opts.limit, "--limit"),
              mode: opts.mode,
            });

            if (opts.format === "markdown") {
              console.log(formatRetrievalEvalMarkdown(report));
            } else {
              console.log(JSON.stringify(report, null, 2));
            }
          }),
        ),
    );
}
