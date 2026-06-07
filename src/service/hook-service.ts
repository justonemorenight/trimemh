import type { Database } from "bun:sqlite";

import type { MemoryKind, MemoryProposal } from "../domain/schema";
import { guardString } from "../infrastructure/guardrail";
import { hashArguments } from "../infrastructure/sanitize";
import { listProposals } from "../persistence/repository";
import { audit } from "./helpers";
import { recordLifecycleEvent } from "./lifecycle-service";
import { mcpPropose } from "./mcp-service";
import { type NormalizedMemoryEvent, adapterForAgent } from "./memory-event-adapter";
import { buildSessionSummaryText, registerSessionObservation } from "./session-service";

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
  normalizedEvent: NormalizedMemoryEvent;
  lifecycleState: ProposalLifecycleState;
  redacted: boolean;
  truncated: boolean;
  requireReview: boolean;
  status: "dry_run" | "deduped" | "pending" | "approved";
  proposalId?: string;
  message: string;
}

export const PROPOSAL_LIFECYCLE_STATES = [
  "observed",
  "proposed",
  "needs_review",
  "approved",
  "rejected",
  "merged",
  "superseded",
  "expired",
] as const;

export type ProposalLifecycleState = (typeof PROPOSAL_LIFECYCLE_STATES)[number];

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

function lifecycleStateFor(input: {
  requireReview: boolean;
  riskSignals: string[];
}): ProposalLifecycleState {
  if (input.requireReview || input.riskSignals.length > 0) {
    return "needs_review";
  }
  return "proposed";
}

function hookMemoryText(input: {
  event: HookCaptureEvent;
  agent: string;
  payloadHash: string;
  lifecycleState: ProposalLifecycleState;
  normalizedEvent: NormalizedMemoryEvent;
  payload: string;
}): string {
  if (input.event === "stop" || input.event === "pre_compact") {
    return buildSessionSummaryText({
      projectId: "",
      agentId: input.agent,
      sessionId: input.normalizedEvent.session_id,
      parentSessionId: input.normalizedEvent.parent_session_id,
      summary: input.normalizedEvent.summary,
      files: input.normalizedEvent.files,
      handoffNotes: `payload_hash=${input.payloadHash}; lifecycle_state=${input.lifecycleState}; risk_signals=${input.normalizedEvent.risk_signals.join(",") || "none"}`,
      sourceEvent: input.event,
    });
  }

  return [
    `Hook observation from ${input.agent}: ${input.event}.`,
    `payload_hash=${input.payloadHash}`,
    `lifecycle_state=${input.lifecycleState}`,
    `session_id=${input.normalizedEvent.session_id ?? "unknown"}`,
    `tool=${input.normalizedEvent.tool ?? "none"}`,
    `files=${input.normalizedEvent.files.join(",") || "none"}`,
    `risk_signals=${input.normalizedEvent.risk_signals.join(",") || "none"}`,
    `summary=${input.normalizedEvent.summary}`,
    `payload=${input.payload}`,
  ].join("\n");
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
  const adapter = adapterForAgent(input.agent);
  const normalizedEvent = adapter.normalize({
    event: input.event,
    agent: input.agent,
    payload: input.payload,
    payloadHash,
    sanitizedPayload: truncated.text,
  });
  const kind = hookKind(input.event);
  const requireReview =
    requiresReview(input.event, redacted.redacted, truncated.truncated) ||
    normalizedEvent.risk_signals.length > 0;
  const lifecycleState = lifecycleStateFor({
    requireReview,
    riskSignals: normalizedEvent.risk_signals,
  });
  const text = guardString(
    hookMemoryText({
      event: input.event,
      agent: input.agent,
      payloadHash,
      lifecycleState,
      normalizedEvent,
      payload: truncated.text,
    }),
    "hook.payload",
  );

  return {
    event: input.event,
    agent: input.agent,
    kind,
    text,
    payloadHash,
    normalizedEvent,
    lifecycleState,
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

  audit(
    db,
    input.projectId,
    `agent:${input.agent}`,
    "memory_event_observed",
    "memory_event",
    normalized.payloadHash,
    {
      lifecycle_state: normalized.lifecycleState,
      event: input.event,
      session_id: normalized.normalizedEvent.session_id,
      tool: normalized.normalizedEvent.tool,
      risk_signals: normalized.normalizedEvent.risk_signals,
    },
  );
  recordLifecycleEvent(db, {
    projectId: input.projectId,
    entityType: "memory_event",
    entityId: normalized.payloadHash,
    state: "observed",
    actor: `agent:${input.agent}`,
    payloadHash: normalized.payloadHash,
    payload: {
      event: input.event,
      session_id: normalized.normalizedEvent.session_id,
      tool: normalized.normalizedEvent.tool,
      risk_signals: normalized.normalizedEvent.risk_signals,
    },
  });

  if (input.event === "stop" || input.event === "pre_compact") {
    registerSessionObservation(db, {
      projectId: input.projectId,
      agentId: input.agent,
      sessionId: normalized.normalizedEvent.session_id,
      parentSessionId: normalized.normalizedEvent.parent_session_id,
      summary: normalized.normalizedEvent.summary,
      files: normalized.normalizedEvent.files,
      handoffNotes: `source_event=${input.event}; payload_hash=${normalized.payloadHash}`,
      sourceEvent: input.event,
      payloadHash: normalized.payloadHash,
      metadata: {
        cwd: normalized.normalizedEvent.cwd,
        risk_signals: normalized.normalizedEvent.risk_signals,
      },
    });
  }

  const existing = existingHookProposal(db, input.projectId, normalized.payloadHash);
  if (existing) {
    audit(
      db,
      input.projectId,
      `agent:${input.agent}`,
      "memory_event_deduped",
      "memory_proposal",
      existing.id,
      {
        payload_hash: normalized.payloadHash,
        event: input.event,
      },
    );
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
        note: [
          `redacted=${normalized.redacted}`,
          `truncated=${normalized.truncated}`,
          `lifecycle_state=${normalized.lifecycleState}`,
          `session_id=${normalized.normalizedEvent.session_id ?? ""}`,
          `tool=${normalized.normalizedEvent.tool ?? ""}`,
          `files=${normalized.normalizedEvent.files.join(",")}`,
          `risk_signals=${normalized.normalizedEvent.risk_signals.join(",")}`,
        ].join("; "),
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
