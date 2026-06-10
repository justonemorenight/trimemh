import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  type RecoveryPair,
  type ToolCallEvent,
  correctionForRecovery,
  detectRecoveryPairs,
  mineFailures,
  parseToolCallEvents,
} from "../src/learning/learn";

const FIXTURES = resolve(import.meta.dir, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf-8");
}

// ─── parseToolCallEvents ────────────────────────────────────────────

describe("parseToolCallEvents", () => {
  test("extracts events from Claude Code format JSONL", () => {
    const raw = loadFixture("transcript-wrong-path.jsonl");
    const events = parseToolCallEvents(raw);

    // Should have 2 tool_use events (tool_result lines are not separate events)
    expect(events.length).toBe(2);

    expect(events[0]!.tool).toBe("read_file");
    expect(events[0]!.category).toBe("file_read");
    expect(events[0]!.args.path).toBe("src/utils.ts");

    expect(events[1]!.tool).toBe("read_file");
    expect(events[1]!.category).toBe("file_read");
    expect(events[1]!.args.path).toBe("src/lib/utils.ts");
  });

  test("handles tool_result with is_error", () => {
    const raw = loadFixture("transcript-wrong-path.jsonl");
    const events = parseToolCallEvents(raw);

    // First event should be marked as failed
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.error).toContain("ENOENT");

    // Second event should be successful
    expect(events[1]!.success).toBe(true);
    expect(events[1]!.error).toBeUndefined();
  });

  test("extracts tool blocks from Claude Code message.content transcript", () => {
    const raw = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "src/missing.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              is_error: true,
              content: "ENOENT: no such file or directory",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "Read",
              input: { file_path: "src/lib/found.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              is_error: false,
              content: "export const found = true;",
            },
          ],
        },
      }),
    ].join("\n");

    const events = parseToolCallEvents(raw);
    const pairs = detectRecoveryPairs(events);

    expect(events.length).toBe(2);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.error).toContain("ENOENT");
    expect(events[1]!.success).toBe(true);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.pattern).toBe("wrong_path");
  });

  test("normalizes PascalCase tool args used by generic transcripts", () => {
    const raw = [
      JSON.stringify({
        tool_name: "Read",
        input: { AbsolutePath: "/repo/src/missing.ts" },
        success: false,
        error: "ENOENT",
      }),
      JSON.stringify({
        tool_name: "Read",
        input: { AbsolutePath: "/repo/src/found.ts" },
        success: true,
      }),
    ].join("\n");

    const events = parseToolCallEvents(raw);
    const pairs = detectRecoveryPairs(events);

    expect(events[0]!.args.absolute_path).toBe("/repo/src/missing.ts");
    expect(events[1]!.args.absolute_path).toBe("/repo/src/found.ts");
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.pattern).toBe("wrong_path");
  });
});

// ─── detectRecoveryPairs ────────────────────────────────────────────

describe("detectRecoveryPairs", () => {
  test("finds wrong_path pattern from fixture", () => {
    const raw = loadFixture("transcript-wrong-path.jsonl");
    const events = parseToolCallEvents(raw);
    const pairs = detectRecoveryPairs(events);

    expect(pairs.length).toBe(1);
    expect(pairs[0]!.pattern).toBe("wrong_path");
    expect(pairs[0]!.failed.tool).toBe("read_file");
    expect(pairs[0]!.recovered.tool).toBe("read_file");
    expect(pairs[0]!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("finds wrong_command pattern from fixture", () => {
    const raw = loadFixture("transcript-failed-command.jsonl");
    const events = parseToolCallEvents(raw);
    const pairs = detectRecoveryPairs(events);

    expect(pairs.length).toBe(1);
    // "bun test --coverage" -> "bun test" = same prefix (bun test), so wrong_args
    expect(["wrong_command", "wrong_args"]).toContain(pairs[0]!.pattern);
    expect(pairs[0]!.failed.tool).toBe("Bash");
    expect(pairs[0]!.recovered.tool).toBe("Bash");
    expect(pairs[0]!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("finds narrow_search pattern from fixture", () => {
    const raw = loadFixture("transcript-narrow-search.jsonl");
    const events = parseToolCallEvents(raw);
    const pairs = detectRecoveryPairs(events);

    expect(pairs.length).toBe(1);
    expect(pairs[0]!.pattern).toBe("narrow_search");
    expect(pairs[0]!.failed.tool).toBe("grep_search");
    expect(pairs[0]!.recovered.tool).toBe("grep_search");
    expect(pairs[0]!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  test("finds missing_dep pattern from fixture", () => {
    const raw = loadFixture("transcript-missing-dep.jsonl");
    const events = parseToolCallEvents(raw);
    const pairs = detectRecoveryPairs(events);

    expect(pairs.length).toBeGreaterThanOrEqual(1);
    // First failed command + install = missing_dep
    const depPair = pairs.find((p) => p.pattern === "missing_dep");
    expect(depPair).toBeDefined();
    expect(depPair!.failed.tool).toBe("Bash");
    expect(depPair!.recovered.tool).toBe("Bash");
    expect(depPair!.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

// ─── mineFailures integration ───────────────────────────────────────

describe("mineFailures", () => {
  test("integrates both text failures and recovery pairs", () => {
    const raw = loadFixture("transcript-wrong-path.jsonl");
    const result = mineFailures(raw);

    // Should have at least recovery pairs detected
    expect(result.recoveryPairsDetected).toBeGreaterThanOrEqual(1);
    expect(result.sessionsAnalyzed).toBe(1);
    // Should have corrections from recovery pairs
    expect(result.correctionsProposed).toBeGreaterThanOrEqual(1);
    expect(result.corrections.length).toBe(result.correctionsProposed);
  });

  test("with empty input returns zero recoveryPairsDetected", () => {
    const result = mineFailures("");

    expect(result.sessionsAnalyzed).toBe(1);
    expect(result.failuresDetected).toBe(0);
    expect(result.recoveryPairsDetected).toBe(0);
    expect(result.correctionsProposed).toBe(0);
    expect(result.autoApproved).toBe(0);
    expect(result.pendingApproval).toBe(0);
    expect(result.corrections).toEqual([]);
  });
});

// ─── correctionForRecovery ──────────────────────────────────────────

describe("correctionForRecovery", () => {
  const makeEvent = (overrides: Partial<ToolCallEvent>): ToolCallEvent => ({
    index: 0,
    tool: "read_file",
    category: "file_read",
    args: {},
    success: true,
    rawLine: "test line",
    ...overrides,
  });

  test("maps wrong_path to mistake kind", () => {
    const pair: RecoveryPair = {
      failed: makeEvent({
        success: false,
        args: { path: "src/utils.ts" },
        error: "ENOENT: no such file or directory",
      }),
      recovered: makeEvent({
        success: true,
        args: { path: "src/lib/utils.ts" },
      }),
      pattern: "wrong_path",
      confidence: 0.85,
    };

    const correction = correctionForRecovery(pair);

    expect(correction.kind).toBe("mistake");
    expect(correction.action).toBe("create");
    expect(correction.proposedText).toContain("src/lib/utils.ts");
    expect(correction.proposedText).toContain("src/utils.ts");
    expect(correction.risk).toBe("medium");
    expect(correction.evidence).toContain("Failed:");
    expect(correction.evidence).toContain("Recovered:");
  });

  test("maps missing_dep to procedure kind", () => {
    const pair: RecoveryPair = {
      failed: makeEvent({
        tool: "Bash",
        category: "command",
        success: false,
        args: { command: "vitest run" },
        error: "vitest: command not found",
      }),
      recovered: makeEvent({
        tool: "Bash",
        category: "command",
        success: true,
        args: { command: "bun add -d vitest" },
      }),
      pattern: "missing_dep",
      confidence: 0.8,
    };

    const correction = correctionForRecovery(pair);

    expect(correction.kind).toBe("procedure");
    expect(correction.action).toBe("create");
    expect(correction.proposedText).toContain("vitest run");
    expect(correction.proposedText).toContain("bun add -d vitest");
    expect(correction.risk).toBe("high");
    expect(correction.evidence).toContain("Failed:");
    expect(correction.evidence).toContain("Recovered:");
  });
});
