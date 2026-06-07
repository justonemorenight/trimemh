import { describe, expect, test } from "bun:test";

import type { TriMemhConfig } from "../src/domain/schema";
import {
  formatConfigAsJSON,
  generateAllMCPConfigs,
  generateMCPConfig,
  listTargets,
} from "../src/mcp/config-gen";

const TEST_CONFIG: TriMemhConfig = {
  projectId: "test-project-abc123",
  dbPath: "/home/user/project/.trimemh/memory.db",
};

type MCPServerConfig = Record<string, unknown> & {
  cwd?: unknown;
  env?: {
    TRIMEMH_DB_PATH?: unknown;
    TRIMEMH_PROJECT_ID?: unknown;
  };
};

describe("generateMCPConfig", () => {
  test("generates claude-code config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "claude-code");
    expect(result.target).toBe("claude-code");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const config = result.config as any;
    expect(config.mcpServers.trimemh.type).toBe("stdio");
    expect(config.mcpServers.trimemh.cwd).toBeUndefined();
    expect(config.mcpServers.trimemh.env).toBeUndefined();
    expect(result.installInstructions).toContain("claude");
  });

  test("generates cursor config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "cursor");
    expect(result.target).toBe("cursor");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const config = result.config as any;
    expect(config.mcpServers.trimemh.cwd).toBeUndefined();
    expect(config.mcpServers.trimemh.env).toBeUndefined();
  });

  test("generates continue config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "continue");
    expect(result.target).toBe("continue");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const config = result.config as any;
    expect(Array.isArray(config.mcpServers)).toBe(true);
    expect(config.mcpServers[0].name).toBe("trimemh");
  });

  test("generates windsurf config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "windsurf");
    expect(result.target).toBe("windsurf");
  });

  test("generates copilot-cli config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "copilot-cli");
    expect(result.target).toBe("copilot-cli");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const config = result.config as any;
    expect(config.mcpServers.trimemh.type).toBe("stdio");
  });

  test("generates aider config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "aider");
    expect(result.target).toBe("aider");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const config = result.config as any;
    expect(config.mcpServers.trimemh.command).toBeTruthy();
  });

  test("generates generic config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "generic");
    expect(result.target).toBe("generic");
  });

  test("all configs omit cwd by default", () => {
    const configs = generateAllMCPConfigs(TEST_CONFIG);
    for (const gen of configs) {
      const server = extractServer(gen.config);
      expect(server.cwd).toBeUndefined();
    }
  });

  test("can include explicit cwd when requested", () => {
    const configs = generateAllMCPConfigs(TEST_CONFIG, { includeCwd: true });
    for (const gen of configs) {
      const server = extractServer(gen.config);
      expect(server.cwd).toBe(process.cwd());
    }
  });

  test("can include explicit env pins when requested", () => {
    const configs = generateAllMCPConfigs(TEST_CONFIG, { includeEnv: true });
    for (const gen of configs) {
      const server = extractServer(gen.config);
      expect(server.env.TRIMEMH_PROJECT_ID).toBe(TEST_CONFIG.projectId);
      expect(server.env.TRIMEMH_DB_PATH).toBe(TEST_CONFIG.dbPath);
    }
  });

  test("throws on unknown target", () => {
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    expect(() => generateMCPConfig(TEST_CONFIG, "unknown" as any)).toThrow();
  });
});

describe("formatConfigAsJSON", () => {
  test("produces valid JSON", () => {
    const generated = generateMCPConfig(TEST_CONFIG, "generic");
    const json = formatConfigAsJSON(generated);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe("listTargets", () => {
  test("includes all known targets", () => {
    const targets = listTargets();
    expect(targets.length).toBe(8);
    const names = targets.map((t) => t.target);
    expect(names).toContain("claude-code");
    expect(names).toContain("codex");
    expect(names).toContain("cursor");
    expect(names).toContain("continue");
    expect(names).toContain("windsurf");
    expect(names).toContain("copilot-cli");
    expect(names).toContain("aider");
    expect(names).toContain("generic");
  });
});

// Helper: extract server from different config shapes
function extractServer(config: Record<string, unknown>): MCPServerConfig {
  const servers = config.mcpServers ?? config.servers ?? config.mcp_servers;
  if (Array.isArray(servers)) {
    return asServerConfig(servers[0]);
  }
  return asServerConfig(isRecord(servers) ? servers.trimemh : undefined);
}

function asServerConfig(value: unknown): MCPServerConfig {
  return isRecord(value) ? (value as MCPServerConfig) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
