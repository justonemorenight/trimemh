/**
 * Agent Rules Generator — IDE-specific rule/instruction files for triMemh.
 *
 * When triMemh is installed into a project, agents need to know about the
 * memory system. This module generates rule snippets tailored to each IDE/agent
 * and writes them to the appropriate config file.
 *
 * Supported targets:
 * - claude-code   → CLAUDE.md (project root)
 * - codex         → AGENTS.md (project root)
 * - cursor        → .cursor/rules/trimemh.mdc
 * - windsurf      → .windsurfrules (project root)
 * - copilot-cli   → .github/copilot-instructions.md
 * - aider         → .aider/conventions.md
 * - generic       → .trimemh/AGENT_RULES.md
 *
 * All injections are idempotent: re-running replaces old content via markers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ConfigTarget } from "./config-gen";

// ─── Markers ────────────────────────────────────────────────────────

const MARKER_START = "<!-- trimemh:rules:start -->";
const MARKER_END = "<!-- trimemh:rules:end -->";

// ─── Types ──────────────────────────────────────────────────────────

export interface AgentRulesResult {
  target: ConfigTarget;
  filePath: string;
  content: string;
  created: boolean;
  updated: boolean;
}

export interface WriteAgentRulesOptions {
  projectRoot?: string;
  /** If true, do not write files — only return what would be written. */
  dryRun?: boolean;
}

// ─── Core rule content ──────────────────────────────────────────────

/**
 * The canonical triMemh memory protocol text shared across all targets.
 */
function coreRuleContent(): string {
  return `### 🧠 triMemh Memory Protocol (CRITICAL)

This project uses **triMemh** for persistent agent memory.

**Storage paths**
- DB: \`<project-root>/.trimemh/memory.db\`
- Config: \`<project-root>/.memh.toml\`

**MANDATORY**: At the start of EVERY new task, you MUST:
1. Call \`memory_context\` with the task description and current open file paths.
2. Call \`memory_search\` with \`mode: "hybrid"\` to retrieve relevant project knowledge.
3. Call \`memory_list_proposals\` to review pending governance items.

**End of task**: call \`memory_session_close\` with summary, files, decisions, and tooling changes.

**Memory kinds**: use \`tooling\` for setup/config (Biome, Tailwind, test runners), \`decision\` for product choices, \`session_summary\` for turn narrative only.

**Write Path (Explicit)**: When you learn something important about this project:
1. \`memory_propose\` — propose a new memory (goes through governance review)
2. \`memory_feedback\` — rate whether retrieved memories were useful

**Deep Search**: Use \`memory_search\` with \`mode: "hybrid"\` when you need to find specific past decisions or context.

**CCR Retrieval**: If you see \`[N words compressed — retrieve with: memory_retrieve("id")]\` in context,
call \`memory_retrieve\` to fetch the full text on demand.

**MCP tools**: Available under the \`mcp__trimemh__*\` namespace.
**CLI fallback**: \`trimemh context --query "..."\` and \`trimemh recall --limit 10 "..."\`.`;
}

// ─── Per-target formatters ──────────────────────────────────────────

function wrapWithMarkers(content: string): string {
  return `${MARKER_START}\n${content}\n${MARKER_END}`;
}

function markdownRuleBlock(): string {
  return wrapWithMarkers(coreRuleContent());
}

/**
 * Cursor uses `.mdc` files with YAML frontmatter.
 */
function cursorMdcContent(): string {
  return `---
description: triMemh memory protocol — auto-fetch memory for project
globs: "*"
alwaysApply: true
---

${coreRuleContent()}`;
}

// ─── File path resolution ───────────────────────────────────────────

export interface RulesTargetInfo {
  target: ConfigTarget;
  filePath: string;
  /** If true, the entire file is owned by triMemh (overwrite mode). */
  ownedFile: boolean;
}

function resolveRulesTarget(target: ConfigTarget, projectRoot: string): RulesTargetInfo {
  switch (target) {
    case "claude-code":
      return { target, filePath: join(projectRoot, "CLAUDE.md"), ownedFile: false };
    case "codex":
      return { target, filePath: join(projectRoot, "AGENTS.md"), ownedFile: false };
    case "cursor":
      return {
        target,
        filePath: join(projectRoot, ".cursor", "rules", "trimemh.mdc"),
        ownedFile: true,
      };
    case "windsurf":
      return { target, filePath: join(projectRoot, ".windsurfrules"), ownedFile: false };
    case "copilot-cli":
      return {
        target,
        filePath: join(projectRoot, ".github", "copilot-instructions.md"),
        ownedFile: false,
      };
    case "aider":
      return { target, filePath: join(projectRoot, ".aider", "conventions.md"), ownedFile: false };
    case "continue":
    case "generic":
      return {
        target,
        filePath: join(projectRoot, ".trimemh", "AGENT_RULES.md"),
        ownedFile: true,
      };
  }
}

// ─── Idempotent injection ───────────────────────────────────────────

/**
 * Remove any existing triMemh rules block from a file's content.
 */
export function stripExistingRules(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return content;
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MARKER_END.length);
  // Clean up extra blank lines at the join point
  return `${before.trimEnd()}\n${after.trimStart()}`.trim();
}

/**
 * Check if a file already contains triMemh rules.
 */
export function hasExistingRules(content: string): boolean {
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

// ─── Content generation ─────────────────────────────────────────────

/**
 * Generate the rule content string for a specific target.
 */
export function generateRuleContent(target: ConfigTarget): string {
  if (target === "cursor") {
    return cursorMdcContent();
  }
  return markdownRuleBlock();
}

// ─── File writing ───────────────────────────────────────────────────

/**
 * Write agent rules for a target. Idempotent: replaces existing rules if present.
 */
export function writeAgentRules(
  target: ConfigTarget,
  options: WriteAgentRulesOptions = {},
): AgentRulesResult {
  const projectRoot = options.projectRoot ?? process.cwd();
  const info = resolveRulesTarget(target, projectRoot);
  const content = generateRuleContent(target);

  if (options.dryRun) {
    return {
      target: info.target,
      filePath: info.filePath,
      content,
      created: !existsSync(info.filePath),
      updated: false,
    };
  }

  // Ensure parent directory exists
  const dir = dirname(info.filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Cursor: owned file — always overwrite
  if (info.ownedFile) {
    const existed = existsSync(info.filePath);
    writeFileSync(info.filePath, `${content}\n`);
    return {
      target: info.target,
      filePath: info.filePath,
      content,
      created: !existed,
      updated: existed,
    };
  }

  // Append/update mode: inject into existing file with markers
  if (existsSync(info.filePath)) {
    const existing = readFileSync(info.filePath, "utf-8");
    if (hasExistingRules(existing)) {
      // Replace existing rules block
      const stripped = stripExistingRules(existing);
      const next = stripped.length > 0 ? `${stripped}\n\n${content}\n` : `${content}\n`;
      writeFileSync(info.filePath, next);
      return {
        target: info.target,
        filePath: info.filePath,
        content,
        created: false,
        updated: true,
      };
    }
    // Append to existing file
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(info.filePath, `${existing}${separator}${content}\n`);
    return {
      target: info.target,
      filePath: info.filePath,
      content,
      created: false,
      updated: false,
    };
  }

  // Create new file
  writeFileSync(info.filePath, `${content}\n`);
  return {
    target: info.target,
    filePath: info.filePath,
    content,
    created: true,
    updated: false,
  };
}

/**
 * Write agent rules for multiple targets.
 */
export function writeAgentRulesForTargets(
  targets: ConfigTarget[],
  options: WriteAgentRulesOptions = {},
): AgentRulesResult[] {
  return targets.map((target) => writeAgentRules(target, options));
}

/**
 * Get the file path where rules would be written for a target.
 */
export function getRulesFilePath(target: ConfigTarget, projectRoot?: string): string {
  return resolveRulesTarget(target, projectRoot ?? process.cwd()).filePath;
}

/**
 * List all supported targets with their rules file paths.
 */
export function listRulesTargets(
  projectRoot?: string,
): Array<{ target: ConfigTarget; filePath: string; description: string }> {
  const root = projectRoot ?? process.cwd();
  return [
    {
      target: "claude-code" as ConfigTarget,
      filePath: resolveRulesTarget("claude-code", root).filePath,
      description: "Claude Code — CLAUDE.md",
    },
    {
      target: "codex" as ConfigTarget,
      filePath: resolveRulesTarget("codex", root).filePath,
      description: "OpenAI Codex — AGENTS.md",
    },
    {
      target: "cursor" as ConfigTarget,
      filePath: resolveRulesTarget("cursor", root).filePath,
      description: "Cursor IDE — .cursor/rules/trimemh.mdc",
    },
    {
      target: "windsurf" as ConfigTarget,
      filePath: resolveRulesTarget("windsurf", root).filePath,
      description: "Windsurf IDE — .windsurfrules",
    },
    {
      target: "copilot-cli" as ConfigTarget,
      filePath: resolveRulesTarget("copilot-cli", root).filePath,
      description: "GitHub Copilot CLI — .github/copilot-instructions.md",
    },
    {
      target: "aider" as ConfigTarget,
      filePath: resolveRulesTarget("aider", root).filePath,
      description: "Aider — .aider/conventions.md",
    },
    {
      target: "generic" as ConfigTarget,
      filePath: resolveRulesTarget("generic", root).filePath,
      description: "Generic — .trimemh/AGENT_RULES.md",
    },
  ];
}
