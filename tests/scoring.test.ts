import { describe, expect, test } from "bun:test";

import type { RecallScoreInput } from "../src/retrieval/scoring";
import {
  CODE_REVIEW_WEIGHTS,
  DEFAULT_WEIGHTS,
  PLANNING_WEIGHTS,
  rankRecallResults,
  scoreRecall,
  selectWeights,
} from "../src/retrieval/scoring";

function makeInput(overrides: Partial<RecallScoreInput> = {}): RecallScoreInput {
  return {
    similarity: 0.85,
    ftsRank: 3,
    item: {
      id: "mem-1",
      project_id: "test",
      kind: "fact",
      text: "test memory",
      status: "active",
      visibility: "private",
      confidence: 0.8,
      source: "test",
      content_hash: "abc123",
      evidence_json: "[]",
      metadata_json: "{}",
      embedding: null,
      created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      expires_at: null,
      ...overrides.item,
    },
    accessCount: 5,
    feedbackScore: 0.3,
    graphDegree: 2,
    isCodePathMatch: false,
    isOperationalContext: false,
    ...overrides,
  };
}

describe("scoreRecall", () => {
  test("returns composite score and factor breakdown", () => {
    const result = scoreRecall(makeInput());
    expect(result.compositeScore).toBeGreaterThan(0);
    expect(result.compositeScore).toBeLessThanOrEqual(1);
    expect(result.factors.similarity).toBeCloseTo(0.85);
    expect(result.factors.confidence).toBeCloseTo(0.8);
    expect(result.factors.recency).toBeGreaterThan(0);
    expect(result.factors.ftsBoost).toBeGreaterThan(0);
  });

  test("higher similarity produces higher score", () => {
    const high = scoreRecall(makeInput({ similarity: 0.95 }));
    const low = scoreRecall(makeInput({ similarity: 0.3 }));
    expect(high.compositeScore).toBeGreaterThan(low.compositeScore);
  });

  test("higher confidence produces higher score", () => {
    const baseItem = {
      id: "mem-2",
      project_id: "test",
      kind: "fact" as const,
      text: "t",
      status: "active" as const,
      visibility: "private" as const,
      confidence: 0.8,
      source: "test",
      content_hash: "xyz",
      evidence_json: "[]",
      metadata_json: "{}",
      embedding: null,
      created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      updated_at: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
      expires_at: null,
    };
    const high = scoreRecall(makeInput({ item: { ...baseItem, confidence: 0.95 } }));
    const low = scoreRecall(makeInput({ item: { ...baseItem, confidence: 0.1 } }));
    expect(high.compositeScore).toBeGreaterThan(low.compositeScore);
  });

  test("code path match gives boost", () => {
    const matched = scoreRecall(makeInput({ isCodePathMatch: true }));
    const unmatched = scoreRecall(makeInput({ isCodePathMatch: false }));
    expect(matched.factors.codePathBoost).toBeGreaterThan(unmatched.factors.codePathBoost);
  });

  test("operational context boosts critical/security rules", () => {
    const baseItem = {
      id: "mem-3",
      project_id: "test",
      text: "t",
      status: "active" as const,
      visibility: "private" as const,
      confidence: 0.5,
      source: "test",
      content_hash: "xyz",
      evidence_json: "[]",
      metadata_json: "{}",
      embedding: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: null,
    };
    const critical = scoreRecall(
      makeInput({
        // biome-ignore lint/suspicious/noExplicitAny: warning suppression
        item: { ...baseItem, kind: "security_rule" } as any,
        isOperationalContext: true,
      }),
    );
    const fact = scoreRecall(
      makeInput({
        // biome-ignore lint/suspicious/noExplicitAny: warning suppression
        item: { ...baseItem, kind: "fact" } as any,
        isOperationalContext: true,
      }),
    );
    expect(critical.factors.riskBoost).toBeGreaterThan(fact.factors.riskBoost);
  });

  test("better FTS rank gives higher boost", () => {
    const rank1 = scoreRecall(makeInput({ ftsRank: 1 }));
    const rank10 = scoreRecall(makeInput({ ftsRank: 10 }));
    expect(rank1.factors.ftsBoost).toBeGreaterThan(rank10.factors.ftsBoost);
  });

  test("no FTS match gives zero boost", () => {
    const noMatch = scoreRecall(makeInput({ ftsRank: 0 }));
    expect(noMatch.factors.ftsBoost).toBe(0);
  });
});

describe("rankRecallResults", () => {
  test("sorts by composite score descending", () => {
    const candidates = [
      makeInput({ similarity: 0.3 }),
      makeInput({ similarity: 0.9 }),
      makeInput({ similarity: 0.6 }),
    ];
    const ranked = rankRecallResults(candidates);
    expect(ranked[0]?.compositeScore).toBeGreaterThanOrEqual(ranked[1]?.compositeScore);
    expect(ranked[1]?.compositeScore).toBeGreaterThanOrEqual(ranked[2]?.compositeScore);
  });
});

describe("selectWeights", () => {
  test("returns code review weights for code_review task", () => {
    const weights = selectWeights("code_review");
    expect(weights.similarity).toBe(CODE_REVIEW_WEIGHTS.similarity);
    expect(weights.riskBoost).toBe(CODE_REVIEW_WEIGHTS.riskBoost);
  });

  test("returns planning weights for planning task", () => {
    const weights = selectWeights("planning");
    expect(weights.recency).toBe(PLANNING_WEIGHTS.recency);
    expect(weights.graphBoost).toBe(PLANNING_WEIGHTS.graphBoost);
  });

  test("returns default weights for unknown task", () => {
    const weights = selectWeights("unknown");
    expect(weights).toEqual(DEFAULT_WEIGHTS);
  });
});
