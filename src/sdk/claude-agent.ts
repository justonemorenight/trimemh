import type { BuildMemorySystemPrefixOptions } from "./context";
import { buildMemorySystemPrefix } from "./context";
import { extractPromptText, prependStringPrefix } from "./prompt";

type ClaudeAgentQuery = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}) => unknown;

export interface ClaudeAgentMcpOptions {
  enabled?: boolean;
  serverName?: string;
  server?: Record<string, unknown>;
  allowedTools?: string[];
}

export interface ClaudeAgentTriMemhOptions extends BuildMemorySystemPrefixOptions {
  sdk?: { query: ClaudeAgentQuery };
  injectionMode?: "append_system_prompt" | "prompt_prefix";
  mcp?: ClaudeAgentMcpOptions;
}

function appendSystemPrompt(
  options: Record<string, unknown>,
  prefix: string,
): Record<string, unknown> {
  const append =
    typeof options.appendSystemPrompt === "string"
      ? prependStringPrefix(options.appendSystemPrompt, prefix)
      : prefix;

  return {
    ...options,
    appendSystemPrompt: append,
  };
}

function mergeMcpOptions(
  options: Record<string, unknown>,
  mcp: ClaudeAgentMcpOptions | undefined,
): Record<string, unknown> {
  if (!mcp?.enabled) {
    return options;
  }

  const serverName = mcp.serverName ?? "trimemh";
  const existingServers =
    options.mcpServers && typeof options.mcpServers === "object"
      ? (options.mcpServers as Record<string, unknown>)
      : {};
  const server = mcp.server ?? {
    command: "bun",
    args: ["run", "src/cli.ts", "mcp", "serve"],
  };

  const existingAllowedTools = Array.isArray(options.allowedTools)
    ? (options.allowedTools as string[])
    : [];
  const requestedTools = mcp.allowedTools ?? [`mcp__${serverName}__memory_retrieve`];
  const allowedTools = [...new Set([...existingAllowedTools, ...requestedTools])];

  return {
    ...options,
    mcpServers: {
      ...existingServers,
      [serverName]: server,
    },
    allowedTools,
  };
}

export function createMemhClaudeAgentQuery(
  query: ClaudeAgentQuery,
  triMemhOptions: ClaudeAgentTriMemhOptions = {},
): ClaudeAgentQuery {
  return async (params) => {
    const promptText =
      typeof params.prompt === "string" ? params.prompt : extractPromptText(params);
    const prefix = await buildMemorySystemPrefix(triMemhOptions, { ...params, prompt: promptText });
    const originalOptions = params.options ?? {};

    const optionsWithContext =
      triMemhOptions.injectionMode === "prompt_prefix"
        ? originalOptions
        : appendSystemPrompt(originalOptions, prefix);
    const options = mergeMcpOptions(optionsWithContext, triMemhOptions.mcp);

    const prompt =
      triMemhOptions.injectionMode === "prompt_prefix" && typeof params.prompt === "string"
        ? prependStringPrefix(params.prompt, prefix)
        : params.prompt;

    return query({
      ...params,
      prompt,
      options,
    });
  };
}

export async function withMemhClaudeAgent(
  options: ClaudeAgentTriMemhOptions = {},
): Promise<{ query: ClaudeAgentQuery }> {
  const sdk =
    options.sdk ??
    ((await import("@anthropic-ai/claude-agent-sdk")) as { query: ClaudeAgentQuery });
  return {
    query: createMemhClaudeAgentQuery(sdk.query, options),
  };
}
