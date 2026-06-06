/**
 * trimemh install — Auto-detect AI coding agents & install MCP config.
 *
 * Usage:
 *   trimemh install                  # Interactive: detect & choose
 *   trimemh install --all            # Install for all detected agents
 *   trimemh install --target claude  # Install for specific agent
 *
 * Supported agents:
 *   claude    Claude Code (claude.ai)
 *   cursor    Cursor IDE
 *   codex     OpenAI Codex CLI
 *   copilot   GitHub Copilot CLI
 *   aider     Aider AI
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { TriMemhConfig } from "../domain/schema";
import type { ConfigTarget } from "../mcp/config-gen";
import { generateMCPConfig } from "../mcp/config-gen";

// ═══════════════════════════════════════════════════════════════════════
// Agent definitions — detection + config paths
// ═══════════════════════════════════════════════════════════════════════

interface AgentDefinition {
  id: string;
  name: string;
  target: ConfigTarget;
  /** Icon for terminal display */
  icon: string;
  /** Path to check for installation */
  detectPaths: string[];
  /** CLI commands that indicate this agent is installed */
  detectCommands: string[];
  /** Path to the MCP config file */
  configPath: string;
  /** Whether the config file uses a root key (like "mcpServers") */
  configKey: string;
  /** Instructions after install */
  postInstall: string;
}

const HOME = homedir();
const CODEX_PROJECT_CONFIG = join(process.cwd(), ".codex", "config.toml");

const AGENTS: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    target: "claude-code",
    icon: "🧠",
    detectPaths: [join(HOME, ".claude"), join(HOME, ".claude", "settings.json")],
    detectCommands: ["claude"],
    configPath: join(HOME, ".claude", "settings.json"),
    configKey: "mcpServers",
    postInstall: "Restart Claude Code or reload the window (Cmd+Shift+P → Reload).",
  },
  {
    id: "cursor",
    name: "Cursor IDE",
    target: "cursor",
    icon: "🖱️",
    detectPaths: [
      join(HOME, ".cursor"),
      "/Applications/Cursor.app",
      join(HOME, "Library", "Application Support", "Cursor"),
    ],
    detectCommands: ["cursor"],
    configPath: join(HOME, ".cursor", "mcp.json"),
    configKey: "mcpServers",
    postInstall: "Restart Cursor or run 'Cursor: Reload Window' from Command Palette.",
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    target: "codex",
    icon: "🤖",
    detectPaths: [join(HOME, ".codex"), join(HOME, ".config", "codex")],
    detectCommands: ["codex"],
    configPath: CODEX_PROJECT_CONFIG,
    configKey: "mcp_servers",
    postInstall:
      "Restart Codex in this project, run 'codex reload', or use '/mcp' to confirm trimemh is loaded.",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    target: "generic",
    // biome-ignore lint/security/noSecrets: false positive emoji
    icon: "👨‍✈️",
    detectPaths: [join(HOME, ".config", "github-copilot")],
    detectCommands: [], // checked via gh extension list below
    configPath: join(HOME, ".config", "github-copilot", "mcp.json"),
    configKey: "mcpServers",
    postInstall: "Restart your terminal or run 'gh copilot reload'.",
  },
  {
    id: "aider",
    name: "Aider AI",
    target: "generic",
    icon: "🔧",
    detectPaths: [join(HOME, ".aider")],
    detectCommands: ["aider"],
    configPath: join(HOME, ".aider", "mcp.json"),
    configKey: "mcpServers",
    postInstall: "Aider will pick up the MCP config on next start.",
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════════════

export interface DetectedAgent {
  agent: AgentDefinition;
  installed: boolean;
  hasExistingConfig: boolean;
  configPath: string;
}

/**
 * Check if a CLI command is available in PATH.
 */
function commandExists(cmd: string): boolean {
  try {
    const result = Bun.spawnSync(["which", cmd], { stdout: "ignore", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Detect which AI agents are installed on this machine.
 */
export function detectAgents(): DetectedAgent[] {
  return AGENTS.map((agent) => {
    const pathExists = agent.detectPaths.some((p) => existsSync(p));

    // Default: check commands
    let cmdExists =
      agent.detectCommands.length > 0 && agent.detectCommands.some((c) => commandExists(c));

    // Copilot: requires gh + copilot extension
    if (agent.id === "copilot") {
      cmdExists = false;
      if (commandExists("gh")) {
        try {
          const result = Bun.spawnSync(["gh", "extension", "list"], {
            stdout: "pipe",
            stderr: "ignore",
          });
          cmdExists = result.stdout?.toString().includes("github-copilot") ?? false;
        } catch {
          /* not installed */
        }
      }
    }

    const hasExistingConfig = existsSync(agent.configPath);
    const installed = pathExists || cmdExists;

    return {
      agent,
      installed,
      hasExistingConfig,
      configPath: agent.configPath,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Installation
// ═══════════════════════════════════════════════════════════════════════

export interface InstallResult {
  agent: AgentDefinition;
  success: boolean;
  message: string;
  created: boolean; // true = new file, false = merged into existing
  backupPath?: string; // if existing config was backed up
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

const LINE_SPLIT_RE = /\r?\n/;
const TOML_TABLE_RE = /^\[([^\]]+)\]$/;

function removeCodexTrimemhTables(content: string): string {
  const lines = content.split(LINE_SPLIT_RE);
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const tableMatch = trimmed.match(TOML_TABLE_RE);
    if (tableMatch) {
      const tableName = tableMatch[1];
      skipping =
        tableName === "mcp_servers.trimemh" || tableName.startsWith("mcp_servers.trimemh.");
    }
    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n").trimEnd();
}

function codexServerFromConfig(config: Record<string, unknown>): {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
} {
  const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
  const server = mcpServers?.trimemh as
    | { command?: unknown; args?: unknown; env?: unknown }
    | undefined;
  if (!server || typeof server.command !== "string" || !Array.isArray(server.args)) {
    throw new Error("Generated Codex MCP config is missing mcp_servers.trimemh.");
  }

  const env = server.env && typeof server.env === "object" ? server.env : {};
  return {
    command: server.command,
    args: server.args.filter((arg): arg is string => typeof arg === "string"),
    cwd: typeof server.cwd === "string" ? server.cwd : undefined,
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

function formatCodexTrimemhBlock(server: {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
}): string {
  const lines = [
    "[mcp_servers.trimemh]",
    `command = ${tomlString(server.command)}`,
    `args = ${tomlStringArray(server.args)}`,
    ...(server.cwd ? [`cwd = ${tomlString(server.cwd)}`] : []),
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
    "enabled = true",
    "",
    "[mcp_servers.trimemh.env]",
    ...Object.entries(server.env).map(([key, value]) => `${key} = ${tomlString(value)}`),
  ];
  return lines.join("\n");
}

function installCodexConfig(
  agent: AgentDefinition,
  configPath: string,
  generatedConfig: Record<string, unknown>,
  hasExistingConfig: boolean,
): InstallResult {
  const server = codexServerFromConfig(generatedConfig);
  const dir = configPath.substring(0, configPath.lastIndexOf("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existingRaw = hasExistingConfig ? readFileSync(configPath, "utf-8") : "";
  const backupPath = hasExistingConfig ? `${configPath}.backup-${Date.now()}` : undefined;
  if (backupPath) {
    writeFileSync(backupPath, existingRaw);
  }

  const base = removeCodexTrimemhTables(existingRaw);
  const next = `${base ? `${base}\n\n` : ""}${formatCodexTrimemhBlock(server)}\n`;
  writeFileSync(configPath, next);

  return {
    agent,
    success: true,
    message: hasExistingConfig
      ? `Merged into existing config at ${configPath}`
      : `Created new config at ${configPath}`,
    created: !hasExistingConfig,
    backupPath,
  };
}

export function formatInstallPreview(memhConfig: TriMemhConfig, detected: DetectedAgent): string {
  const generated = generateMCPConfig(memhConfig, detected.agent.target);
  if (detected.agent.id === "codex") {
    return formatCodexTrimemhBlock(codexServerFromConfig(generated.config));
  }
  return JSON.stringify(generated.config, null, 2);
}

/**
 * Deep merge two JSON objects. Arrays are concatenated.
 */
function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    // For arrays of objects with 'name' key, replace by name
    const merged = [...target];
    for (const item of source) {
      if (item && typeof item === "object" && "name" in item) {
        const itemName = (item as Record<string, unknown>).name;
        const idx = merged.findIndex(
          (m) =>
            m &&
            typeof m === "object" &&
            "name" in m &&
            (m as Record<string, unknown>).name === itemName,
        );
        if (idx >= 0) {
          const mergedItem = merged[idx];
          if (mergedItem && typeof mergedItem === "object") {
            merged[idx] = { ...mergedItem, ...item };
          }
        } else {
          merged.push(item);
        }
      } else if (!merged.some((m) => JSON.stringify(m) === JSON.stringify(item))) {
        merged.push(item);
      }
    }
    return merged;
  }

  if (
    target &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    source &&
    typeof source === "object" &&
    !Array.isArray(source)
  ) {
    const result = { ...target } as Record<string, unknown>;
    const sourceObj = source as Record<string, unknown>;
    for (const key of Object.keys(sourceObj)) {
      result[key] = key in result ? deepMerge(result[key], sourceObj[key]) : sourceObj[key];
    }
    return result;
  }

  return source;
}

/**
 * Install MCP config for a specific agent.
 * Handles: creating new config, merging into existing config, backup.
 */
export function installForAgent(memhConfig: TriMemhConfig, detected: DetectedAgent): InstallResult {
  const { agent, hasExistingConfig, configPath } = detected;

  try {
    // Generate the memh MCP config
    const generated = generateMCPConfig(memhConfig, agent.target);
    const newConfig = generated.config;

    if (agent.id === "codex") {
      return installCodexConfig(agent, configPath, newConfig, hasExistingConfig);
    }

    // Ensure parent directory exists
    const dir = configPath.substring(0, configPath.lastIndexOf("/"));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (hasExistingConfig) {
      // Merge with existing config
      let existing: Record<string, unknown> = {};
      try {
        const raw = readFileSync(configPath, "utf-8");
        existing = JSON.parse(raw);
      } catch {
        // Corrupt config — start fresh but keep backup
        const backupPath = `${configPath}.backup-${Date.now()}`;
        try {
          writeFileSync(backupPath, readFileSync(configPath, "utf-8"));
        } catch {
          /* ignore */
        }
        existing = {};
      }

      // Backup
      const backupPath = `${configPath}.backup-${Date.now()}`;
      writeFileSync(backupPath, JSON.stringify(existing, null, 2));

      // Merge: insert memh under the right config key
      const configObj = newConfig as {
        mcpServers?: Record<string, unknown>;
        servers?: Record<string, unknown>;
      };
      const memhServer = configObj.mcpServers?.trimemh ?? configObj.servers?.memh;
      if (memhServer) {
        const merged = deepMerge(existing, {
          [agent.configKey]: {
            trimemh: memhServer,
          },
        });
        writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
      } else {
        writeFileSync(configPath, `${JSON.stringify(newConfig, null, 2)}\n`);
      }

      return {
        agent,
        success: true,
        message: `Merged into existing config at ${configPath}`,
        created: false,
        backupPath,
      };
    } else {
      // Fresh install — write new config
      // Wrap in the appropriate root key if the target output doesn't already have it
      const output = generated.config;
      writeFileSync(configPath, `${JSON.stringify(output, null, 2)}\n`);

      return {
        agent,
        success: true,
        message: `Created new config at ${configPath}`,
        created: true,
      };
    }
  } catch (err) {
    return {
      agent,
      success: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
      created: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Display
// ═══════════════════════════════════════════════════════════════════════

const G = "\x1b[32m",
  R = "\x1b[31m",
  Y = "\x1b[33m",
  C = "\x1b[36m",
  B = "\x1b[1m",
  D = "\x1b[90m",
  N = "\x1b[0m";
const CHECK = "✓",
  CROSS = "✗",
  DOT = "•";

export function printDetection(detected: DetectedAgent[]): void {
  console.log(`\n${B}  Detected AI Agents:${N}\n`);
  for (const d of detected) {
    const status = d.installed ? `${G}${CHECK} found${N}` : `${D}${CROSS} not found${N}`;
    const configStatus = d.hasExistingConfig ? `${Y}(existing config)${N}` : `${D}(no config)${N}`;
    console.log(`  ${d.agent.icon} ${C}${d.agent.name.padEnd(22)}${N} ${status}  ${configStatus}`);
  }
  console.log();
}

export function printInstallResults(results: InstallResult[]): void {
  console.log(`\n${B}  Installation Results:${N}\n`);
  for (const r of results) {
    if (r.success) {
      const action = r.created ? "Created" : "Merged";
      console.log(
        `  ${G}${CHECK}${N} ${r.agent.icon} ${r.agent.name}: ${G}${action}${N} → ${D}${r.agent.configPath}${N}`,
      );
      if (r.backupPath) {
        console.log(`    ${D}Backup saved to: ${r.backupPath}${N}`);
      }
    } else {
      console.log(`  ${R}${CROSS}${N} ${r.agent.icon} ${r.agent.name}: ${r.message}`);
    }
  }
  console.log();
}

export function printPostInstall(agents: AgentDefinition[]): void {
  console.log(`${B}  Next Steps:${N}\n`);
  for (const agent of agents) {
    console.log(`  ${D}${DOT}${N} ${agent.icon} ${agent.name}: ${agent.postInstall}`);
  }
  console.log(
    `\n  ${D}Initialize:${N} Run 'trimemh init' to create the memory DB and scan your codebase`,
  );
  console.log(`  ${D}Verify:${N}     Start your agent and ask "what MCP tools are available?"`);
  console.log(`  ${D}Test:${N}       Ask your agent to "search memories about authentication"`);
  console.log();
}
