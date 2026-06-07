import { describe, expect, test } from "bun:test";

import { normalizeHookPayload, parseHookEvent } from "../src/service/hook-service";

describe("hook-service", () => {
  test("parseHookEvent accepts known events", () => {
    expect(parseHookEvent("session_start")).toBe("session_start");
    expect(parseHookEvent("post_tool_use")).toBe("post_tool_use");
  });

  test("parseHookEvent rejects unknown events", () => {
    expect(() => parseHookEvent("session_end")).toThrow("Unknown hook event");
  });

  test("redacts private tags and secrets", () => {
    const normalized = normalizeHookPayload({
      event: "user_prompt_submit",
      agent: "claude-code",
      payload: {
        prompt: "Use api_key=sk-test and <private>hidden text</private>",
      },
    });

    expect(normalized.redacted).toBe(true);
    expect(normalized.requireReview).toBe(true);
    expect(normalized.text).toContain("[REDACTED]");
    expect(normalized.text).toContain("[REDACTED_PRIVATE]");
    expect(normalized.text).not.toContain("sk-test");
    expect(normalized.text).not.toContain("hidden text");
  });

  test("truncates long tool output", () => {
    const normalized = normalizeHookPayload({
      event: "post_tool_use",
      agent: "codex",
      payload: {
        output: Array.from({ length: 260 }, (_, index) => `word${index}`).join(" "),
      },
    });

    expect(normalized.truncated).toBe(true);
    expect(normalized.requireReview).toBe(true);
    expect(normalized.text).toContain("[TRUNCATED_HOOK_PAYLOAD]");
  });

  test("session_start can be low-risk without review", () => {
    const normalized = normalizeHookPayload({
      event: "session_start",
      agent: "codex",
      payload: { cwd: "/repo", session_id: "abc" },
    });

    expect(normalized.kind).toBe("fact");
    expect(normalized.requireReview).toBe(false);
  });
});
