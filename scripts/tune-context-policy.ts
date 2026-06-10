import { readFileSync, writeFileSync } from "node:fs";

import type { CompressionPolicyInput } from "../src/context/compression-policy";
import { loadConfig } from "../src/infrastructure/config";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import type { ContextAccuracyEvalCase } from "../src/retrieval/eval";
import { runContextAccuracyEval } from "../src/retrieval/eval";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readDataset(path: string): ContextAccuracyEvalCase[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (Array.isArray(parsed)) {
    return parsed as ContextAccuracyEvalCase[];
  }
  if (Array.isArray(parsed.cases)) {
    return parsed.cases as ContextAccuracyEvalCase[];
  }
  throw new Error("Context dataset must be an array or an object with a cases array.");
}

function parseBudgets(value: string | undefined): number[] | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
}

const datasetPath = argValue("--dataset");
if (!datasetPath) {
  throw new Error(
    "Usage: bun scripts/tune-context-policy.ts --dataset <path> [--budgets 4000,8000,32000] [--out policy.json]",
  );
}

const budgets = parseBudgets(argValue("--budgets"));
const config = loadConfig();
const db = getDb(config.dbPath);
runMigrations(db);

const cases = readDataset(datasetPath);
const candidates: CompressionPolicyInput[] = [];
for (const evidenceMinScore of [0.1, 0.2, 0.35]) {
  for (const maxEvidenceSpans of [4, 6, 8]) {
    for (const queryTermWeight of [0.2, 0.3, 0.5]) {
      candidates.push({
        id: `evidence-v1-tuned-${evidenceMinScore}-${maxEvidenceSpans}-${queryTermWeight}`,
        evidenceMinScore,
        maxEvidenceSpans,
        queryTermWeight,
      });
    }
  }
}

let best: {
  policy: CompressionPolicyInput;
  score: number;
  metrics: ReturnType<typeof runContextAccuracyEval>["summary"];
} | null = null;

for (const policy of candidates) {
  const report = runContextAccuracyEval(
    db,
    cases.map((entry) => ({ ...entry, compression_policy: policy })),
    { projectId: config.projectId, budgets },
  );
  const score =
    report.summary.average_xml_text_recall +
    report.summary.average_evidence_text_recall -
    report.summary.average_estimated_prompt_tokens * 0.0005 -
    report.summary.over_budget_count * 0.2;
  if (!best || score > best.score) {
    best = { policy, score, metrics: report.summary };
  }
}

closeDb();

const output = JSON.stringify(best, null, 2);
const outPath = argValue("--out");
if (outPath) {
  writeFileSync(outPath, `${output}\n`);
} else {
  console.log(output);
}
