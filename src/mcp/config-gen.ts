/**
 * MCP Config Generators (Phase 3 — Integration & DX)
 *
 * Generates MCP client configurations for popular agent frameworks.
 * Outputs JSON that can be directly merged into each framework's MCP settings.
 *
 * Supported targets:
 * - claude-code   (Claude Code / claude.ai)
 * - cursor        (Cursor IDE)
 * - continue      (Continue.dev)
 * - windsurf      (Windsurf IDE)
 * - generic       (Standard MCP JSON)
 */

import type { TriMemhConfig } from "../domain/schema";

// ─── Types ──────────────────────────────────────────────────────────

export type ConfigTarget = "claude-code" | "cursor" | "continue" | "windsurf" | "generic";

export interface MCPToolConfig {
  /** Command to run the MCP server. */
  command: string;
  /** Arguments for the command. */
  args: string[];
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

// ─── Per-target generators ──────────────────────────────────────────

function generateClaudeCode(config: TriMemhConfig): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "claude-code",
    config: {
      mcpServers: {
        trimemh: {
          type: "stdio",
          command,
          args: [...args, "mcp", "serve"],
          env: {
            TRIMEMH_PROJECT_ID: config.projectId,
            TRIMEMH_DB_PATH: resolveDbPath(config),
          },
        },
      },
    },
    installInstructions: [
      '# Add to ~/.claude/settings.json under "mcpServers":',
      "# Or run: trimemh install --target claude",
    ].join("\n"),
  };
}

function generateCursor(config: TriMemhConfig): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "cursor",
    config: {
      mcpServers: {
        trimemh: {
          command,
          args: [...args, "mcp", "serve"],
          env: {
            TRIMEMH_PROJECT_ID: config.projectId,
            TRIMEMH_DB_PATH: resolveDbPath(config),
          },
        },
      },
    },
    installInstructions: [
      "# Place in .cursor/mcp.json in your project root:",
      "# Or add via Cursor Settings → MCP → Add Server",
    ].join("\n"),
  };
}

function generateContinue(config: TriMemhConfig): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "continue",
    config: {
      mcpServers: [
        {
          name: "trimemh",
          command,
          args: [...args, "mcp", "serve"],
          env: {
            TRIMEMH_PROJECT_ID: config.projectId,
            TRIMEMH_DB_PATH: resolveDbPath(config),
          },
        },
      ],
    },
    installInstructions: ['# Add to ~/.continue/config.json under "mcpServers":'].join("\n"),
  };
}

function generateWindsurf(config: TriMemhConfig): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "windsurf",
    config: {
      mcpServers: {
        trimemh: {
          command,
          args: [...args, "mcp", "serve"],
          env: {
            TRIMEMH_PROJECT_ID: config.projectId,
            TRIMEMH_DB_PATH: resolveDbPath(config),
          },
        },
      },
    },
    installInstructions: [
      "# Add to .windsurf/mcp.json in your project root:",
      "# Or configure via Windsurf Settings → MCP Servers",
    ].join("\n"),
  };
}

function generateGeneric(config: TriMemhConfig): GeneratedConfig {
  const { command, args } = resolveTriMemhCommand();

  return {
    target: "generic",
    config: {
      servers: {
        trimemh: {
          command,
          args: [...args, "mcp", "serve"],
          env: {
            TRIMEMH_PROJECT_ID: config.projectId,
            TRIMEMH_DB_PATH: resolveDbPath(config),
          },
        },
      },
    },
    installInstructions: [
      "# Standard MCP JSON format.",
      "# Compatible with any MCP client that supports stdio transport.",
    ].join("\n"),
  };
}

// ─── Main API ───────────────────────────────────────────────────────

const GENERATORS: Record<ConfigTarget, (config: TriMemhConfig) => GeneratedConfig> = {
  "claude-code": generateClaudeCode,
  cursor: generateCursor,
  continue: generateContinue,
  windsurf: generateWindsurf,
  generic: generateGeneric,
};

/**
 * Generate MCP client configuration for the specified target framework.
 */
export function generateMCPConfig(config: TriMemhConfig, target: ConfigTarget): GeneratedConfig {
  const generator = GENERATORS[target];
  if (!generator) {
    throw new Error(`Unknown target "${target}". Supported: ${Object.keys(GENERATORS).join(", ")}`);
  }
  return generator(config);
}

/**
 * Generate MCP configs for all supported targets.
 */
export function generateAllMCPConfigs(config: TriMemhConfig): GeneratedConfig[] {
  return Object.keys(GENERATORS).map((target) => generateMCPConfig(config, target as ConfigTarget));
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
    { target: "claude-code", description: "Claude Code (claude.ai) — ~/.claude/settings.json" },
    { target: "cursor", description: "Cursor IDE — .cursor/mcp.json" },
    { target: "continue", description: "Continue.dev — ~/.continue/config.json" },
    { target: "windsurf", description: "Windsurf IDE — .windsurf/mcp.json" },
    { target: "generic", description: "Generic MCP JSON — any stdio-compatible client" },
  ];
}
