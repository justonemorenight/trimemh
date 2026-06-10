import { CONFIG } from "../config";

export const COMPRESSION_POLICY_ID = "evidence-v1";

export const EVIDENCE_LABELS = [
  "fact",
  "decision",
  "constraint",
  "open_question",
  "failure_mode",
] as const;

export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

export interface CompressionPolicyInput {
  id?: string;
  evidenceMinScore?: number;
  maxEvidenceSpans?: number;
  queryTermWeight?: number;
  tokenPenalty?: number;
  overBudgetPenalty?: number;
  labelWeights?: Partial<Record<EvidenceLabel, number>>;
}

export interface ResolvedCompressionPolicy {
  id: string;
  evidenceMinScore: number;
  maxEvidenceSpans: number;
  queryTermWeight: number;
  tokenPenalty: number;
  overBudgetPenalty: number;
  labelWeights: Record<EvidenceLabel, number>;
}

const DEFAULT_LABEL_WEIGHTS: Record<EvidenceLabel, number> = {
  fact: 0.8,
  decision: 1.15,
  constraint: 1.1,
  open_question: 0.75,
  failure_mode: 1.05,
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function resolveCompressionPolicy(
  input?: CompressionPolicyInput | null,
): ResolvedCompressionPolicy {
  const maxEvidenceSpans = Math.max(
    1,
    Math.min(
      20,
      Math.floor(finiteOr(input?.maxEvidenceSpans, CONFIG.chunking.maxDetailChunks + 3)),
    ),
  );

  return {
    id: input?.id?.trim() || COMPRESSION_POLICY_ID,
    evidenceMinScore: clamp(finiteOr(input?.evidenceMinScore, 0.2), 0, 10),
    maxEvidenceSpans,
    queryTermWeight: clamp(finiteOr(input?.queryTermWeight, 0.3), 0, 3),
    tokenPenalty: clamp(finiteOr(input?.tokenPenalty, 0.002), 0, 1),
    overBudgetPenalty: clamp(finiteOr(input?.overBudgetPenalty, 0.2), 0, 10),
    labelWeights: {
      fact: finiteOr(input?.labelWeights?.fact, DEFAULT_LABEL_WEIGHTS.fact),
      decision: finiteOr(input?.labelWeights?.decision, DEFAULT_LABEL_WEIGHTS.decision),
      constraint: finiteOr(input?.labelWeights?.constraint, DEFAULT_LABEL_WEIGHTS.constraint),
      open_question: finiteOr(
        input?.labelWeights?.open_question,
        DEFAULT_LABEL_WEIGHTS.open_question,
      ),
      failure_mode: finiteOr(input?.labelWeights?.failure_mode, DEFAULT_LABEL_WEIGHTS.failure_mode),
    },
  };
}
