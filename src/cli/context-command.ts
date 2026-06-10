import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { TASK_CONTEXT_TYPES, type TaskContextType } from "../context/compiler";
import type { CompressionPolicyInput } from "../context/compression-policy";
import { assembleMemoryContext } from "../context/context-runtime";
import type { EvidenceMode } from "../context/evidence";
import { withDb } from "./with-db";

function csv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalRatio(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 0.5) {
    throw new Error("--memory-ratio must be a number between 0.01 and 0.5.");
  }
  return parsed;
}

function parseOptionalTaskType(value: string | undefined): TaskContextType | undefined {
  if (!value) {
    return undefined;
  }
  if (!TASK_CONTEXT_TYPES.includes(value as TaskContextType)) {
    throw new Error(`--task-type must be one of: ${TASK_CONTEXT_TYPES.join(", ")}`);
  }
  return value as TaskContextType;
}

function parseOptionalEvidenceMode(value: string | undefined): EvidenceMode | undefined {
  if (!value) {
    return undefined;
  }
  if (!["auto", "off", "force"].includes(value)) {
    throw new Error("--evidence-mode must be one of: auto, off, force.");
  }
  return value as EvidenceMode;
}

function parseOptionalRetrievalRounds(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) {
    throw new Error("--retrieval-rounds must be an integer between 1 and 3.");
  }
  return parsed;
}

function parseOptionalCompressionPolicy(
  value: string | undefined,
): CompressionPolicyInput | undefined {
  if (!value) {
    return undefined;
  }
  const raw = value.trim().startsWith("{") ? value : readFileSync(value, "utf-8");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--compression-policy must be a JSON object or path to a JSON object.");
  }
  return parsed as CompressionPolicyInput;
}

export function registerContextCommand(program: Command): void {
  program
    .command("context")
    .description("Assemble progressive memory context XML for the current turn")
    .option("--query <text>", "Current task/query text for semantic and operational triggers")
    .option("--paths <csv>", "Comma-separated open code paths")
    .option("--lineage <csv>", "Comma-separated memory IDs to include one-turn lineage for")
    .option("--tokens <number>", "Model context window tokens", "32000")
    .option("--task-type <type>", "Override adaptive task type")
    .option("--memory-ratio <number>", "Override memory context budget ratio (0.01-0.5)")
    .option("--evidence-mode <mode>", "Evidence-first mode: auto, off, force")
    .option("--retrieval-rounds <number>", "Semantic retrieval cascade rounds (1-3)")
    .option("--compression-policy <json_or_path>", "Compression/evidence policy JSON or file path")
    .option("--db <path>", "Custom database path")
    .option("--json", "Output JSON for editor integrations")
    .action(
      withDb((db, config, opts) => {
        const taskType = parseOptionalTaskType(opts.taskType);
        const memoryContextBudgetRatio = parseOptionalRatio(opts.memoryRatio);
        const evidenceMode = parseOptionalEvidenceMode(opts.evidenceMode);
        const retrievalRounds = parseOptionalRetrievalRounds(opts.retrievalRounds);
        const compressionPolicy = parseOptionalCompressionPolicy(opts.compressionPolicy);
        const assembled = assembleMemoryContext({
          db,
          projectId: config.projectId,
          query: opts.query,
          openPaths: csv(opts.paths),
          includeLineageForIds: csv(opts.lineage),
          modelContextTokens: parseInt(opts.tokens, 10),
          taskType,
          memoryContextBudgetRatio,
          evidenceMode,
          retrievalRounds,
          compressionPolicy,
        });
        const diagnostics = {
          selected_detail_ids: assembled.selectedDetailIds,
          lineage_ids: assembled.lineageIds,
          evicted: assembled.evicted,
          compacted_index: assembled.compactedIndex,
          over_budget: assembled.overBudget,
          task_type: assembled.taskType,
          budget_ratio: assembled.budgetRatio,
          budget_tokens: assembled.budgetTokens,
          estimated_prompt_tokens: assembled.estimatedPromptTokens,
          evidence_span_count: assembled.evidenceSpanCount,
          evidence_memory_ids: assembled.evidenceMemoryIds,
          retrieval_rounds: assembled.retrievalRounds,
          compression_policy_id: assembled.compressionPolicyId,
          pending_proposal_count: assembled.pendingProposalCount,
          ccr: assembled.ccrStats,
          prefix_changed: assembled.prefixChanged,
        };
        if (opts.json) {
          console.log(
            JSON.stringify({ success: true, data: { xml: assembled.xml, diagnostics } }, null, 2),
          );
          return;
        }
        console.log(assembled.xml);
        console.error(
          `[triMemh] selected details: ${assembled.selectedDetailIds.join(", ") || "none"}`,
        );
        console.error(
          `[triMemh] task_type=${assembled.taskType} budget_ratio=${assembled.budgetRatio} budget_tokens=${assembled.budgetTokens} estimated_prompt_tokens=${assembled.estimatedPromptTokens}`,
        );
        console.error(
          `[triMemh] evidence_spans=${assembled.evidenceSpanCount} evidence_memory_ids=${assembled.evidenceMemoryIds.join(",") || "none"} retrieval_rounds=${assembled.retrievalRounds} compression_policy=${assembled.compressionPolicyId}`,
        );
        if (assembled.overBudget) {
          console.error(
            "[triMemh] warning: memory context remains over budget after compaction/eviction.",
          );
        }
      }),
    );
}
