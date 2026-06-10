/**
 * trimemh learn — Session Mining & Auto-Correction (P2 — Agent Intelligence)
 *
 * Inspired by headroom's `headroom learn`: mines failed agent sessions
 * to detect patterns and auto-propose memory corrections.
 *
 * Pipeline:
 *   1. Parse conversation logs (Claude Code transcripts, MCP traces)
 *   2. Detect failure patterns:
 *      - "I don't know" / "I'm not sure" → missing memory
 *      - repeated corrections → wrong memory
 *      - retries / fallbacks → incomplete procedure
 *      - the same question asked again → memory not surfaced
 *   3. Map failures to candidate memory corrections
 *   4. Risk-assess each correction
 *   5. Auto-approve low-risk, propose high-risk
 *
 * This creates a SELF-IMPROVING memory system — every failure makes
 * the system smarter for the next session.
 */

import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import type { MemoryKind, RiskLevel } from "../domain/schema";

// ─── Types ──────────────────────────────────────────────────────────

export interface FailurePattern {
  /** Type of failure detected */
  type: "missing_knowledge" | "wrong_memory" | "incomplete_procedure" | "not_surfaced";
  /** The query or context where the failure occurred */
  context: string;
  /** Evidence from the conversation log */
  evidence: string;
  /** Confidence that this is a real failure (0-1) */
  confidence: number;
}

export interface LearnedCorrection {
  /** Proposed action */
  action: "create" | "update" | "delete";
  /** The memory kind to create/update */
  kind: MemoryKind;
  /** Proposed memory text */
  proposedText: string;
  /** Target memory ID (for update/delete) */
  targetMemoryId?: string;
  /** Rationale auto-generated from failure analysis */
  rationale: string;
  /** Risk level */
  risk: RiskLevel;
  /** Evidence from the session */
  evidence: string;
}

export interface LearnResult {
  /** Number of sessions analyzed */
  sessionsAnalyzed: number;
  /** Failures detected */
  failuresDetected: number;
  /** Recovery pairs detected (failed → successful) */
  recoveryPairsDetected: number;
  /** Corrections proposed */
  correctionsProposed: number;
  /** Corrections auto-approved (low risk) */
  autoApproved: number;
  /** Corrections pending approval (medium+ risk) */
  pendingApproval: number;
  /** Detailed correction list */
  corrections: LearnedCorrection[];
}

// ─── Tool call event types ──────────────────────────────────────────

export type ToolCategory = "file_read" | "file_write" | "command" | "search" | "web" | "other";

/** A normalized tool call extracted from a session transcript */
export interface ToolCallEvent {
  /** Index in the original log */
  index: number;
  /** Tool name */
  tool: string;
  /** Tool category */
  category: ToolCategory;
  /** Key arguments (path, command, query, etc.) */
  args: Record<string, string>;
  /** Whether this call succeeded or failed */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Raw line for evidence */
  rawLine: string;
}

export type RecoveryPattern =
  | "wrong_path"
  | "wrong_command"
  | "narrow_search"
  | "missing_dep"
  | "wrong_args"
  | "fallback_tool";

export interface RecoveryPair {
  /** The failed action */
  failed: ToolCallEvent;
  /** The successful recovery action */
  recovered: ToolCallEvent;
  /** Type of recovery pattern */
  pattern: RecoveryPattern;
  /** Confidence 0-1 */
  confidence: number;
}

// ─── Failure pattern detectors ──────────────────────────────────────

interface PatternDetector {
  type: FailurePattern["type"];
  /** Returns match confidence 0-1, or 0 for no match */
  detect: (line: string, context: string[]) => number;
}

const DETECTORS: PatternDetector[] = [
  {
    type: "missing_knowledge",
    detect: (line) => {
      const patterns = [
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bI don't know\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bI'm not sure\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bI don't have (?:enough |sufficient )?(?:context|information|knowledge)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bI (?:can't|cannot) (?:answer|help|find)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bno (?:relevant |matching )?(?:memories|results|context) found\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bunable to (?:determine|find|locate|retrieve)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\b(?:could not|couldn't) (?:find|locate|determine)\b/i,
      ];
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          return 0.7;
        }
      }
      return 0;
    },
  },
  {
    type: "wrong_memory",
    detect: (line, context) => {
      const patterns = [
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bthat'?s (?:incorrect|wrong|not right|outdated)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\b(?:actually|correction|I stand corrected)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bthe (?:correct|right|actual) (?:answer|value|approach|way) is\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bthis (?:memory|information) is (?:incorrect|wrong|outdated|stale)\b/i,
      ];
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          return 0.65;
        }
      }
      // Boost confidence if correction appears in following lines
      const lineIdx = context.indexOf(line);
      if (lineIdx >= 0) {
        const nextLines = context.slice(lineIdx, lineIdx + 3).join(" ");
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        if (/\b(?:instead|rather|should be|actually)\b/i.test(nextLines)) {
          return 0.8;
        }
      }
      return 0;
    },
  },
  {
    type: "incomplete_procedure",
    detect: (line, _context) => {
      const patterns = [
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bmissing (?:step|dependency|prerequisite|requirement)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\b(?:also|additionally|don't forget|remember to)\b.*\b(?:need|must|should|have to)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bthat (?:failed|didn't work|broke) because\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bgot an error.*trying to\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\b(?:tried|attempted).*(?:but|however|still).*(?:fail|error|broken)\b/i,
      ];
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          return 0.6;
        }
      }
      return 0;
    },
  },
  {
    type: "not_surfaced",
    detect: (line, _context) => {
      // Detect when the same question is asked again (memory not surfaced)
      const patterns = [
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\b(?:again|still|once more|repeating)\b.*\b(?:how|what|where|when|why|which)\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\b(?:as I (?:asked|mentioned|said) (?:before|earlier|previously))\b/i,
        // biome-ignore lint/performance/useTopLevelRegex: warning suppression
        /\bI (?:already|previously) (?:asked|mentioned|said)\b/i,
      ];
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          return 0.55;
        }
      }
      return 0;
    },
  },
];

// ─── Session parsing ────────────────────────────────────────────────

/**
 * Parse a raw conversation log into structured lines.
 * Handles Claude Code transcript format and generic JSONL.
 */
function parseSessionLog(raw: string): string[] {
  const lines: string[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Try JSONL format (Claude Code transcript)
    try {
      const entry = JSON.parse(trimmed);
      if (entry.message?.content) {
        if (Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.text) {
              lines.push(block.text);
            }
          }
        } else if (typeof entry.message.content === "string") {
          lines.push(entry.message.content);
        }
        continue;
      }
      if (entry.text) {
        lines.push(entry.text);
        continue;
      }
      if (entry.content) {
        lines.push(entry.content);
        continue;
      }
    } catch {
      // Not JSON — treat as plain text
    }

    lines.push(trimmed);
  }

  return lines;
}

// ─── Tool call event parsing ────────────────────────────────────────

const ARG_CAMEL_BOUNDARY_RE = /([a-z0-9])([A-Z])/g;
const ARG_SEPARATOR_RE = /[-\s]+/g;
const MISSING_DEP_ERROR_RE =
  /\b(not found|enoent|missing|command not found|module not found|cannot find)\b/;
const INSTALL_COMMAND_RE = /\b(install|add|apt|brew|npm|yarn|bun|pip)\b/;

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  read_file: "file_read",
  view_file: "file_read",
  Read: "file_read",
  write_to_file: "file_write",
  replace_file_content: "file_write",
  multi_replace_file_content: "file_write",
  Edit: "file_write",
  run_command: "command",
  Bash: "command",
  bash: "command",
  search: "search",
  grep_search: "search",
  Grep: "search",
  glob: "search",
  search_web: "web",
  read_url: "web",
  WebFetch: "web",
};

function categorizeToolCall(tool: string): ToolCategory {
  return TOOL_CATEGORIES[tool] ?? "other";
}

function normalizeArgKey(key: string): string {
  return key.replace(ARG_CAMEL_BOUNDARY_RE, "$1_$2").replace(ARG_SEPARATOR_RE, "_").toLowerCase();
}

function extractToolArgs(toolInput: unknown): Record<string, string> {
  if (typeof toolInput !== "object" || toolInput === null) {
    return {};
  }
  const args: Record<string, string> = {};
  const input = toolInput as Record<string, unknown>;
  for (const key of [
    "path",
    "file_path",
    "AbsolutePath",
    "TargetFile",
    "command",
    "CommandLine",
    "query",
    "Query",
    "SearchPath",
    "pattern",
    "url",
    "Url",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      args[normalizeArgKey(key)] = value;
    }
  }
  return args;
}

function toolUseFromBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  return block.type === "tool_use" ? block : null;
}

function toolResultFromBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  return block.type === "tool_result" ? block : null;
}

/**
 * Parse structured tool call events from a session transcript.
 * Handles Claude Code JSONL, Antigravity JSONL, and generic formats.
 */
export function parseToolCallEvents(raw: string): ToolCallEvent[] {
  const events: ToolCallEvent[] = [];
  const eventIndexByToolUseId = new Map<string, number>();
  let index = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const entry = JSON.parse(trimmed);

      // Claude Code format: tool_use / tool_result blocks
      if (entry.type === "tool_use" || entry.message?.type === "tool_use") {
        const toolUse = entry.type === "tool_use" ? entry : entry.message;
        const tool = toolUse.name ?? toolUse.tool_name ?? "";
        if (tool) {
          const eventPosition = events.length;
          events.push({
            index: index++,
            tool,
            category: categorizeToolCall(tool),
            args: extractToolArgs(toolUse.input ?? toolUse.tool_input ?? {}),
            success: true, // will be updated by tool_result
            rawLine: trimmed.slice(0, 500),
          });
          if (typeof toolUse.id === "string") {
            eventIndexByToolUseId.set(toolUse.id, eventPosition);
          }
        }
        continue;
      }

      // Claude Code format: tool_result
      if (entry.type === "tool_result" || entry.message?.type === "tool_result") {
        const result = entry.type === "tool_result" ? entry : entry.message;
        const eventPosition =
          typeof result.tool_use_id === "string"
            ? eventIndexByToolUseId.get(result.tool_use_id)
            : undefined;
        const event =
          eventPosition !== undefined ? events[eventPosition] : events[events.length - 1];
        if (event && result.is_error) {
          event.success = false;
          event.error =
            typeof result.content === "string"
              ? result.content.slice(0, 300)
              : JSON.stringify(result.content).slice(0, 300);
        }
        continue;
      }

      // Claude Code transcript format: message.content contains tool blocks.
      if (Array.isArray(entry.message?.content)) {
        let handledToolBlock = false;
        for (const block of entry.message.content) {
          if (typeof block !== "object" || block === null) {
            continue;
          }
          const blockRecord = block as Record<string, unknown>;
          const toolUse = toolUseFromBlock(blockRecord);
          if (toolUse) {
            const tool = toolUse.name ?? toolUse.tool_name ?? "";
            if (typeof tool === "string" && tool.trim()) {
              const eventPosition = events.length;
              events.push({
                index: index++,
                tool,
                category: categorizeToolCall(tool),
                args: extractToolArgs(toolUse.input ?? toolUse.tool_input ?? {}),
                success: true,
                rawLine: trimmed.slice(0, 500),
              });
              if (typeof toolUse.id === "string") {
                eventIndexByToolUseId.set(toolUse.id, eventPosition);
              }
              handledToolBlock = true;
            }
            continue;
          }

          const result = toolResultFromBlock(blockRecord);
          if (result) {
            const eventPosition =
              typeof result.tool_use_id === "string"
                ? eventIndexByToolUseId.get(result.tool_use_id)
                : undefined;
            const event =
              eventPosition !== undefined ? events[eventPosition] : events[events.length - 1];
            if (event && result.is_error) {
              event.success = false;
              event.error =
                typeof result.content === "string"
                  ? result.content.slice(0, 300)
                  : JSON.stringify(result.content).slice(0, 300);
            }
            handledToolBlock = true;
          }
        }
        if (handledToolBlock) {
          continue;
        }
      }

      // Antigravity / generic format: tool_calls array in step
      if (Array.isArray(entry.tool_calls)) {
        for (const call of entry.tool_calls) {
          const tool = call.name ?? call.tool ?? "";
          if (!tool) {
            continue;
          }
          const isError = entry.status === "ERROR" || call.status === "ERROR";
          events.push({
            index: index++,
            tool,
            category: categorizeToolCall(tool),
            args: extractToolArgs(call.arguments ?? call.input ?? {}),
            success: !isError,
            error: isError
              ? (call.error ?? entry.error ?? "unknown error").toString().slice(0, 300)
              : undefined,
            rawLine: trimmed.slice(0, 500),
          });
        }
        continue;
      }

      // Generic: single tool call in entry
      const tool = entry.tool_name ?? entry.tool ?? entry.name;
      if (typeof tool === "string" && tool.trim()) {
        const isError =
          entry.is_error === true ||
          entry.status === "error" ||
          entry.status === "ERROR" ||
          entry.success === false;
        events.push({
          index: index++,
          tool,
          category: categorizeToolCall(tool),
          args: extractToolArgs(entry.input ?? entry.tool_input ?? entry.arguments ?? {}),
          success: !isError,
          error: isError
            ? (entry.error ?? entry.error_message ?? "").toString().slice(0, 300)
            : undefined,
          rawLine: trimmed.slice(0, 500),
        });
      }
    } catch {
      // Not JSON — skip for tool call parsing
    }
  }

  return events;
}

/**
 * Detect failure patterns in a parsed session.
 */
function detectFailures(lines: string[]): FailurePattern[] {
  const failures: FailurePattern[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }

    for (const detector of DETECTORS) {
      const confidence = detector.detect(line, lines);
      if (confidence > 0) {
        // Extract surrounding context (5 lines before/after)
        const start = Math.max(0, i - 5);
        const end = Math.min(lines.length, i + 6);
        const context = lines.slice(start, end).join(" ");

        failures.push({
          type: detector.type,
          context: context.slice(0, 500),
          evidence: line.slice(0, 300),
          confidence,
        });
      }
    }
  }

  // Deduplicate similar failures
  return deduplicateFailures(failures);
}

function deduplicateFailures(failures: FailurePattern[]): FailurePattern[] {
  const seen = new Set<string>();
  return failures.filter((f) => {
    const key = `${f.type}:${f.evidence.slice(0, 60)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// ─── Recovery pair detection ────────────────────────────────────────

const RECOVERY_WINDOW = 8;

function pathBasename(p: string): string {
  return p.split("/").pop() ?? p;
}

function primaryArg(event: ToolCallEvent): string {
  // For search tools, the query is the distinguishing argument, not the path
  if (event.category === "search") {
    return (
      event.args.query ?? event.args.search_path ?? event.args.path ?? event.args.pattern ?? ""
    );
  }
  return (
    event.args.path ??
    event.args.file_path ??
    event.args.absolute_path ??
    event.args.target_file ??
    event.args.command ??
    event.args.command_line ??
    event.args.query ??
    event.args.search_path ??
    ""
  );
}

function matchRecoveryPattern(
  failed: ToolCallEvent,
  recovered: ToolCallEvent,
): { pattern: RecoveryPattern; confidence: number } | null {
  // Same category check
  if (failed.category === recovered.category) {
    const failedArg = primaryArg(failed);
    const recoveredArg = primaryArg(recovered);

    if (!(failedArg && recoveredArg)) {
      return null;
    }
    if (failedArg === recoveredArg) {
      return null;
    }

    switch (failed.category) {
      case "file_read":
      case "file_write": {
        // wrong_path: different paths, possibly same basename or similar directory
        const failedBase = pathBasename(failedArg);
        const recoveredBase = pathBasename(recoveredArg);
        if (failedBase === recoveredBase) {
          return { pattern: "wrong_path", confidence: 0.85 };
        }
        // Same directory prefix
        const failedDir = failedArg.split("/").slice(0, -1).join("/");
        const recoveredDir = recoveredArg.split("/").slice(0, -1).join("/");
        if (
          failedDir &&
          recoveredDir &&
          (failedDir.includes(recoveredDir) || recoveredDir.includes(failedDir))
        ) {
          return { pattern: "wrong_path", confidence: 0.65 };
        }
        return { pattern: "wrong_path", confidence: 0.5 };
      }

      case "command": {
        // wrong_command: different commands
        // Check for missing_dep pattern: error contains "not found" / "ENOENT" / "missing"
        const errorLower = (failed.error ?? "").toLowerCase();
        if (
          MISSING_DEP_ERROR_RE.test(errorLower) &&
          INSTALL_COMMAND_RE.test(recoveredArg.toLowerCase())
        ) {
          return { pattern: "missing_dep", confidence: 0.8 };
        }
        // Generic wrong command
        const failedPrefix = failedArg.split(" ").slice(0, 2).join(" ");
        const recoveredPrefix = recoveredArg.split(" ").slice(0, 2).join(" ");
        if (failedPrefix === recoveredPrefix) {
          return { pattern: "wrong_args", confidence: 0.7 };
        }
        return { pattern: "wrong_command", confidence: 0.6 };
      }

      case "search": {
        // narrow_search: failed search (likely 0 results) → broader search
        return { pattern: "narrow_search", confidence: 0.65 };
      }

      default:
        return { pattern: "wrong_args", confidence: 0.5 };
    }
  }

  // Different category but same general area = fallback_tool
  if (failed.category !== "other" && recovered.category !== "other") {
    return { pattern: "fallback_tool", confidence: 0.45 };
  }

  return null;
}

/**
 * Detect recovery pairs: failed action followed by successful action within a window.
 */
export function detectRecoveryPairs(events: ToolCallEvent[]): RecoveryPair[] {
  const pairs: RecoveryPair[] = [];
  const usedRecoveries = new Set<number>();

  for (let i = 0; i < events.length; i++) {
    const failed = events[i];
    if (!failed || failed.success) {
      continue;
    }

    // Scan forward within recovery window
    const windowEnd = Math.min(events.length, i + 1 + RECOVERY_WINDOW);
    for (let j = i + 1; j < windowEnd; j++) {
      const candidate = events[j];
      if (!candidate?.success || usedRecoveries.has(j)) {
        continue;
      }

      const match = matchRecoveryPattern(failed, candidate);
      if (match) {
        pairs.push({
          failed,
          recovered: candidate,
          pattern: match.pattern,
          confidence: match.confidence,
        });
        usedRecoveries.add(j);
        break; // First recovery wins
      }
    }
  }

  return pairs;
}

// ─── Failure → correction mapping ───────────────────────────────────

/**
 * Map a detected failure to a proposed memory correction.
 */
function correctionForFailure(failure: FailurePattern): LearnedCorrection | null {
  switch (failure.type) {
    case "missing_knowledge":
      return {
        action: "create",
        kind: inferKindFromContext(failure.context),
        proposedText: extractKnowledgeGap(failure.context),
        rationale: `Agent reported missing knowledge: "${failure.evidence.slice(0, 100)}"`,
        risk: inferRisk(failure.context),
        evidence: failure.evidence,
      };

    case "wrong_memory":
      return {
        action: "update",
        kind: "fact",
        proposedText: extractCorrectAnswer(failure.context),
        rationale: `Agent corrected existing memory: "${failure.evidence.slice(0, 100)}"`,
        risk: "medium",
        evidence: failure.evidence,
      };

    case "incomplete_procedure":
      return {
        action: "create",
        kind: "procedure",
        proposedText: extractMissingStep(failure.context),
        rationale: `Procedure was incomplete — agent hit an error: "${failure.evidence.slice(0, 100)}"`,
        risk: "high",
        evidence: failure.evidence,
      };

    case "not_surfaced":
      return {
        action: "update",
        kind: inferKindFromContext(failure.context),
        proposedText: `[Boost relevance for: ${failure.context.slice(0, 150)}]`,
        rationale: `Memory was not surfaced when needed: "${failure.evidence.slice(0, 100)}"`,
        risk: "low",
        evidence: failure.evidence,
      };

    default:
      return null;
  }
}

// ─── Recovery → correction mapping ──────────────────────────────────

export function correctionForRecovery(pair: RecoveryPair): LearnedCorrection {
  const failedArg = primaryArg(pair.failed);
  const recoveredArg = primaryArg(pair.recovered);

  switch (pair.pattern) {
    case "wrong_path":
      return {
        action: "create",
        kind: "mistake",
        proposedText: `File is at \`${recoveredArg}\`, not \`${failedArg}\`. Tool \`${pair.recovered.tool}\` succeeded after \`${pair.failed.tool}\` failed.`,
        rationale: `Agent read wrong path then found correct path: ${pair.failed.error?.slice(0, 100) ?? "file not found"}`,
        risk: "medium",
        evidence: `Failed: ${pair.failed.rawLine.slice(0, 200)} | Recovered: ${pair.recovered.rawLine.slice(0, 200)}`,
      };

    case "wrong_command":
      return {
        action: "create",
        kind: "procedure",
        proposedText: `Correct command: \`${recoveredArg}\`. Common mistake: \`${failedArg}\`.`,
        rationale: `Command failed then agent used correct command: ${pair.failed.error?.slice(0, 100) ?? "command failed"}`,
        risk: "high",
        evidence: `Failed: ${pair.failed.rawLine.slice(0, 200)} | Recovered: ${pair.recovered.rawLine.slice(0, 200)}`,
      };

    case "narrow_search":
      return {
        action: "create",
        kind: "code_context",
        proposedText: `When searching, use broader terms: \`${recoveredArg}\` instead of \`${failedArg}\`.`,
        rationale: "Search was too narrow (likely 0 results), then agent broadened the query.",
        risk: "low",
        evidence: `Failed: ${pair.failed.rawLine.slice(0, 200)} | Recovered: ${pair.recovered.rawLine.slice(0, 200)}`,
      };

    case "missing_dep":
      return {
        action: "create",
        kind: "procedure",
        proposedText: `Before running \`${failedArg}\`, install dependency: \`${recoveredArg}\`.`,
        rationale: `Command failed with missing dependency, then agent installed it: ${pair.failed.error?.slice(0, 100) ?? ""}`,
        risk: "high",
        evidence: `Failed: ${pair.failed.rawLine.slice(0, 200)} | Recovered: ${pair.recovered.rawLine.slice(0, 200)}`,
      };

    case "wrong_args":
      return {
        action: "create",
        kind: "code_context",
        proposedText: `Tool \`${pair.failed.tool}\` requires \`${recoveredArg}\`. Previously failed with \`${failedArg}\`.`,
        rationale: `Same tool called with wrong args then correct args: ${pair.failed.error?.slice(0, 100) ?? ""}`,
        risk: "medium",
        evidence: `Failed: ${pair.failed.rawLine.slice(0, 200)} | Recovered: ${pair.recovered.rawLine.slice(0, 200)}`,
      };

    case "fallback_tool":
      return {
        action: "create",
        kind: "code_context",
        proposedText: `Use \`${pair.recovered.tool}\` instead of \`${pair.failed.tool}\` for this type of task.`,
        rationale: `Tool ${pair.failed.tool} failed, agent switched to ${pair.recovered.tool} which succeeded.`,
        risk: "low",
        evidence: `Failed: ${pair.failed.rawLine.slice(0, 200)} | Recovered: ${pair.recovered.rawLine.slice(0, 200)}`,
      };
  }
}

// ─── NLP heuristics (lightweight, no model dependency) ──────────────

function inferKindFromContext(context: string): MemoryKind {
  const lower = context.toLowerCase();
  if (
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    /\b(security|vulnerability|exploit|cve|injection|xss|csrf|secret|token|password)\b/.test(lower)
  ) {
    return "security_rule";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(trade|buy|sell|order|transaction|portfolio|position|market)\b/.test(lower)) {
    return "trade_rule";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(procedure|step|process|workflow|pipeline|deploy|release|rollback)\b/.test(lower)) {
    return "procedure";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(mistake|error|bug|issue|problem|wrong|incorrect|fail|crash)\b/.test(lower)) {
    return "mistake";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(config|setting|environment|variable|env|\.env|toml|yaml|json)\b/.test(lower)) {
    return "code_context";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(decision|choose|decided|agreed|concluded|resolved)\b/.test(lower)) {
    return "decision";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(prefer|preference|like|style|convention|format|indent|tab|space)\b/.test(lower)) {
    return "preference";
  }
  return "fact";
}

function inferRisk(context: string): RiskLevel {
  const lower = context.toLowerCase();
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(security|vulnerability|exploit|secret|token|password|credential|cve)\b/.test(lower)) {
    return "critical";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(trade|buy|sell|order|transaction|portfolio|financial)\b/.test(lower)) {
    return "critical";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(procedure|deploy|release|rollback|pipeline|production|prod)\b/.test(lower)) {
    return "high";
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/\b(mistake|error|bug|wrong|incorrect)\b/.test(lower)) {
    return "medium";
  }
  return "low";
}

function extractKnowledgeGap(context: string): string {
  // Extract the most relevant sentence — the one with the question or missing info
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const sentences = context.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /\b(how|what|where|when|why|which|who|don't know|not sure|cannot|unable)\b/i.test(sentence)
    ) {
      return sentence.trim().slice(0, 300);
    }
  }
  return context.slice(0, 300);
}

function extractCorrectAnswer(context: string): string {
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const sentences = context.split(/(?<=[.!?])\s+/);
  for (let i = 0; i < sentences.length; i++) {
    if (
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /\b(actually|correction|instead|rather|should be|the correct)\b/i.test(sentences[i] ?? "")
    ) {
      // Return this sentence + the next 2
      return sentences
        .slice(i, i + 3)
        .join(" ")
        .trim()
        .slice(0, 500);
    }
  }
  return context.slice(0, 300);
}

function extractMissingStep(context: string): string {
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const sentences = context.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      /\b(also|additionally|don't forget|remember to|must|need to|should|have to)\b/i.test(sentence)
    ) {
      return sentence.trim().slice(0, 300);
    }
  }
  return context.slice(0, 300);
}

// ─── Main learn API ────────────────────────────────────────────────

export interface LearnOptions {
  /** Auto-approve corrections at or below this risk level */
  autoApproveUpTo?: RiskLevel;
  /** Minimum confidence for a failure to trigger a correction */
  minConfidence?: number;
  /** Max corrections to propose (prevents flood) */
  maxCorrections?: number;
}

/** Deduplicate corrections that overlap in proposed text */
function deduplicateCorrections(corrections: LearnedCorrection[]): LearnedCorrection[] {
  const seen = new Set<string>();
  return corrections.filter((c) => {
    const key = `${c.kind}:${c.proposedText.slice(0, 80)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function mineFailures(rawSession: string, opts: LearnOptions = {}): LearnResult {
  const minConfidence = opts.minConfidence ?? 0.5;
  const maxCorrections = opts.maxCorrections ?? 10;

  const lines = parseSessionLog(rawSession);
  if (lines.length === 0) {
    return {
      sessionsAnalyzed: 1,
      failuresDetected: 0,
      recoveryPairsDetected: 0,
      correctionsProposed: 0,
      autoApproved: 0,
      pendingApproval: 0,
      corrections: [],
    };
  }

  // --- Existing: text-based failure detection ---
  const failures = detectFailures(lines).filter((f) => f.confidence >= minConfidence);
  const textCorrections: LearnedCorrection[] = [];
  for (const failure of failures) {
    const correction = correctionForFailure(failure);
    if (correction) {
      textCorrections.push(correction);
    }
  }

  // --- NEW: tool-call recovery correlation ---
  const events = parseToolCallEvents(rawSession);
  const recoveryPairs = detectRecoveryPairs(events).filter((p) => p.confidence >= minConfidence);
  const recoveryCorrections = recoveryPairs.map(correctionForRecovery);

  // --- Merge, dedup, cap ---
  const corrections = deduplicateCorrections([...textCorrections, ...recoveryCorrections]).slice(
    0,
    maxCorrections,
  );

  const riskOrder: RiskLevel[] = ["low", "medium", "high", "critical"];
  const autoThreshold = opts.autoApproveUpTo ?? "low";
  const autoApproved = corrections.filter(
    (c) => riskOrder.indexOf(c.risk) <= riskOrder.indexOf(autoThreshold),
  ).length;

  return {
    sessionsAnalyzed: 1,
    failuresDetected: failures.length,
    recoveryPairsDetected: recoveryPairs.length,
    correctionsProposed: corrections.length,
    autoApproved,
    pendingApproval: corrections.length - autoApproved,
    corrections,
  };
}

/**
 * Apply learned corrections to the database.
 * Low-risk corrections are applied directly. Higher-risk ones create proposals.
 */
export function applyLearnings(
  db: Database,
  projectId: string,
  result: LearnResult,
  opts: { autoApproveUpTo?: RiskLevel; actor?: string } = {},
): { applied: number; proposed: number } {
  const riskOrder: RiskLevel[] = ["low", "medium", "high", "critical"];
  const autoThreshold = opts.autoApproveUpTo ?? "low";
  const actor = opts.actor ?? "memh:learn";
  let applied = 0;
  let proposed = 0;

  for (const correction of result.corrections) {
    const riskIdx = riskOrder.indexOf(correction.risk);

    if (riskIdx <= riskOrder.indexOf(autoThreshold)) {
      // Auto-apply low-risk corrections
      try {
        // biome-ignore lint/style/noCommonJs: circular dependency workaround
        const { remember } = require("./service");
        if (correction.action === "create") {
          remember(db, {
            kind: correction.kind,
            text: correction.proposedText,
            projectId,
            source: actor,
            confidence: 0.4, // lower confidence for auto-created memories
            evidence: [{ source: "memh:learn", reference: uuidv4(), note: correction.rationale }],
          });
          applied++;
        }
      } catch {
        // Skip on errors (duplicates, guardrail violations, etc.)
      }
    } else {
      // Propose for review
      try {
        // biome-ignore lint/style/noCommonJs: circular dependency workaround
        const { propose } = require("./service");
        propose(db, {
          kind: correction.kind,
          text: correction.proposedText,
          projectId,
          proposedBy: actor,
          rationale: correction.rationale,
          action: correction.action,
          targetMemoryId: correction.targetMemoryId,
        });
        proposed++;
      } catch {
        // Skip on errors
      }
    }
  }

  return { applied, proposed };
}
