import type { Database } from "bun:sqlite";

import type { MemoryKind, MemoryProposal } from "../domain/schema";
import { guardString } from "../infrastructure/guardrail";
import { hashArguments } from "../infrastructure/sanitize";
import { listProposals } from "../persistence/repository";
import { mcpPropose } from "./mcp-service";

export const HOOK_CAPTURE_EVENTS = [
  "session_start",
  "user_prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "pre_compact",
  "stop",
] as const;

export type HookCaptureEvent = (typeof HOOK_CAPTURE_EVENTS)[number];

export interface HookCaptureInput {
  event: HookCaptureEvent;
  agent: string;
  projectId: string;
  payload: unknown;
  dryRun?: boolean;
}

export interface HookCaptureResult {
  event: HookCaptureEvent;
  agent: string;
  kind: MemoryKind;
  text: string;
  payloadHash: string;
  redacted: boolean;
  truncated: boolean;
  requireReview: boolean;
  status: "dry_run" | "deduped" | "pending" | "approved";
  proposalId?: string;
  message: string;
}

const MAX_HOOK_WORDS = 180;
const SECRET_RE =
  /\b(api[_-]?key|token|secret|password|authorization|bearer|private[_-]?key)\b\s*[:=]\s*["']?[^"',\s}]+/gi;
const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;
const KEY_VALUE_SPLIT_RE = /[:=]/;
const WORD_SPLIT_RE = /\s+/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function redactHookText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const next = text
    .replace(PRIVATE_TAG_RE, () => {
      redacted = true;
      return "[REDACTED_PRIVATE]";
    })
    .replace(SECRET_RE, (match) => {
      redacted = true;
      const [key = "secret"] = match.split(KEY_VALUE_SPLIT_RE);
      return `${key.trim()}=[REDACTED]`;
    });
  return { text: next, redacted };
}

function truncateWords(text: string, maxWords: number): { text: string; truncated: boolean } {
  const words = text.trim().split(WORD_SPLIT_RE).filter(Boolean);
  if (words.length <= maxWords) {
    return { text, truncated: false };
  }
  return {
    text: `${words.slice(0, maxWords).join(" ")} ... [TRUNCATED_HOOK_PAYLOAD]`,
    truncated: true,
  };
}

function hookKind(event: HookCaptureEvent): MemoryKind {
  switch (event) {
    case "session_start":
      return "fact";
    case "stop":
    case "pre_compact":
      return "session_summary";
    case "pre_tool_use":
    case "post_tool_use":
      return "code_context";
    case "user_prompt_submit":
      return "fact";
  }
}

function requiresReview(event: HookCaptureEvent, redacted: boolean, truncated: boolean): boolean {
  return (
    redacted ||
    truncated ||
    event === "user_prompt_submit" ||
    event === "pre_tool_use" ||
    event === "post_tool_use"
  );
}

function existingHookProposal(
  db: Database,
  projectId: string,
  payloadHash: string,
): MemoryProposal | null {
  const proposals = listProposals(db, projectId, "pending");
  for (const proposal of proposals) {
    try {
      const evidence = JSON.parse(proposal.evidence_json);
      if (
        Array.isArray(evidence) &&
        evidence.some((entry) => isRecord(entry) && entry.reference === payloadHash)
      ) {
        return proposal;
      }
    } catch {}
  }
  return null;
}

export function normalizeHookPayload(input: {
  event: HookCaptureEvent;
  agent: string;
  payload: unknown;
}): Omit<HookCaptureResult, "projectId" | "status" | "proposalId" | "message"> {
  const serialized = stableJson(input.payload);
  const payloadHash = hashArguments({
    event: input.event,
    agent: input.agent,
    payload: serialized,
  });
  const redacted = redactHookText(serialized);
  const truncated = truncateWords(redacted.text, MAX_HOOK_WORDS);
  const kind = hookKind(input.event);
  const requireReview = requiresReview(input.event, redacted.redacted, truncated.truncated);
  const text = guardString(
    [
      `Hook observation from ${input.agent}: ${input.event}.`,
      `payload_hash=${payloadHash}`,
      `payload=${truncated.text}`,
    ].join("\n"),
    "hook.payload",
  );

  return {
    event: input.event,
    agent: input.agent,
    kind,
    text,
    payloadHash,
    redacted: redacted.redacted,
    truncated: truncated.truncated,
    requireReview,
  };
}

export function captureHookEvent(db: Database, input: HookCaptureInput): HookCaptureResult {
  const normalized = normalizeHookPayload(input);

  if (input.dryRun) {
    return {
      ...normalized,
      status: "dry_run",
      message: `Dry run: ${input.event} normalized as ${normalized.kind}; payload_hash=${normalized.payloadHash}`,
    };
  }

  const existing = existingHookProposal(db, input.projectId, normalized.payloadHash);
  if (existing) {
    return {
      ...normalized,
      status: "deduped",
      proposalId: existing.id,
      message: `Duplicate hook payload ignored; pending proposal ${existing.id} already exists.`,
    };
  }

  const proposed = mcpPropose(db, {
    kind: normalized.kind,
    text: normalized.text,
    projectId: input.projectId,
    proposedBy: `agent:${input.agent}:hook:${input.event}`,
    rationale: `Captured from ${input.agent} ${input.event} lifecycle hook.`,
    evidence: [
      {
        source: `hook:${input.agent}:${input.event}`,
        reference: normalized.payloadHash,
        note: `redacted=${normalized.redacted}; truncated=${normalized.truncated}`,
      },
    ],
    argumentsHash: normalized.payloadHash,
    requireReview: normalized.requireReview,
    confidence: normalized.requireReview ? 0.4 : 0.8,
  });

  return {
    ...normalized,
    status: proposed.status,
    proposalId: proposed.proposal_id,
    message: proposed.message,
  };
}

export function parseHookEvent(value: string): HookCaptureEvent {
  if (HOOK_CAPTURE_EVENTS.includes(value as HookCaptureEvent)) {
    return value as HookCaptureEvent;
  }
  throw new Error(`Unknown hook event "${value}". Supported: ${HOOK_CAPTURE_EVENTS.join(", ")}`);
}
