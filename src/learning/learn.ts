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
  /** Corrections proposed */
  correctionsProposed: number;
  /** Corrections auto-approved (low risk) */
  autoApproved: number;
  /** Corrections pending approval (medium+ risk) */
  pendingApproval: number;
  /** Detailed correction list */
  corrections: LearnedCorrection[];
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

export function mineFailures(rawSession: string, opts: LearnOptions = {}): LearnResult {
  const minConfidence = opts.minConfidence ?? 0.5;
  const maxCorrections = opts.maxCorrections ?? 10;

  const lines = parseSessionLog(rawSession);
  if (lines.length === 0) {
    return {
      sessionsAnalyzed: 1,
      failuresDetected: 0,
      correctionsProposed: 0,
      autoApproved: 0,
      pendingApproval: 0,
      corrections: [],
    };
  }

  const failures = detectFailures(lines).filter((f) => f.confidence >= minConfidence);

  const corrections: LearnedCorrection[] = [];
  for (const failure of failures) {
    if (corrections.length >= maxCorrections) {
      break;
    }
    const correction = correctionForFailure(failure);
    if (correction) {
      corrections.push(correction);
    }
  }

  const riskOrder: RiskLevel[] = ["low", "medium", "high", "critical"];
  const autoThreshold = opts.autoApproveUpTo ?? "low";
  const autoApproved = corrections.filter(
    (c) => riskOrder.indexOf(c.risk) <= riskOrder.indexOf(autoThreshold),
  ).length;

  return {
    sessionsAnalyzed: 1,
    failuresDetected: failures.length,
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
