import type { Database } from "bun:sqlite";

import { recall } from "../application/recall-use-cases";
import type { TaskContextType } from "../context/compiler";
import type { CompressionPolicyInput } from "../context/compression-policy";
import { assembleMemoryContext } from "../context/context-runtime";
import type { EvidenceMode } from "../context/evidence";

const MEMORY_EVIDENCE_SECTION_RE =
  /<memory_evidence\b[\s\S]*?<\/memory_evidence>|<memory_evidence\b[^>]*\/>/;

export interface RetrievalEvalCase {
  id?: string;
  query: string;
  expected_memory_ids?: string[];
  expected_kinds?: string[];
  expected_text?: string[];
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
  expected_text: string[];
  result_ids: string[];
  result_kinds: string[];
  id_recall_at_k: number;
  kind_recall_at_k: number;
  text_recall_at_k: number;
  text_hits: string[];
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
    average_text_recall_at_k: number;
    average_combined_recall_at_k: number;
    /** @deprecated Use average_combined_recall_at_k. */
    average_recall_at_k: number;
    average_mrr: number;
    average_latency_ms: number;
  };
}

export interface ContextAccuracyEvalCase {
  id?: string;
  query: string;
  expected_memory_ids?: string[];
  expected_text?: string[];
  open_paths?: string[];
  task_type?: TaskContextType;
  model_context_tokens?: number;
  memory_context_budget_ratio?: number;
  evidence_mode?: EvidenceMode;
  retrieval_rounds?: number;
  compression_policy?: CompressionPolicyInput;
}

export interface ContextAccuracyEvalOptions {
  projectId: string;
  budgets?: number[];
}

export interface ContextAccuracyEvalCaseResult {
  id: string;
  query: string;
  model_context_tokens: number;
  expected_memory_ids: string[];
  expected_text: string[];
  selected_detail_ids: string[];
  evidence_memory_ids: string[];
  selected_id_recall: number;
  xml_text_recall: number;
  evidence_text_recall: number;
  text_hits: string[];
  evidence_text_hits: string[];
  estimated_prompt_tokens: number;
  budget_tokens: number;
  over_budget: boolean;
  evidence_span_count: number;
  retrieval_rounds: number;
  compression_policy_id: string;
  task_type: TaskContextType;
}

export interface ContextAccuracyEvalReport {
  cases: ContextAccuracyEvalCaseResult[];
  summary: {
    case_count: number;
    average_selected_id_recall: number;
    average_xml_text_recall: number;
    average_evidence_text_recall: number;
    average_estimated_prompt_tokens: number;
    over_budget_count: number;
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

function textHits(resultTexts: string[], expectedText: string[]): string[] {
  if (expectedText.length === 0) {
    return [];
  }
  const haystack = resultTexts.join("\n").toLowerCase();
  return expectedText.filter((text) => haystack.includes(text.toLowerCase()));
}

function evidenceSection(xml: string): string {
  const match = xml.match(MEMORY_EVIDENCE_SECTION_RE);
  return match?.[0] ?? "";
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
    const resultTexts = recalled.map((result) => result.item.text);
    const expectedIds = entry.expected_memory_ids ?? [];
    const expectedKinds = entry.expected_kinds ?? [];
    const expectedText = entry.expected_text ?? [];
    const idRecall = recallAtK(resultIds, expectedIds);
    const kindRecall = recallAtK(resultKinds, expectedKinds);
    const hits = textHits(resultTexts, expectedText);
    const textRecall = expectedText.length > 0 ? hits.length / expectedText.length : 0;
    const combinedRecall = combinedRecallAtK(resultIds, expectedIds, resultKinds, expectedKinds);

    return {
      id: entry.id ?? `case-${index + 1}`,
      query: entry.query,
      expected_memory_ids: expectedIds,
      expected_kinds: expectedKinds,
      expected_text: expectedText,
      result_ids: resultIds,
      result_kinds: resultKinds,
      id_recall_at_k: idRecall,
      kind_recall_at_k: kindRecall,
      text_recall_at_k: textRecall,
      text_hits: hits,
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
      average_text_recall_at_k:
        results.reduce((sum, item) => sum + item.text_recall_at_k, 0) / divisor,
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
    `average_text_recall_at_k: ${report.summary.average_text_recall_at_k.toFixed(3)}`,
    `average_combined_recall_at_k: ${report.summary.average_combined_recall_at_k.toFixed(3)}`,
    `average_mrr: ${report.summary.average_mrr.toFixed(3)}`,
    `average_latency_ms: ${report.summary.average_latency_ms.toFixed(3)}`,
    "",
    "| case | id_recall@k | kind_recall@k | text_recall@k | combined_recall@k | mrr | latency_ms | result_ids | text_hits |",
    "|---|---:|---:|---:|---:|---:|---:|---|---|",
  ];

  for (const item of report.cases) {
    lines.push(
      `| ${item.id} | ${item.id_recall_at_k.toFixed(3)} | ${item.kind_recall_at_k.toFixed(3)} | ${item.text_recall_at_k.toFixed(3)} | ${item.combined_recall_at_k.toFixed(3)} | ${item.mrr.toFixed(3)} | ${item.latency_ms.toFixed(3)} | ${item.result_ids.slice(0, 5).join(", ")} | ${item.text_hits.join(", ")} |`,
    );
  }
  return lines.join("\n");
}

export function runContextAccuracyEval(
  db: Database,
  cases: ContextAccuracyEvalCase[],
  options: ContextAccuracyEvalOptions,
): ContextAccuracyEvalReport {
  const results: ContextAccuracyEvalCaseResult[] = [];

  for (const entry of cases) {
    const budgets = options.budgets?.length
      ? options.budgets
      : [entry.model_context_tokens ?? 32_000];
    for (const budget of budgets) {
      const assembled = assembleMemoryContext({
        db,
        projectId: options.projectId,
        query: entry.query,
        openPaths: entry.open_paths ?? [],
        modelContextTokens: budget,
        taskType: entry.task_type,
        memoryContextBudgetRatio: entry.memory_context_budget_ratio,
        evidenceMode: entry.evidence_mode,
        retrievalRounds: entry.retrieval_rounds,
        compressionPolicy: entry.compression_policy,
      });
      const expectedIds = entry.expected_memory_ids ?? [];
      const expectedText = entry.expected_text ?? [];
      const xmlHits = textHits([assembled.xml], expectedText);
      const evidenceHits = textHits([evidenceSection(assembled.xml)], expectedText);

      results.push({
        id: `${entry.id ?? `case-${results.length + 1}`}@${budget}`,
        query: entry.query,
        model_context_tokens: budget,
        expected_memory_ids: expectedIds,
        expected_text: expectedText,
        selected_detail_ids: assembled.selectedDetailIds,
        evidence_memory_ids: assembled.evidenceMemoryIds,
        selected_id_recall: recallAtK(assembled.selectedDetailIds, expectedIds),
        xml_text_recall: expectedText.length > 0 ? xmlHits.length / expectedText.length : 0,
        evidence_text_recall:
          expectedText.length > 0 ? evidenceHits.length / expectedText.length : 0,
        text_hits: xmlHits,
        evidence_text_hits: evidenceHits,
        estimated_prompt_tokens: assembled.estimatedPromptTokens,
        budget_tokens: assembled.budgetTokens,
        over_budget: assembled.overBudget,
        evidence_span_count: assembled.evidenceSpanCount,
        retrieval_rounds: assembled.retrievalRounds,
        compression_policy_id: assembled.compressionPolicyId,
        task_type: assembled.taskType,
      });
    }
  }

  const divisor = results.length || 1;
  return {
    cases: results,
    summary: {
      case_count: results.length,
      average_selected_id_recall:
        results.reduce((sum, item) => sum + item.selected_id_recall, 0) / divisor,
      average_xml_text_recall:
        results.reduce((sum, item) => sum + item.xml_text_recall, 0) / divisor,
      average_evidence_text_recall:
        results.reduce((sum, item) => sum + item.evidence_text_recall, 0) / divisor,
      average_estimated_prompt_tokens:
        results.reduce((sum, item) => sum + item.estimated_prompt_tokens, 0) / divisor,
      over_budget_count: results.filter((item) => item.over_budget).length,
    },
  };
}

export function formatContextAccuracyEvalMarkdown(report: ContextAccuracyEvalReport): string {
  const lines = [
    "# triMemh Context Accuracy Eval",
    "",
    `cases: ${report.summary.case_count}`,
    `average_selected_id_recall: ${report.summary.average_selected_id_recall.toFixed(3)}`,
    `average_xml_text_recall: ${report.summary.average_xml_text_recall.toFixed(3)}`,
    `average_evidence_text_recall: ${report.summary.average_evidence_text_recall.toFixed(3)}`,
    `average_estimated_prompt_tokens: ${report.summary.average_estimated_prompt_tokens.toFixed(1)}`,
    `over_budget_count: ${report.summary.over_budget_count}`,
    "",
    "| case | selected_id_recall | xml_text_recall | evidence_text_recall | prompt_tokens | budget_tokens | over_budget | evidence_spans | retrieval_rounds |",
    "|---|---:|---:|---:|---:|---:|---|---:|---:|",
  ];

  for (const item of report.cases) {
    lines.push(
      `| ${item.id} | ${item.selected_id_recall.toFixed(3)} | ${item.xml_text_recall.toFixed(3)} | ${item.evidence_text_recall.toFixed(3)} | ${item.estimated_prompt_tokens} | ${item.budget_tokens} | ${item.over_budget} | ${item.evidence_span_count} | ${item.retrieval_rounds} |`,
    );
  }
  return lines.join("\n");
}
