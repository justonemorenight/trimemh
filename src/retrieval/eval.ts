import type { Database } from "bun:sqlite";

import { recall } from "../application/recall-use-cases";

export interface RetrievalEvalCase {
  id?: string;
  query: string;
  expected_memory_ids?: string[];
  expected_kinds?: string[];
  open_paths?: string[];
}

export interface RetrievalEvalOptions {
  projectId: string;
  limit?: number;
  mode?: "fts" | "vector" | "hybrid";
}

export interface RetrievalEvalCaseResult {
  id: string;
  query: string;
  expected_memory_ids: string[];
  expected_kinds: string[];
  result_ids: string[];
  result_kinds: string[];
  id_recall_at_k: number;
  kind_recall_at_k: number;
  combined_recall_at_k: number;
  /** @deprecated Use combined_recall_at_k. */
  recall_at_k: number;
  mrr: number;
  latency_ms: number;
}

export interface RetrievalEvalReport {
  cases: RetrievalEvalCaseResult[];
  summary: {
    case_count: number;
    average_id_recall_at_k: number;
    average_kind_recall_at_k: number;
    average_combined_recall_at_k: number;
    /** @deprecated Use average_combined_recall_at_k. */
    average_recall_at_k: number;
    average_mrr: number;
    average_latency_ms: number;
  };
}

function reciprocalRank(resultIds: string[], expectedIds: string[]): number {
  if (expectedIds.length === 0) {
    return 0;
  }
  const expected = new Set(expectedIds);
  const index = resultIds.findIndex((id) => expected.has(id));
  return index >= 0 ? 1 / (index + 1) : 0;
}

function recallAtK(resultValues: string[], expectedValues: string[]): number {
  if (expectedValues.length === 0) {
    return 0;
  }
  const expected = new Set(expectedValues);
  const hits = resultValues.filter((value) => expected.has(value)).length;
  return hits / expectedValues.length;
}

function combinedRecallAtK(
  resultIds: string[],
  expectedIds: string[],
  resultKinds: string[],
  expectedKinds: string[],
): number {
  const denominator = expectedIds.length + expectedKinds.length;
  if (denominator === 0) {
    return 0;
  }
  const expectedIdSet = new Set(expectedIds);
  const idHits = resultIds.filter((id) => expectedIdSet.has(id)).length;
  const expectedKindSet = new Set(expectedKinds);
  const kindHits = resultKinds.filter((kind) => expectedKindSet.has(kind)).length;
  return (idHits + kindHits) / denominator;
}

export function runRetrievalEval(
  db: Database,
  cases: RetrievalEvalCase[],
  options: RetrievalEvalOptions,
): RetrievalEvalReport {
  const limit = options.limit ?? 5;
  const mode = options.mode ?? "hybrid";
  const results = cases.map((entry, index): RetrievalEvalCaseResult => {
    const started = performance.now();
    const recalled = recall(db, options.projectId, entry.query, limit, mode, null, null, {
      openPaths: entry.open_paths,
      rerank: false,
    });
    const latency = performance.now() - started;
    const resultIds = recalled.map((result) => result.item.id);
    const resultKinds = recalled.map((result) => result.item.kind);
    const expectedIds = entry.expected_memory_ids ?? [];
    const expectedKinds = entry.expected_kinds ?? [];
    const idRecall = recallAtK(resultIds, expectedIds);
    const kindRecall = recallAtK(resultKinds, expectedKinds);
    const combinedRecall = combinedRecallAtK(resultIds, expectedIds, resultKinds, expectedKinds);

    return {
      id: entry.id ?? `case-${index + 1}`,
      query: entry.query,
      expected_memory_ids: expectedIds,
      expected_kinds: expectedKinds,
      result_ids: resultIds,
      result_kinds: resultKinds,
      id_recall_at_k: idRecall,
      kind_recall_at_k: kindRecall,
      combined_recall_at_k: combinedRecall,
      recall_at_k: combinedRecall,
      mrr: reciprocalRank(resultIds, expectedIds),
      latency_ms: Number(latency.toFixed(3)),
    };
  });

  const divisor = results.length || 1;
  return {
    cases: results,
    summary: {
      case_count: results.length,
      average_id_recall_at_k: results.reduce((sum, item) => sum + item.id_recall_at_k, 0) / divisor,
      average_kind_recall_at_k:
        results.reduce((sum, item) => sum + item.kind_recall_at_k, 0) / divisor,
      average_combined_recall_at_k:
        results.reduce((sum, item) => sum + item.combined_recall_at_k, 0) / divisor,
      average_recall_at_k:
        results.reduce((sum, item) => sum + item.combined_recall_at_k, 0) / divisor,
      average_mrr: results.reduce((sum, item) => sum + item.mrr, 0) / divisor,
      average_latency_ms: results.reduce((sum, item) => sum + item.latency_ms, 0) / divisor,
    },
  };
}

export function formatRetrievalEvalMarkdown(report: RetrievalEvalReport): string {
  const lines = [
    "# triMemh Retrieval Eval",
    "",
    `cases: ${report.summary.case_count}`,
    `average_id_recall_at_k: ${report.summary.average_id_recall_at_k.toFixed(3)}`,
    `average_kind_recall_at_k: ${report.summary.average_kind_recall_at_k.toFixed(3)}`,
    `average_combined_recall_at_k: ${report.summary.average_combined_recall_at_k.toFixed(3)}`,
    `average_mrr: ${report.summary.average_mrr.toFixed(3)}`,
    `average_latency_ms: ${report.summary.average_latency_ms.toFixed(3)}`,
    "",
    "| case | id_recall@k | kind_recall@k | combined_recall@k | mrr | latency_ms | result_ids |",
    "|---|---:|---:|---:|---:|---:|---|",
  ];

  for (const item of report.cases) {
    lines.push(
      `| ${item.id} | ${item.id_recall_at_k.toFixed(3)} | ${item.kind_recall_at_k.toFixed(3)} | ${item.combined_recall_at_k.toFixed(3)} | ${item.mrr.toFixed(3)} | ${item.latency_ms.toFixed(3)} | ${item.result_ids.slice(0, 5).join(", ")} |`,
    );
  }
  return lines.join("\n");
}
