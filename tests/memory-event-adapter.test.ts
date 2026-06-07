import { describe, expect, test } from "bun:test";

import { adapterForAgent } from "../src/service/memory-event-adapter";

describe("MemoryEventAdapter", () => {
  test("adapterForAgent returns stable singleton adapters", () => {
    expect(adapterForAgent("claude-code")).toBe(adapterForAgent("claude-code"));
    expect(adapterForAgent("unknown").target).toBe("generic");
  });

  test("normalizes Claude Code hook payloads into the common envelope", () => {
    const adapter = adapterForAgent("claude-code");
    const normalized = adapter.normalize({
      event: "post_tool_use",
      agent: "claude-code",
      payload: {
        session_id: "session-a",
        cwd: "/repo",
        tool_name: "Read",
        tool_input: { file_path: "src/index.ts" },
      },
      payloadHash: "hash-a",
      sanitizedPayload: '{"tool_name":"Read"}',
    });

    expect(normalized.agent_id).toBe("claude-code");
    expect(normalized.session_id).toBe("session-a");
    expect(normalized.cwd).toBe("/repo");
    expect(normalized.tool).toBe("Read");
    expect(normalized.files).toContain("src/index.ts");
    expect(normalized.risk_signals).toContain("tool_observation");
  });

  test("normalizes Codex hook payloads with missing fields gracefully", () => {
    const adapter = adapterForAgent("codex");
    const normalized = adapter.normalize({
      event: "session_start",
      agent: "codex",
      payload: {},
      payloadHash: "hash-b",
      sanitizedPayload: "{}",
    });

    expect(normalized.agent_id).toBe("codex");
    expect(normalized.session_id).toBeNull();
    expect(normalized.tool).toBeNull();
    expect(normalized.files).toEqual([]);
    expect(normalized.payload_hash).toBe("hash-b");
  });
});
