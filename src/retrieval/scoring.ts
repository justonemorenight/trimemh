/**
 * Multi-Factor Recall Scoring (Phase 2 — Intelligence Upgrade)
 *
 * Inspired by Engram's weighted recall scoring formula:
 *   (similarity × 0.45) + (recency × 0.15) + (confidence × 0.15)
 *   + (access × 0.05) + (feedback × 0.10) + fts_boost
 *
 * Extended for tri-memory with governance-aware risk boosting,
 * graph-proximity signals, and configurable weight profiles.
 */

import type { MemoryItem, MemoryKind, RiskLevel } from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";

// ─── Types ──────────────────────────────────────────────────────────

export interface RecallScoreInput {
  /** Cosine similarity from vector search (0-1). */
  similarity: number;
  /** FTS5 lexical match rank (1-based; lower = better). 0 if no lexical match. */
  ftsRank: number;
  /** The memory item being scored. */
  item: MemoryItem;
  /** How many times this memory has been accessed (search hits). */
  accessCount: number;
  /** User feedback score accumulated (-1 to +1). */
  feedbackScore: number;
  /** Number of graph edges connected to this memory. */
  graphDegree: number;
  /** Whether the memory belongs to a currently open code path. */
  isCodePathMatch: boolean;
  /** Whether this is an operational/security-critical context. */
  isOperationalContext: boolean;
}

export interface RecallScoreResult {
  /** Weighted composite score (higher = more relevant). */
  compositeScore: number;
  /** Individual factor contributions for explainability. */
  factors: {
    similarity: number;
    recency: number;
    confidence: number;
    access: number;
    feedback: number;
    ftsBoost: number;
    riskBoost: number;
    graphBoost: number;
    codePathBoost: number;
  };
}

// ─── Configurable weight profiles ───────────────────────────────────

export interface ScoreWeights {
  similarity: number;
  recency: number;
  confidence: number;
  access: number;
  feedback: number;
  ftsBoost: number;
  riskBoost: number;
  graphBoost: number;
  codePathBoost: number;
}

/** Default weights (Engram-inspired). Sum = 1.0 for explainability. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  similarity: 0.4,
  recency: 0.15,
  confidence: 0.12,
  access: 0.05,
  feedback: 0.08,
  ftsBoost: 0.1,
  riskBoost: 0.05,
  graphBoost: 0.03,
  codePathBoost: 0.02,
};

/** Code-review profile: higher risk + confidence weights. */
export const CODE_REVIEW_WEIGHTS: ScoreWeights = {
  similarity: 0.3,
  recency: 0.1,
  confidence: 0.15,
  access: 0.05,
  feedback: 0.1,
  ftsBoost: 0.1,
  riskBoost: 0.1, // higher — security rules matter more
  graphBoost: 0.05,
  codePathBoost: 0.05, // higher — code links matter more
};

/** Planning profile: recency + graph signals dominate. */
export const PLANNING_WEIGHTS: ScoreWeights = {
  similarity: 0.25,
  recency: 0.2, // higher — recent decisions matter
  confidence: 0.1,
  access: 0.05,
  feedback: 0.1,
  ftsBoost: 0.1,
  riskBoost: 0.05,
  graphBoost: 0.1, // higher — decision chains matter
  codePathBoost: 0.05,
};

// ─── Scoring functions ──────────────────────────────────────────────

const RISK_BOOST: Record<RiskLevel, number> = {
  critical: 1.0,
  high: 0.7,
  medium: 0.3,
  low: 0.0,
};

/**
 * Compute a recency score based on the memory's age.
 * Exponential decay: score = e^(-age_days / halfLife)
 * - 1 day old  → score ≈ 0.93
 * - 7 days old → score ≈ 0.61
 * - 30 days old → score ≈ 0.14
 */
function recencyScore(createdAt: string, updatedAt: string): number {
  const now = Date.now();
  const created = new Date(createdAt).getTime();
  const updated = new Date(updatedAt).getTime();
  // Use the more recent of created/updated
  const latest = Math.max(created, updated);
  const ageHours = (now - latest) / (1000 * 60 * 60);
  const halfLife = 168; // 7 days in hours
  return Math.exp(-ageHours / halfLife);
}

/**
 * Compute a risk-based boost for governance-aware recall.
 * Critical/High-risk memories get priority in security-sensitive contexts.
 */
function riskBoost(kind: MemoryKind, isOperationalContext: boolean): number {
  const risk = KIND_RISK_MAP[kind];
  const base = RISK_BOOST[risk];
  // In operational context, critical/security_rules get double boost
  if (isOperationalContext && (risk === "critical" || risk === "high")) {
    return Math.min(1.0, base * 1.5);
  }
  return base;
}

/**
 * Normalize FTS5 rank into a boost factor (0-1).
 * rank 1 → 1.0, rank 5 → 0.5, rank 10 → 0.1, not in results → 0.
 */
function ftsRankBoost(rank: number): number {
  if (rank <= 0) {
    return 0;
  }
  if (rank === 1) {
    return 1.0;
  }
  return 1.0 / (1 + Math.log(rank));
}

/**
 * Graph degree boost — memories with more connections are likely more important.
 * Normalized: 0 edges → 0, 5+ edges → 0.3 (capped).
 */
function graphBoost(degree: number): number {
  return Math.min(0.3, Math.log(1 + degree) * 0.15);
}

/**
 * Compute weighted composite recall score for a single memory candidate.
 */
export function scoreRecall(
  input: RecallScoreInput,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): RecallScoreResult {
  const recency = recencyScore(input.item.created_at, input.item.updated_at);
  const confidence = input.item.confidence;
  const accessNorm = Math.min(1.0, Math.log(1 + input.accessCount) * 0.2);
  const feedbackNorm = Math.max(0, Math.min(1, (input.feedbackScore + 1) / 2));
  const ftsB = ftsRankBoost(input.ftsRank);
  const riskB = riskBoost(input.item.kind, input.isOperationalContext);
  const graphB = graphBoost(input.graphDegree);
  const codePathB = input.isCodePathMatch ? 1.0 : 0.0;

  const compositeScore =
    input.similarity * weights.similarity +
    recency * weights.recency +
    confidence * weights.confidence +
    accessNorm * weights.access +
    feedbackNorm * weights.feedback +
    ftsB * weights.ftsBoost +
    riskB * weights.riskBoost +
    graphB * weights.graphBoost +
    codePathB * weights.codePathBoost;

  return {
    compositeScore: Math.round(compositeScore * 10_000) / 10_000,
    factors: {
      similarity: Math.round(input.similarity * 10_000) / 10_000,
      recency: Math.round(recency * 10_000) / 10_000,
      confidence: Math.round(confidence * 10_000) / 10_000,
      access: Math.round(accessNorm * 10_000) / 10_000,
      feedback: Math.round(feedbackNorm * 10_000) / 10_000,
      ftsBoost: Math.round(ftsB * 10_000) / 10_000,
      riskBoost: Math.round(riskB * 10_000) / 10_000,
      graphBoost: Math.round(graphB * 10_000) / 10_000,
      codePathBoost: Math.round(codePathB * 10_000) / 10_000,
    },
  };
}

/**
 * Batch score and rank multiple recall candidates.
 */
export function rankRecallResults(
  candidates: RecallScoreInput[],
  weights?: ScoreWeights,
): Array<RecallScoreInput & RecallScoreResult> {
  const scored = candidates.map((c) => ({
    ...c,
    ...scoreRecall(c, weights),
  }));
  return scored.sort((a, b) => b.compositeScore - a.compositeScore);
}

// ─── Profile selection ──────────────────────────────────────────────

import type { TaskContextType } from "../context/compiler";

/**
 * Select scoring weight profile based on task context type.
 */
export function selectWeights(taskType: TaskContextType): ScoreWeights {
  switch (taskType) {
    case "code_review":
      return CODE_REVIEW_WEIGHTS;
    case "planning":
      return PLANNING_WEIGHTS;
    default:
      return DEFAULT_WEIGHTS;
  }
}
