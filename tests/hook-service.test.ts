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
    expect(normalized.lifecycleState).toBe("proposed");
    expect(normalized.normalizedEvent.agent_id).toBe("codex");
  });

  test("tool observations produce a normalized envelope and needs_review lifecycle", () => {
    const normalized = normalizeHookPayload({
      event: "pre_tool_use",
      agent: "claude-code",
      payload: {
        session_id: "session-c",
        tool_name: "Bash",
        tool_input: { command: "bun test" },
      },
    });

    expect(normalized.normalizedEvent.session_id).toBe("session-c");
    expect(normalized.normalizedEvent.tool).toBe("Bash");
    expect(normalized.normalizedEvent.risk_signals).toContain("shell_tool");
    expect(normalized.lifecycleState).toBe("needs_review");
  });

  test("stop hooks normalize into first-class session summary text", () => {
    const normalized = normalizeHookPayload({
      event: "stop",
      agent: "codex",
      payload: {
        session_id: "session-stop",
        summary: "Finished adapter work.",
        files: ["src/service/hook-service.ts"],
      },
    });

    expect(normalized.kind).toBe("session_summary");
    expect(normalized.text).toContain("Session summary for codex/session-stop.");
    expect(normalized.text).toContain("source_event=stop");
  });
});
