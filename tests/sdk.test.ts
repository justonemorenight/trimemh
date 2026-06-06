import { describe, expect, it } from "bun:test";

import { withMemhAnthropic } from "../src/sdk/anthropic";
import { createMemhClaudeAgentQuery } from "../src/sdk/claude-agent";
import { MemhClient } from "../src/sdk/client";
import { buildMemorySystemPrefix } from "../src/sdk/context";
import {
  createMemhMiddleware,
  generateTextWithMemh,
  injectVercelParams,
  streamTextWithMemh,
} from "../src/sdk/vercel";

function contextData(xml = "<memory_context>memh xml</memory_context>") {
  return {
    xml,
    selected_detail_ids: [],
    lineage_ids: [],
    evicted: [],
    compacted_index: false,
    over_budget: false,
    state: { turn: 1, active_detail_ids: [] },
  };
}

function fakeContextClient(xml?: string) {
  return {
    contextCalls: [] as unknown[],
    async context(input: unknown) {
      this.contextCalls.push(input);
      return contextData(xml);
    },
  };
}

describe("MemhClient", () => {
  it("calls context API and unwraps data", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MemhClient({
      baseUrl: "http://memh.test/",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ success: true, data: contextData() });
      },
    });

    const result = await client.context({ query: "hello", modelContextTokens: 32_000 });
    expect(result.xml).toContain("memory_context");
    expect(calls[0]?.url).toBe("http://memh.test/api/context/assemble");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(String(calls[0]?.init?.body)).toContain("hello");
  });
});

describe("buildMemorySystemPrefix", () => {
  it("builds marked memory context and infers query from prompt", async () => {
    const client = fakeContextClient();
    const prefix = await buildMemorySystemPrefix({ client }, { prompt: "Use stored context" });
    expect(prefix).toContain("memh_context:start");
    expect(prefix).toContain("<memory_context>");
    expect(client.contextCalls[0]).toMatchObject({ query: "Use stored context" });
  });
});

describe("withMemhAnthropic", () => {
  it("wraps messages.create and prepends memory to string system prompts", async () => {
    let captured: Record<string, unknown> | null = null;
    const client = {
      messages: {
        async create(params: Record<string, unknown>) {
          captured = params;
          return { ok: true };
        },
      },
    };

    const wrapped = withMemhAnthropic(client, { client: fakeContextClient() });
    await wrapped.messages.create?.({
      model: "claude-test",
      system: "Existing system",
      messages: [{ role: "user", content: "Question" }],
    });

    expect(String(captured?.system)).toContain("memh_context:start");
    expect(String(captured?.system)).toContain("Existing system");
    expect(captured?.model).toBe("claude-test");
  });

  it("wraps messages.stream and preserves array system prompts", async () => {
    let captured: Record<string, unknown> | null = null;
    const client = {
      messages: {
        stream(params: Record<string, unknown>) {
          captured = params;
          return { stream: true };
        },
      },
    };

    const wrapped = withMemhAnthropic(client, { client: fakeContextClient() });
    await wrapped.messages.stream?.({
      system: [{ type: "text", text: "Existing" }],
      messages: [{ role: "user", content: "Question" }],
    });

    const system = captured?.system as Array<{ type: string; text: string }>;
    expect(system[0]?.text).toContain("memh_context:start");
    expect(system[1]?.text).toBe("Existing");
  });
});

describe("Claude Agent SDK integration", () => {
  it("injects appendSystemPrompt and only adds requested MCP tool", async () => {
    let captured: {
      prompt: string | AsyncIterable<unknown>;
      options?: Record<string, unknown>;
    } | null = null;
    const query = createMemhClaudeAgentQuery(
      (params) => {
        captured = params;
        return ["result"];
      },
      {
        client: fakeContextClient(),
        mcp: {
          enabled: true,
          server: { command: "bun", args: ["run", "src/cli.ts", "mcp", "serve"] },
        },
      },
    );

    await query({
      prompt: "Do work",
      options: { allowedTools: ["Read"], maxTurns: 2 },
    });

    expect(captured?.prompt).toBe("Do work");
    expect(String(captured?.options?.appendSystemPrompt)).toContain("memh_context:start");
    expect(captured?.options?.allowedTools).toEqual(["Read", "mcp__trimemh__memory_retrieve"]);
    expect(captured?.options?.maxTurns).toBe(2);
  });

  it("can inject as an initial prompt prefix", async () => {
    let captured: { prompt: string | AsyncIterable<unknown> } | null = null;
    const query = createMemhClaudeAgentQuery(
      (params) => {
        captured = params;
        return ["result"];
      },
      {
        client: fakeContextClient(),
        injectionMode: "prompt_prefix",
      },
    );

    await query({ prompt: "Do work" });
    expect(String(captured?.prompt)).toContain("memh_context:start");
    expect(String(captured?.prompt)).toContain("Do work");
  });
});

describe("Vercel AI SDK integration", () => {
  it("injects middleware context into normalized prompt arrays", async () => {
    const middleware = createMemhMiddleware({ client: fakeContextClient() });
    const transformed = await middleware.transformParams?.({
      type: "generate",
      model: {} as never,
      params: {
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      } as never,
    });

    expect(transformed.prompt[0]?.role).toBe("system");
    expect(transformed.prompt[0]?.content).toContain("memh_context:start");
  });

  it("injects high-level generateText and streamText params once", async () => {
    const calls: Record<string, unknown>[] = [];
    const ai = {
      generateText(params: Record<string, unknown>) {
        calls.push(params);
        return { text: "ok" };
      },
      streamText(params: Record<string, unknown>) {
        calls.push(params);
        return { stream: true };
      },
    };
    const options = { client: fakeContextClient(), ai };

    await generateTextWithMemh({ model: "m", prompt: "Hello", tools: { a: true } }, options);
    await streamTextWithMemh(calls[0]!, options);

    expect(String(calls[0]?.system)).toContain("memh_context:start");
    expect(calls[0]?.tools).toEqual({ a: true });
    expect(String(calls[1]?.system).match(/memh_context:start/g)?.length).toBe(1);
  });

  it("exposes direct param injection for tests and custom wrappers", async () => {
    const injected = await injectVercelParams(
      { system: "Existing", messages: [{ role: "user", content: "Hi" }] },
      { client: fakeContextClient() },
    );

    expect(String(injected.system)).toContain("memh_context:start");
    expect(String(injected.system)).toContain("Existing");
    expect(injected.messages).toEqual([{ role: "user", content: "Hi" }]);
  });
});
