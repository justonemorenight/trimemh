import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import { recall } from "../application/recall-use-cases";
import type { MemoryItem } from "../domain/schema";
import type { MemorySessionRecord } from "../persistence/repository";
import {
  listMemoryItems,
  listMemorySessions,
  upsertMemorySession,
} from "../persistence/repository";
import { recordLifecycleEvent } from "./lifecycle-service";
import { mcpPropose } from "./mcp-service";

export interface SessionSummaryInput {
  projectId: string;
  agentId: string;
  sessionId?: string | null;
  parentSessionId?: string | null;
  summary: string;
  files?: string[];
  handoffNotes?: string;
  sourceEvent?: string;
  dryRun?: boolean;
}

export interface SessionSummaryResult {
  status: "dry_run" | "pending" | "approved";
  proposalId?: string;
  text: string;
  message: string;
}

export interface SessionHistoryQuery {
  projectId: string;
  agentId?: string;
  sessionId?: string;
  parentSessionId?: string;
  limit?: number;
}

export interface RegisterSessionInput extends SessionSummaryInput {
  payloadHash?: string;
  metadata?: Record<string, unknown>;
}

export function buildSessionSummaryText(input: SessionSummaryInput): string {
  return [
    `Session summary for ${input.agentId}${input.sessionId ? `/${input.sessionId}` : ""}.`,
    `project_id=${input.projectId}`,
    input.parentSessionId ? `parent_session_id=${input.parentSessionId}` : null,
    input.sourceEvent ? `source_event=${input.sourceEvent}` : null,
    input.files?.length ? `files=${input.files.join(",")}` : null,
    `summary=${input.summary}`,
    input.handoffNotes ? `handoff=${input.handoffNotes}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeSession(db: Database, input: SessionSummaryInput): SessionSummaryResult {
  const text = buildSessionSummaryText(input);
  if (input.dryRun) {
    return {
      status: "dry_run",
      text,
      message: "Dry run: session summary normalized without creating a proposal.",
    };
  }

  registerSessionObservation(db, input);

  const proposed = mcpPropose(db, {
    kind: "session_summary",
    text,
    projectId: input.projectId,
    proposedBy: `agent:${input.agentId}:session`,
    rationale: "First-class session handoff summary.",
    evidence: [
      {
        source: `session:${input.agentId}`,
        reference: input.sessionId ?? "unknown",
        note: JSON.stringify({
          parent_session_id: input.parentSessionId ?? null,
          files: input.files ?? [],
          source_event: input.sourceEvent ?? null,
        }),
      },
    ],
    requireReview: true,
    confidence: 0.6,
  });

  return {
    status: proposed.status,
    proposalId: proposed.proposal_id,
    text,
    message: proposed.message,
  };
}

export function registerSessionObservation(
  db: Database,
  input: RegisterSessionInput,
): MemorySessionRecord {
  const stableSessionId = input.sessionId || `${input.agentId}:unknown`;
  const timestamp = new Date().toISOString();
  const session = upsertMemorySession(db, {
    id: uuidv4(),
    project_id: input.projectId,
    session_id: stableSessionId,
    agent_id: input.agentId,
    parent_session_id: input.parentSessionId ?? null,
    summary: input.summary,
    handoff_notes: input.handoffNotes ?? null,
    metadata_json: JSON.stringify({
      files: input.files ?? [],
      source_event: input.sourceEvent ?? null,
      payload_hash: input.payloadHash ?? null,
      ...(input.metadata ?? {}),
    }),
    created_at: timestamp,
    updated_at: timestamp,
  });

  recordLifecycleEvent(db, {
    projectId: input.projectId,
    entityType: "session",
    entityId: `${session.agent_id}:${session.session_id}`,
    state: "observed",
    actor: `agent:${input.agentId}:session`,
    payloadHash: input.payloadHash,
    payload: {
      parent_session_id: session.parent_session_id,
      source_event: input.sourceEvent ?? null,
      files: input.files ?? [],
    },
  });

  return session;
}

export function sessionHistory(db: Database, query: SessionHistoryQuery): MemoryItem[] {
  const limit = query.limit ?? 10;
  const recallLimit = Math.max(limit * 5, 25);
  const terms = [
    "Session summary",
    query.agentId,
    query.sessionId,
    query.agentId ? `agent:${query.agentId}:session` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const recalled = recall(db, query.projectId, terms, recallLimit, "hybrid", null, null, {
    rerank: false,
  })
    .map((result) => result.item)
    .filter((item) => item.kind === "session_summary");

  if (!(query.agentId || query.sessionId)) {
    return recalled.slice(0, limit);
  }

  return recalled
    .filter((item) => {
      const sourceMatch = query.agentId ? item.source.includes(query.agentId) : true;
      const textMatch = query.sessionId ? item.text.includes(query.sessionId) : true;
      return sourceMatch && textMatch;
    })
    .slice(0, limit);
}

export function listSessionSummaries(db: Database, projectId: string, limit = 20): MemoryItem[] {
  return listMemoryItems(db, projectId, {
    kind: "session_summary",
    status: "active",
    limit,
  });
}

export function listSessionRegistry(
  db: Database,
  query: SessionHistoryQuery,
): MemorySessionRecord[] {
  return listMemorySessions(db, query.projectId, {
    agentId: query.agentId,
    sessionId: query.sessionId,
    parentSessionId: query.parentSessionId,
    limit: query.limit ?? 20,
  });
}
