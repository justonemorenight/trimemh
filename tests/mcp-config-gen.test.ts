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

describe("generateMCPConfig", () => {
  test("generates claude-code config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "claude-code");
    expect(result.target).toBe("claude-code");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const config = result.config as any;
    expect(config.mcpServers.trimemh.type).toBe("stdio");
    expect(config.mcpServers.trimemh.env.TRIMEMH_PROJECT_ID).toBe(TEST_CONFIG.projectId);
    expect(result.installInstructions).toContain("claude");
  });

  test("generates cursor config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "cursor");
    expect(result.target).toBe("cursor");
    // biome-ignore lint/suspicious/noExplicitAny: warning suppression
    const config = result.config as any;
    expect(config.mcpServers.trimemh.env.TRIMEMH_DB_PATH).toBe(TEST_CONFIG.dbPath);
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

  test("generates generic config", () => {
    const result = generateMCPConfig(TEST_CONFIG, "generic");
    expect(result.target).toBe("generic");
  });

  test("all configs include project ID in env", () => {
    const configs = generateAllMCPConfigs(TEST_CONFIG);
    for (const gen of configs) {
      const env = extractEnv(gen.config);
      expect(env.TRIMEMH_PROJECT_ID).toBe(TEST_CONFIG.projectId);
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
    expect(targets.length).toBe(5);
    const names = targets.map((t) => t.target);
    expect(names).toContain("claude-code");
    expect(names).toContain("cursor");
    expect(names).toContain("continue");
    expect(names).toContain("windsurf");
    expect(names).toContain("generic");
  });
});

// Helper: extract env from different config shapes
function extractEnv(config: Record<string, unknown>): Record<string, string> {
  const servers = config.mcpServers ?? config.servers;
  if (Array.isArray(servers)) {
    return servers[0]?.env ?? {};
  }
  // biome-ignore lint/suspicious/noExplicitAny: warning suppression
  return (servers as any)?.trimemh?.env ?? {};
}
