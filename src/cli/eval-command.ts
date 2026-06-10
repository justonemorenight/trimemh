import { readFileSync } from "node:fs";

import { Command } from "commander";

import {
  type ContextAccuracyEvalCase,
  type RetrievalEvalCase,
  formatContextAccuracyEvalMarkdown,
  formatRetrievalEvalMarkdown,
  runContextAccuracyEval,
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

function readContextDataset(path: string): ContextAccuracyEvalCase[] {
  return readDataset(path) as ContextAccuracyEvalCase[];
}

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseBudgets(value: string | undefined): number[] | undefined {
  if (!value) {
    return undefined;
  }
  const budgets = value
    .split(",")
    .map((entry) => parsePositiveInteger(entry.trim(), "--budgets"))
    .filter((entry) => entry > 0);
  if (budgets.length === 0) {
    throw new Error("--budgets must include at least one positive integer.");
  }
  return budgets;
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
    )
    .addCommand(
      new Command("context")
        .description("Evaluate assembled context accuracy against a JSON dataset")
        .requiredOption("--dataset <path>", "JSON dataset path")
        .option("--budgets <csv>", "Comma-separated model context windows, e.g. 4000,8000,32000")
        .option("--format <format>", "Output format: json or markdown", "json")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const cases = readContextDataset(opts.dataset);
            const report = runContextAccuracyEval(db, cases, {
              projectId: config.projectId,
              budgets: parseBudgets(opts.budgets),
            });

            if (opts.format === "markdown") {
              console.log(formatContextAccuracyEvalMarkdown(report));
            } else {
              console.log(JSON.stringify(report, null, 2));
            }
          }),
        ),
    );
}
