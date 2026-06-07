import { describe, expect, test } from "bun:test";

import type { AgentDefinition } from "../src/cli/install-command";
import {
  formatCodexTrimemhBlock,
  generateHookConfig,
  mergeHookConfig,
  removeCodexTrimemhTables,
} from "../src/cli/install-command";

const CLAUDE_AGENT: AgentDefinition = {
  id: "claude-code",
  name: "Claude Code",
  target: "claude-code",
  icon: "",
  detectPaths: [],
  detectCommands: [],
  configPath: "/tmp/claude.json",
  configKey: "mcpServers",
  postInstall: "",
  supportsHooks: true,
  hookConfigPath: "/tmp/settings.json",
};

describe("Codex install config helpers", () => {
  test("removes existing trimemh MCP tables without touching other tables", () => {
    const existing = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'command = "node"',
      "",
      "[mcp_servers.trimemh]",
      'command = "old"',
      "",
      "[mcp_servers.trimemh.env]",
      'TRIMEMH_DB_PATH = "old.db"',
      "",
      "[tools]",
      'web = "enabled"',
    ].join("\n");

    const cleaned = removeCodexTrimemhTables(existing);
    expect(cleaned).toContain("[mcp_servers.other]");
    expect(cleaned).toContain("[tools]");
    expect(cleaned).not.toContain("[mcp_servers.trimemh]");
    expect(cleaned).not.toContain("TRIMEMH_DB_PATH");
  });

  test("formats one trimemh Codex table block", () => {
    const block = formatCodexTrimemhBlock({
      command: "trimemh",
      args: ["mcp", "serve"],
      env: { TRIMEMH_PROJECT_ID: "project-a" },
    });

    expect(block.match(/\[mcp_servers\.trimemh\]/g)?.length).toBe(1);
    expect(block).toContain('command = "trimemh"');
    expect(block).toContain("[mcp_servers.trimemh.env]");
  });
});

describe("hook config helpers", () => {
  test("generates hook capture commands for lifecycle events", () => {
    const generated = generateHookConfig(CLAUDE_AGENT);
    const hooks = generated.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart?.[0]).toBeTruthy();
    expect(JSON.stringify(generated)).toContain(
      "trimemh hooks capture --event session_start --agent claude-code",
    );
  });

  test("mergeHookConfig preserves user hooks and replaces old trimemh hooks", () => {
    const old = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "echo keep" }],
          },
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "trimemh hooks capture --event session_start --agent old",
              },
            ],
          },
        ],
      },
    };
    const merged = mergeHookConfig(old, generateHookConfig(CLAUDE_AGENT));
    const hooks = (merged.hooks as Record<string, unknown[]>).SessionStart;

    expect(JSON.stringify(hooks)).toContain("echo keep");
    expect(JSON.stringify(hooks)).toContain("--agent claude-code");
    expect(JSON.stringify(hooks)).not.toContain("--agent old");
  });
});
