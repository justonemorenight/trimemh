/**
 * MCP Config Generators (Phase 3 — Integration & DX)
 *
 * Generates MCP client configurations for popular agent frameworks.
 * Outputs JSON that can be directly merged into each framework's MCP settings.
 *
 * Supported targets:
 * - claude-code   (Claude Code / claude.ai)
 * - codex         (OpenAI Codex)
 * - cursor        (Cursor IDE)
 * - continue      (Continue.dev)
 * - windsurf      (Windsurf IDE)
 * - copilot-cli   (GitHub Copilot CLI)
 * - aider         (Aider)
 * - generic       (Standard MCP JSON)
 */

import { relative } from "node:path";

import type { TriMemhConfig } from "../domain/schema";

// ─── Types ──────────────────────────────────────────────────────────

export type ConfigTarget =
  | "claude-code"
  | "codex"
  | "cursor"
  | "continue"
  | "windsurf"
  | "copilot-cli"
  | "aider"
  | "generic";

export interface MCPToolConfig {
  /** Command to run the MCP server. */
  command: string;
  /** Arguments for the command. */
  args: string[];
  /** Working directory for the server process. */
  cwd?: string;
  /** Environment variables. */
  env?: Record<string, string>;
  /** Transport type. */
  transport?: "stdio" | "http";
  /** HTTP endpoint (for streamable HTTP transport). */
  url?: string;
}

export interface GeneratedConfig {
  target: ConfigTarget;
  config: Record<string, unknown>;
  installInstructions: string;
}

export interface GenerateMCPConfigOptions {
  /** Project root used as MCP server cwd. Defaults to process.cwd(). */
  projectRoot?: string;
  /** Include explicit cwd in generated config. Useful for global client configs. */
  includeCwd?: boolean;
  /** Include explicit env pins for clients that cannot set cwd reliably. */
  includeEnv?: boolean;
}

// ─── Transport resolution ───────────────────────────────────────────

function _resolveCommand(): string {
  return process.env.TRIMEMH_BUN_PATH ?? "bun";
}

function resolveScriptPath(): string {
  return process.env.TRIMEMH_SCRIPT_PATH ?? "src/cli.ts";
}

/**
 * Detect the best memh invocation for the current environment.
 * When installed globally: "memh"
 * When running from source: "bun run src/cli.ts"
 */
function resolveTriMemhCommand(): { command: string; args: string[] } {
  // If TRIMEMH_BUN_PATH is set, we're in a custom environment
  if (process.env.TRIMEMH_BUN_PATH) {
    return {
      command: process.env.TRIMEMH_BUN_PATH,
      args: ["run", resolveScriptPath()],
    };
  }

  // Check if we might be running from a global install
  // (package.json bin field creates a symlink to src/cli.ts)
  // When installed globally, just use "memh" directly
  try {
    const result = Bun.spawnSync(["which", "trimemh"], { stdout: "ignore", stderr: "ignore" });
    if (result.exitCode === 0) {
      return { command: "trimemh", args: [] };
    }
  } catch {
    /* fall through */
  }

  // Default: running from source
  return {
    command: "bun",
    args: ["run", resolveScriptPath()],
  };
}

function resolveDbPath(config: TriMemhConfig): string {
  return config.dbPath;
}

function projectRoot(options?: GenerateMCPConfigOptions): string {
  return options?.projectRoot ?? process.cwd();
}

function maybeCwd(options?: GenerateMCPConfigOptions): { cwd?: string } {
  return options?.includeCwd ? { cwd: projectRoot(options) } : {};
}

function serverEnv(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): Record<string, string> | undefined {
  if (!options?.includeEnv) {
    return undefined;
  }
  return {
    TRIMEMH_PROJECT_ID: config.projectId,
    TRIMEMH_DB_PATH: resolveDbPath(config),
  };
}

function maybeEnv(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): { env?: Record<string, string> } {
  const env = serverEnv(config, options);
  return env ? { env } : {};
}

function trimemhServeArgs(args: string[]): string[] {
  return [...args, "mcp", "serve"];
}

function relativeDbHint(config: TriMemhConfig, options?: GenerateMCPConfigOptions): string {
  const rel = relative(projectRoot(options), resolveDbPath(config));
  return rel && !rel.startsWith("..") ? rel : resolveDbPath(config);
}

// ─── Per-target generators ──────────────────────────────────────────

function generateClaudeCode(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "claude-code",
    config: {
      mcpServers: {
        trimemh: {
          type: "stdio",
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      },
    },
    installInstructions: [
      "# Claude Code prefers project-local MCP registration:",
      "#   claude mcp add trimemh -- trimemh mcp serve",
      "# Or run: trimemh install --target claude-code",
    ].join("\n"),
  };
}

function generateCursor(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "cursor",
    config: {
      mcpServers: {
        trimemh: {
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      },
    },
    installInstructions: [
      "# Place in .cursor/mcp.json in your project root:",
      "# Or add via Cursor Settings → MCP → Add Server",
    ].join("\n"),
  };
}

function generateCodex(config: TriMemhConfig, options?: GenerateMCPConfigOptions): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "codex",
    config: {
      mcp_servers: {
        trimemh: {
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      },
    },
    installInstructions: [
      '# Add to ~/.codex/config.toml under "[mcp_servers.trimemh]":',
      "# Or run: trimemh install --target codex",
    ].join("\n"),
  };
}

function generateContinue(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "continue",
    config: {
      mcpServers: [
        {
          name: "trimemh",
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      ],
    },
    installInstructions: ['# Add to ~/.continue/config.json under "mcpServers":'].join("\n"),
  };
}

function generateWindsurf(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "windsurf",
    config: {
      mcpServers: {
        trimemh: {
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      },
    },
    installInstructions: [
      "# Add to .windsurf/mcp.json in your project root:",
      "# Or configure via Windsurf Settings → MCP Servers",
    ].join("\n"),
  };
}

function generateCopilotCli(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "copilot-cli",
    config: {
      mcpServers: {
        trimemh: {
          type: "stdio",
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      },
    },
    installInstructions: [
      '# Add to ~/.copilot/mcp-config.json under "mcpServers":',
      "# Or run: trimemh install --target copilot-cli",
    ].join("\n"),
  };
}

function generateAider(config: TriMemhConfig, options?: GenerateMCPConfigOptions): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "aider",
    config: {
      mcpServers: {
        trimemh: {
          type: "stdio",
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      },
    },
    installInstructions: [
      '# Add to ~/.aider/mcp.json under "mcpServers", or call triMemh REST/MCP manually.',
      "# Or run: trimemh install --target aider",
    ].join("\n"),
  };
}

function generateGeneric(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "generic",
    config: {
      servers: {
        trimemh: {
          command,
          args: trimemhServeArgs(args),
          ...maybeCwd(options),
          ...maybeEnv(config, options),
        },
      },
    },
    installInstructions: [
      "# Standard MCP JSON format.",
      "# Compatible with any MCP client that supports stdio transport.",
      `# The server will resolve project_id and db_path from cwd/.trimemh config; current DB: ${relativeDbHint(config, options)}`,
    ].join("\n"),
  };
}

// ─── Main API ───────────────────────────────────────────────────────

const GENERATORS: Record<
  ConfigTarget,
  (config: TriMemhConfig, options?: GenerateMCPConfigOptions) => GeneratedConfig
> = {
  "claude-code": generateClaudeCode,
  cursor: generateCursor,
  codex: generateCodex,
  continue: generateContinue,
  windsurf: generateWindsurf,
  "copilot-cli": generateCopilotCli,
  aider: generateAider,
  generic: generateGeneric,
};

/**
 * Generate MCP client configuration for the specified target framework.
 */
export function generateMCPConfig(
  config: TriMemhConfig,
  target: ConfigTarget,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig {
  const generator = GENERATORS[target];
  if (!generator) {
    throw new Error(`Unknown target "${target}". Supported: ${Object.keys(GENERATORS).join(", ")}`);
  }
  return generator(config, options);
}

/**
 * Generate MCP configs for all supported targets.
 */
export function generateAllMCPConfigs(
  config: TriMemhConfig,
  options?: GenerateMCPConfigOptions,
): GeneratedConfig[] {
  return Object.keys(GENERATORS).map((target) =>
    generateMCPConfig(config, target as ConfigTarget, options),
  );
}

/**
 * Format a GeneratedConfig as a pretty-printed JSON string.
 */
export function formatConfigAsJSON(generated: GeneratedConfig): string {
  return JSON.stringify(generated.config, null, 2);
}

/**
 * Format a GeneratedConfig as a shell command for appending to config file.
 */
export function formatConfigAsShell(generated: GeneratedConfig): string {
  const json = formatConfigAsJSON(generated);
  return `echo '${json.replace(/'/g, "'\\''")}'`;
}

/**
 * List all supported targets with descriptions.
 */
export function listTargets(): Array<{ target: ConfigTarget; description: string }> {
  return [
    { target: "claude-code", description: "Claude Code — claude mcp add / ~/.claude.json" },
    { target: "codex", description: "OpenAI Codex — .codex/config.toml" },
    { target: "cursor", description: "Cursor IDE — .cursor/mcp.json" },
    { target: "continue", description: "Continue.dev — ~/.continue/config.json" },
    { target: "windsurf", description: "Windsurf IDE — .windsurf/mcp.json" },
    { target: "copilot-cli", description: "GitHub Copilot CLI — ~/.copilot/mcp-config.json" },
    { target: "aider", description: "Aider — ~/.aider/mcp.json" },
    { target: "generic", description: "Generic MCP JSON — any stdio-compatible client" },
  ];
}
