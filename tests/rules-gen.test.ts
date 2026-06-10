import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigTarget } from "../src/mcp/config-gen";
import {
  generateRuleContent,
  getRulesFilePath,
  hasExistingRules,
  listRulesTargets,
  stripExistingRules,
  writeAgentRules,
  writeAgentRulesForTargets,
} from "../src/mcp/rules-gen";

const TEST_DIR = join(import.meta.dir, ".tmp-rules-test");

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(cleanup);

// ─── Content generation ─────────────────────────────────────────────

describe("generateRuleContent", () => {
  it("generates markdown rule block for claude-code", () => {
    const content = generateRuleContent("claude-code");
    expect(content).toContain("trimemh:rules:start");
    expect(content).toContain("trimemh:rules:end");
    expect(content).toContain("triMemh Memory Protocol");
    expect(content).toContain("memory_context");
    expect(content).toContain("memory_propose");
    expect(content).toContain("mcp__trimemh__");
  });

  it("generates markdown rule block for codex", () => {
    const content = generateRuleContent("codex");
    expect(content).toContain("trimemh:rules:start");
    expect(content).toContain("memory_search");
  });

  it("generates .mdc format for cursor with frontmatter", () => {
    const content = generateRuleContent("cursor");
    expect(content).toContain("---");
    expect(content).toContain("description:");
    expect(content).toContain("globs:");
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("triMemh Memory Protocol");
    // Cursor .mdc does NOT use HTML markers (file is owned)
    expect(content).not.toContain("trimemh:rules:start");
  });

  it("generates markdown rule block for windsurf", () => {
    const content = generateRuleContent("windsurf");
    expect(content).toContain("trimemh:rules:start");
    expect(content).toContain("CLI fallback");
  });

  it("generates markdown rule block for generic", () => {
    const content = generateRuleContent("generic");
    expect(content).toContain("trimemh:rules:start");
  });

  for (const target of [
    "claude-code",
    "codex",
    "cursor",
    "windsurf",
    "copilot-cli",
    "aider",
    "generic",
  ] as ConfigTarget[]) {
    it(`generates non-empty content for ${target}`, () => {
      const content = generateRuleContent(target);
      expect(content.length).toBeGreaterThan(100);
    });
  }
});

// ─── Marker helpers ─────────────────────────────────────────────────

describe("hasExistingRules", () => {
  it("returns true when markers are present", () => {
    expect(
      hasExistingRules(
        "before\n<!-- trimemh:rules:start -->\nrules\n<!-- trimemh:rules:end -->\nafter",
      ),
    ).toBe(true);
  });

  it("returns false when no markers", () => {
    expect(hasExistingRules("some random content")).toBe(false);
  });

  it("returns false when only start marker", () => {
    expect(hasExistingRules("<!-- trimemh:rules:start -->\nrules")).toBe(false);
  });
});

describe("stripExistingRules", () => {
  it("removes rules block between markers", () => {
    const input =
      "before\n\n<!-- trimemh:rules:start -->\nold rules\n<!-- trimemh:rules:end -->\n\nafter";
    const result = stripExistingRules(input);
    expect(result).not.toContain("old rules");
    expect(result).not.toContain("trimemh:rules:start");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("returns content unchanged when no markers", () => {
    const input = "no markers here";
    expect(stripExistingRules(input)).toBe(input);
  });

  it("handles markers at start of file", () => {
    const input = "<!-- trimemh:rules:start -->\nrules\n<!-- trimemh:rules:end -->\nafter";
    const result = stripExistingRules(input);
    expect(result).not.toContain("rules");
    expect(result).toContain("after");
  });

  it("handles markers at end of file", () => {
    const input = "before\n<!-- trimemh:rules:start -->\nrules\n<!-- trimemh:rules:end -->";
    const result = stripExistingRules(input);
    expect(result).not.toContain("trimemh:rules");
    expect(result).toContain("before");
  });
});

// ─── File writing ───────────────────────────────────────────────────

describe("writeAgentRules", () => {
  it("creates a new CLAUDE.md when none exists", () => {
    const result = writeAgentRules("claude-code", { projectRoot: TEST_DIR });
    expect(result.created).toBe(true);
    expect(result.updated).toBe(false);
    expect(existsSync(result.filePath)).toBe(true);

    const written = readFileSync(result.filePath, "utf-8");
    expect(written).toContain("triMemh Memory Protocol");
    expect(written).toContain("trimemh:rules:start");
  });

  it("appends to existing CLAUDE.md without rules", () => {
    const filePath = join(TEST_DIR, "CLAUDE.md");
    writeFileSync(filePath, "# My Project\n\nExisting content.\n");

    const result = writeAgentRules("claude-code", { projectRoot: TEST_DIR });
    expect(result.created).toBe(false);
    expect(result.updated).toBe(false);

    const written = readFileSync(result.filePath, "utf-8");
    expect(written).toContain("# My Project");
    expect(written).toContain("Existing content.");
    expect(written).toContain("triMemh Memory Protocol");
  });

  it("replaces existing rules in CLAUDE.md (idempotent update)", () => {
    const filePath = join(TEST_DIR, "CLAUDE.md");
    writeFileSync(
      filePath,
      "# My Project\n\n<!-- trimemh:rules:start -->\nOLD RULES\n<!-- trimemh:rules:end -->\n\n# Footer\n",
    );

    const result = writeAgentRules("claude-code", { projectRoot: TEST_DIR });
    expect(result.updated).toBe(true);
    expect(result.created).toBe(false);

    const written = readFileSync(result.filePath, "utf-8");
    expect(written).not.toContain("OLD RULES");
    expect(written).toContain("triMemh Memory Protocol");
    expect(written).toContain("# My Project");
    expect(written).toContain("# Footer");

    // Markers should appear exactly once
    const starts = written.match(/trimemh:rules:start/g);
    expect(starts?.length).toBe(1);
  });

  it("creates .cursor/rules/trimemh.mdc with frontmatter", () => {
    const result = writeAgentRules("cursor", { projectRoot: TEST_DIR });
    expect(result.created).toBe(true);
    expect(result.filePath).toContain(".cursor/rules/trimemh.mdc");

    const written = readFileSync(result.filePath, "utf-8");
    expect(written).toContain("---");
    expect(written).toContain("alwaysApply: true");
    expect(written).toContain("triMemh Memory Protocol");
  });

  it("overwrites existing .cursor/rules/trimemh.mdc (owned file)", () => {
    const dir = join(TEST_DIR, ".cursor", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "trimemh.mdc"), "old content");

    const result = writeAgentRules("cursor", { projectRoot: TEST_DIR });
    expect(result.updated).toBe(true);

    const written = readFileSync(result.filePath, "utf-8");
    expect(written).not.toContain("old content");
    expect(written).toContain("triMemh Memory Protocol");
  });

  it("creates .windsurfrules with markers", () => {
    const result = writeAgentRules("windsurf", { projectRoot: TEST_DIR });
    expect(result.created).toBe(true);

    const written = readFileSync(result.filePath, "utf-8");
    expect(written).toContain("trimemh:rules:start");
  });

  it("creates .trimemh/AGENT_RULES.md for generic target", () => {
    const result = writeAgentRules("generic", { projectRoot: TEST_DIR });
    expect(result.created).toBe(true);
    expect(result.filePath).toContain(".trimemh/AGENT_RULES.md");

    const written = readFileSync(result.filePath, "utf-8");
    expect(written).toContain("triMemh Memory Protocol");
  });

  it("dry run does not write files", () => {
    const result = writeAgentRules("claude-code", {
      projectRoot: TEST_DIR,
      dryRun: true,
    });
    expect(result.created).toBe(true); // would create
    expect(existsSync(result.filePath)).toBe(false); // but didn't
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe("writeAgentRulesForTargets", () => {
  it("writes rules for multiple targets", () => {
    const results = writeAgentRulesForTargets(["claude-code", "cursor"], {
      projectRoot: TEST_DIR,
    });
    expect(results.length).toBe(2);
    expect(results[0]?.target).toBe("claude-code");
    expect(results[1]?.target).toBe("cursor");
    expect(existsSync(results[0]!.filePath)).toBe(true);
    expect(existsSync(results[1]!.filePath)).toBe(true);
  });
});

// ─── Utility functions ──────────────────────────────────────────────

describe("getRulesFilePath", () => {
  it("returns correct path for each target", () => {
    expect(getRulesFilePath("claude-code", TEST_DIR)).toBe(join(TEST_DIR, "CLAUDE.md"));
    expect(getRulesFilePath("codex", TEST_DIR)).toBe(join(TEST_DIR, "AGENTS.md"));
    expect(getRulesFilePath("cursor", TEST_DIR)).toBe(
      join(TEST_DIR, ".cursor", "rules", "trimemh.mdc"),
    );
    expect(getRulesFilePath("windsurf", TEST_DIR)).toBe(join(TEST_DIR, ".windsurfrules"));
    expect(getRulesFilePath("copilot-cli", TEST_DIR)).toBe(
      join(TEST_DIR, ".github", "copilot-instructions.md"),
    );
    expect(getRulesFilePath("aider", TEST_DIR)).toBe(join(TEST_DIR, ".aider", "conventions.md"));
    expect(getRulesFilePath("generic", TEST_DIR)).toBe(
      join(TEST_DIR, ".trimemh", "AGENT_RULES.md"),
    );
  });
});

describe("listRulesTargets", () => {
  it("lists all supported targets", () => {
    const targets = listRulesTargets(TEST_DIR);
    expect(targets.length).toBe(7);
    const ids = targets.map((t) => t.target);
    expect(ids).toContain("claude-code");
    expect(ids).toContain("cursor");
    expect(ids).toContain("windsurf");
    expect(ids).toContain("generic");
  });
});
