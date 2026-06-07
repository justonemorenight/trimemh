import { describe, expect, test } from "bun:test";

import {
  buildClaudeReviewCommand,
  parseClaudeReviewOutput,
} from "../src/service/claude-review-service";

describe("claude-review-service", () => {
  test("buildClaudeReviewCommand disables tools and uses plan permission mode", () => {
    const command = buildClaudeReviewCommand({
      kind: "plan",
      content: "Plan text",
    });

    expect(command[0]).toBe("claude");
    expect(command).toContain("--tools");
    expect(command).toContain("");
    expect(command).toContain("--permission-mode");
    expect(command).toContain("plan");
  });

  test("parseClaudeReviewOutput parses strict JSON critique", () => {
    const review = parseClaudeReviewOutput(
      '{"findings":[{"severity":"high","title":"Risk","detail":"Needs eval."}],"recommendations":["Add benchmark."]}',
    );

    expect(review.findings[0]?.severity).toBe("high");
    expect(review.recommendations).toContain("Add benchmark.");
  });

  test("parseClaudeReviewOutput falls back to raw output on invalid JSON", () => {
    const review = parseClaudeReviewOutput("not json");
    expect(review.findings).toEqual([]);
    expect(review.raw).toBe("not json");
  });
});
