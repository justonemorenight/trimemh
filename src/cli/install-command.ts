/**
 * trimemh install — Auto-detect AI coding agents & install MCP config.
 *
 * Usage:
 *   trimemh install                  # Interactive: detect & choose
 *   trimemh install --all            # Install for all detected agents
 *   trimemh install --target claude-code  # Install for specific agent
 *
 * Supported agents:
 *   claude-code  Claude Code
 *   codex        OpenAI Codex
 *   cursor       Cursor IDE
 *   continue     Continue.dev
 *   windsurf     Windsurf IDE
 *   copilot-cli  GitHub Copilot CLI
 *   aider        Aider AI
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { TriMemhConfig } from "../domain/schema";
import type { ConfigTarget } from "../mcp/config-gen";
import { generateMCPConfig } from "../mcp/config-gen";

// ═══════════════════════════════════════════════════════════════════════
// Agent definitions — detection + config paths
// ═══════════════════════════════════════════════════════════════════════

export interface AgentDefinition {
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
  /** Use official agent CLI instead of manually writing JSON config. */
  useCliInstall?: boolean;
  /** Optional hooks config file for lifecycle capture. */
  hookConfigPath?: string;
  /** Whether this host supports trimemh lifecycle hooks. */
  supportsHooks?: boolean;
}

const HOME = homedir();
const CODEX_PROJECT_CONFIG = join(process.cwd(), ".codex", "config.toml");

const AGENTS: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    target: "claude-code",
    icon: "🧠",
    detectPaths: [join(HOME, ".claude"), join(HOME, ".claude", "settings.json")],
    detectCommands: ["claude"],
    configPath: join(HOME, ".claude.json"),
    configKey: "mcpServers",
    postInstall: "Restart Claude Code so MCP tools are reloaded, then run 'claude mcp list'.",
    useCliInstall: true,
    hookConfigPath: join(HOME, ".claude", "settings.json"),
    supportsHooks: true,
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    target: "codex",
    icon: "🤖",
    detectPaths: [join(HOME, ".codex"), join(HOME, ".config", "codex")],
    detectCommands: ["codex"],
    configPath: CODEX_PROJECT_CONFIG,
    configKey: "mcp_servers",
    postInstall:
      "Restart Codex in this project, run 'codex reload', or use '/mcp' to confirm trimemh is loaded.",
    hookConfigPath: join(process.cwd(), ".codex", "hooks.json"),
    supportsHooks: true,
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
    id: "continue",
    name: "Continue.dev",
    target: "continue",
    icon: "▶",
    detectPaths: [join(HOME, ".continue")],
    detectCommands: ["continue"],
    configPath: join(HOME, ".continue", "config.json"),
    configKey: "mcpServers",
    postInstall: "Restart Continue so MCP tools are reloaded.",
  },
  {
    id: "windsurf",
    name: "Windsurf IDE",
    target: "windsurf",
    icon: "≈",
    detectPaths: [join(HOME, ".codeium", "windsurf"), "/Applications/Windsurf.app"],
    detectCommands: ["windsurf"],
    configPath: join(HOME, ".codeium", "windsurf", "mcp_config.json"),
    configKey: "mcpServers",
    postInstall: "Restart Windsurf or reload the window.",
  },
  {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    target: "copilot-cli",
    // biome-ignore lint/security/noSecrets: false positive emoji
    icon: "👨‍✈️",
    detectPaths: [join(HOME, ".copilot"), join(HOME, ".config", "github-copilot")],
    detectCommands: [], // checked via gh extension list below
    configPath: join(HOME, ".copilot", "mcp-config.json"),
    configKey: "mcpServers",
    postInstall: "Restart Copilot CLI or run 'copilot mcp list'.",
  },
  {
    id: "aider",
    name: "Aider AI",
    target: "aider",
    icon: "🔧",
    detectPaths: [join(HOME, ".aider")],
    detectCommands: ["aider"],
    configPath: join(HOME, ".aider", "mcp.json"),
    configKey: "mcpServers",
    postInstall: "Aider will pick up the MCP config on next start.",
  },
  {
    id: "generic",
    name: "Generic MCP Client",
    target: "generic",
    icon: "◆",
    detectPaths: [],
    detectCommands: [],
    configPath: join(process.cwd(), ".trimemh", "mcp.json"),
    configKey: "servers",
    postInstall: "Copy the generated MCP config into your client.",
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
    if (agent.id === "copilot-cli") {
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

export interface InstallOptions {
  withHooks?: boolean;
}

function projectRoot(): string {
  return resolve(process.cwd());
}

function shouldIncludeCwd(agent: AgentDefinition): boolean {
  return !["claude-code", "codex"].includes(agent.id);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

const LINE_SPLIT_RE = /\r?\n/;
const TOML_TABLE_RE = /^\[([^\]]+)\]$/;
const TRIMEMH_HOOK_MARKER = "trimemh hooks capture";
const HOOK_EVENTS = [
  ["SessionStart", "session_start"],
  ["UserPromptSubmit", "user_prompt_submit"],
  ["PreToolUse", "pre_tool_use"],
  ["PostToolUse", "post_tool_use"],
  ["PreCompact", "pre_compact"],
  ["Stop", "stop"],
] as const;

export function removeCodexTrimemhTables(content: string): string {
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
  env?: Record<string, string>;
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

export function formatCodexTrimemhBlock(server: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}): string {
  const lines = [
    "[mcp_servers.trimemh]",
    `command = ${tomlString(server.command)}`,
    `args = ${tomlStringArray(server.args)}`,
    ...(server.cwd ? [`cwd = ${tomlString(server.cwd)}`] : []),
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
    "enabled = true",
    ...(server.env && Object.keys(server.env).length > 0
      ? [
          "",
          "[mcp_servers.trimemh.env]",
          ...Object.entries(server.env).map(([key, value]) => `${key} = ${tomlString(value)}`),
        ]
      : []),
  ];
  return lines.join("\n");
}

function shellCommand(parts: string[]): string {
  return parts.map((part) => (part.includes(" ") ? tomlString(part) : part)).join(" ");
}

function hookCaptureCommand(agent: AgentDefinition, event: string): string {
  return shellCommand(["trimemh", "hooks", "capture", "--event", event, "--agent", agent.id]);
}

function hookEntry(agent: AgentDefinition, event: string): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: hookCaptureCommand(agent, event),
      },
    ],
  };
}

export function generateHookConfig(agent: AgentDefinition): Record<string, unknown> {
  if (!agent.supportsHooks) {
    throw new Error(`${agent.name} does not support trimemh lifecycle hooks.`);
  }

  return {
    hooks: Object.fromEntries(
      HOOK_EVENTS.map(([hostEvent, trimemhEvent]) => [hostEvent, [hookEntry(agent, trimemhEvent)]]),
    ),
  };
}

function isTrimemhHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) {
    return false;
  }
  return hooks.some((hook) => {
    if (!hook || typeof hook !== "object") {
      return false;
    }
    const command = (hook as { command?: unknown }).command;
    return typeof command === "string" && command.includes(TRIMEMH_HOOK_MARKER);
  });
}

export function mergeHookConfig(
  existing: Record<string, unknown>,
  generated: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing };
  const existingHooks =
    next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks)
      ? ({ ...(next.hooks as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const generatedHooks = generated.hooks as Record<string, unknown>;

  for (const [eventName, entries] of Object.entries(generatedHooks)) {
    const current = Array.isArray(existingHooks[eventName]) ? existingHooks[eventName] : [];
    const cleanCurrent = current.filter((entry) => !isTrimemhHookEntry(entry));
    existingHooks[eventName] = [...cleanCurrent, ...(Array.isArray(entries) ? entries : [])];
  }

  next.hooks = existingHooks;
  return next;
}

function installHookConfig(agent: AgentDefinition): InstallResult {
  if (!(agent.hookConfigPath && agent.supportsHooks)) {
    throw new Error(`${agent.name} does not support --with-hooks.`);
  }

  const dir = agent.hookConfigPath.substring(0, agent.hookConfigPath.lastIndexOf("/"));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const hasExistingConfig = existsSync(agent.hookConfigPath);
  const existingRaw = hasExistingConfig ? readFileSync(agent.hookConfigPath, "utf-8") : "";
  const backupPath = hasExistingConfig ? `${agent.hookConfigPath}.backup-${Date.now()}` : undefined;
  if (backupPath) {
    writeFileSync(backupPath, existingRaw);
  }

  let existing: Record<string, unknown> = {};
  if (existingRaw.trim()) {
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existing = {};
    }
  }

  const merged = mergeHookConfig(existing, generateHookConfig(agent));
  writeFileSync(agent.hookConfigPath, `${JSON.stringify(merged, null, 2)}\n`);

  return {
    agent,
    success: true,
    message: hasExistingConfig
      ? `Merged hooks into existing config at ${agent.hookConfigPath}`
      : `Created hook config at ${agent.hookConfigPath}`,
    created: !hasExistingConfig,
    backupPath,
  };
}

function installClaudeCodeConfig(
  agent: AgentDefinition,
  generatedConfig: Record<string, unknown>,
): InstallResult {
  const configObj = generatedConfig as {
    mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
  };
  const server = configObj.mcpServers?.trimemh;
  if (!server || typeof server.command !== "string" || !Array.isArray(server.args)) {
    throw new Error("Generated Claude MCP config is missing mcpServers.trimemh.");
  }

  if (!commandExists("claude")) {
    throw new Error("Claude Code CLI not found in PATH.");
  }

  const args = ["mcp", "add", "trimemh", "--", server.command, ...server.args];
  let result = Bun.spawnSync(["claude", ...args], {
    cwd: projectRoot(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = result.stdout?.toString().trim() ?? "";
  let stderr = result.stderr?.toString().trim() ?? "";
  const output = `${stdout}\n${stderr}`;
  let replaced = false;
  if (result.exitCode !== 0 && output.includes("already exists")) {
    const remove = Bun.spawnSync(["claude", "mcp", "remove", "trimemh", "-s", "local"], {
      cwd: projectRoot(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const removeStdout = remove.stdout?.toString().trim() ?? "";
    const removeStderr = remove.stderr?.toString().trim() ?? "";
    if (remove.exitCode !== 0) {
      throw new Error(removeStderr || removeStdout || "claude mcp remove failed");
    }
    replaced = true;
    result = Bun.spawnSync(["claude", ...args], {
      cwd: projectRoot(),
      stdout: "pipe",
      stderr: "pipe",
    });
    stdout = result.stdout?.toString().trim() ?? "";
    stderr = result.stderr?.toString().trim() ?? "";
  }
  if (result.exitCode !== 0) {
    throw new Error(stderr || stdout || "claude mcp add failed");
  }

  return {
    agent,
    success: true,
    message:
      stdout ||
      `${replaced ? "Replaced" : "Registered"} trimemh MCP server with Claude Code at ${projectRoot()}`,
    created: !replaced,
  };
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

export function formatInstallPreview(
  memhConfig: TriMemhConfig,
  detected: DetectedAgent,
  options: InstallOptions = {},
): string {
  const generated = generateMCPConfig(memhConfig, detected.agent.target, {
    projectRoot: projectRoot(),
    includeCwd: shouldIncludeCwd(detected.agent),
  });
  const sections: string[] = [];
  if (detected.agent.id === "claude-code" && detected.agent.useCliInstall) {
    const config = generated.config as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
    };
    const server = config.mcpServers?.trimemh;
    if (server && typeof server.command === "string" && Array.isArray(server.args)) {
      sections.push(
        `MCP:\nclaude mcp add trimemh -- ${[server.command, ...server.args].join(" ")}`,
      );
    }
  } else if (detected.agent.id === "codex") {
    sections.push(`MCP:\n${formatCodexTrimemhBlock(codexServerFromConfig(generated.config))}`);
  } else {
    sections.push(`MCP:\n${JSON.stringify(generated.config, null, 2)}`);
  }

  if (options.withHooks) {
    if (!detected.agent.supportsHooks) {
      sections.push("Hooks:\n# Not supported for this target.");
    } else {
      sections.push(
        `Hooks (${detected.agent.hookConfigPath}):\n${JSON.stringify(generateHookConfig(detected.agent), null, 2)}`,
      );
    }
  }

  return sections.join("\n\n");
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
export function installForAgent(
  memhConfig: TriMemhConfig,
  detected: DetectedAgent,
  options: InstallOptions = {},
): InstallResult {
  const { agent, hasExistingConfig, configPath } = detected;

  try {
    if (options.withHooks && !agent.supportsHooks) {
      throw new Error("--with-hooks is only supported for claude-code and codex.");
    }

    // Generate the memh MCP config
    const generated = generateMCPConfig(memhConfig, agent.target, {
      projectRoot: projectRoot(),
      includeCwd: shouldIncludeCwd(agent),
    });
    const newConfig = generated.config;
    let mcpResult: InstallResult;

    if (agent.id === "claude-code" && agent.useCliInstall) {
      mcpResult = installClaudeCodeConfig(agent, newConfig);
    } else if (agent.id === "codex") {
      mcpResult = installCodexConfig(agent, configPath, newConfig, hasExistingConfig);
    } else {
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
        const memhServer = configObj.mcpServers?.trimemh ?? configObj.servers?.trimemh;
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

        mcpResult = {
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

        mcpResult = {
          agent,
          success: true,
          message: `Created new config at ${configPath}`,
          created: true,
        };
      }
    }

    if (!options.withHooks) {
      return mcpResult;
    }

    const hookResult = installHookConfig(agent);
    return {
      ...mcpResult,
      message: `${mcpResult.message}\n${hookResult.message}${hookResult.backupPath ? `\nHook backup saved to: ${hookResult.backupPath}` : ""}`,
    };
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
