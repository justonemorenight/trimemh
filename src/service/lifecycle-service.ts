import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { v4 as uuidv4 } from "uuid";

import { recall } from "../application/recall-use-cases";
import { parseFile } from "../code-intel/code-parser";
import type {
  CodeEntity,
  MemoryItem,
  MemoryKind,
  StaleMemoryAction,
  StaleMemoryReason,
  StaleMemoryReasonDetail,
  StaleMemoryReport,
  StaleMemoryResult,
  StaleMemorySeverity,
} from "../domain/schema";
import type {
  LifecycleEntityType,
  LifecycleState,
  MemoryLifecycleEvent,
} from "../persistence/repository";
import {
  getCodeEntitiesForMemoryRows,
  getMemoryById,
  insertLifecycleEvent,
  latestLifecycleState,
  listCodeEntitiesForPath,
  listLifecycleEvents,
  listMemoryItems,
  updateMemoryItem,
} from "../persistence/repository";
import { createMemoryEdge } from "./graph-service";
import { assertMemoryInProject, audit, json, now } from "./helpers";

export const MEMORY_LIFECYCLE_STATES = [
  "observed",
  "proposed",
  "needs_review",
  "approved",
  "rejected",
  "merged",
  "superseded",
  "expired",
] as const satisfies readonly LifecycleState[];

export interface RecordLifecycleInput {
  projectId: string;
  entityType: LifecycleEntityType;
  entityId: string;
  state: LifecycleState;
  actor: string;
  payloadHash?: string | null;
  payload?: Record<string, unknown>;
}

export interface ExpireMemoriesInput {
  projectId: string;
  before?: string;
  sourcePrefix?: string;
  dryRun?: boolean;
  actor?: string;
}

export interface ExpireMemoriesResult {
  status: "dry_run" | "expired";
  before: string;
  expired: Array<{ id: string; kind: string; source: string; expires_at: string | null }>;
}

export interface SupersedeMemoryInput {
  projectId: string;
  oldMemoryId: string;
  newMemoryId: string;
  actor?: string;
  dryRun?: boolean;
}

export interface SupersedeMemoryResult {
  status: "dry_run" | "superseded";
  oldMemory: MemoryItem;
  newMemory: MemoryItem;
}

export interface ConflictCandidate {
  memory: MemoryItem;
  score: number;
  reasons: string[];
}

export interface DetectStaleMemoriesInput {
  projectId: string;
  path?: string;
  symbol?: string;
  includeConflicts?: boolean;
  includeLowConfidence?: boolean;
  limit?: number;
}

const SEVERITY_RANK: Record<StaleMemorySeverity, number> = { low: 1, medium: 2, high: 3 };

const NEGATION_RE = /\b(no|not|never|without|instead|avoid|disable|remove|replace|deprecated)\b/i;
const TOKEN_SPLIT_RE = /\s+/;

export function recordLifecycleEvent(
  db: Database,
  input: RecordLifecycleInput,
): MemoryLifecycleEvent {
  return insertLifecycleEvent(db, {
    id: uuidv4(),
    project_id: input.projectId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    state: input.state,
    actor: input.actor,
    payload_hash: input.payloadHash ?? null,
    payload_json: json(input.payload ?? {}),
    created_at: now(),
  });
}

export function proposalLifecycle(
  db: Database,
  projectId: string,
  proposalId: string,
): MemoryLifecycleEvent[] {
  return listLifecycleEvents(db, projectId, {
    entityType: "memory_proposal",
    entityId: proposalId,
  });
}

export function lifecycleEvents(
  db: Database,
  projectId: string,
  opts?: {
    entityType?: LifecycleEntityType;
    entityId?: string;
    state?: LifecycleState;
    limit?: number;
  },
): MemoryLifecycleEvent[] {
  return listLifecycleEvents(db, projectId, opts);
}

export function latestLifecycle(
  db: Database,
  projectId: string,
  entityType: LifecycleEntityType,
  entityId: string,
): MemoryLifecycleEvent | null {
  return latestLifecycleState(db, projectId, entityType, entityId);
}

export function expireMemories(db: Database, input: ExpireMemoriesInput): ExpireMemoriesResult {
  const before = input.before ?? now();
  const candidates = listMemoryItems(db, input.projectId, {
    status: "active",
    limit: 1000,
  }).filter((item) => {
    if (!item.expires_at || item.expires_at > before) {
      return false;
    }
    return input.sourcePrefix ? item.source.startsWith(input.sourcePrefix) : true;
  });

  if (!input.dryRun) {
    for (const item of candidates) {
      updateMemoryItem(db, {
        ...item,
        status: "expired",
        updated_at: now(),
      });
      recordLifecycleEvent(db, {
        projectId: input.projectId,
        entityType: "memory_item",
        entityId: item.id,
        state: "expired",
        actor: input.actor ?? "cli:lifecycle",
        payload: {
          before,
          expires_at: item.expires_at,
          source: item.source,
        },
      });
      audit(
        db,
        input.projectId,
        input.actor ?? "cli:lifecycle",
        "memory_expired",
        "memory_item",
        item.id,
        {
          before,
          expires_at: item.expires_at,
        },
      );
    }
  }

  return {
    status: input.dryRun ? "dry_run" : "expired",
    before,
    expired: candidates.map((item) => ({
      id: item.id,
      kind: item.kind,
      source: item.source,
      expires_at: item.expires_at,
    })),
  };
}

export function supersedeMemory(db: Database, input: SupersedeMemoryInput): SupersedeMemoryResult {
  const oldMemory = assertMemoryInProject(
    getMemoryById(db, input.oldMemoryId),
    input.projectId,
    input.oldMemoryId,
  );
  const newMemory = assertMemoryInProject(
    getMemoryById(db, input.newMemoryId),
    input.projectId,
    input.newMemoryId,
  );

  if (input.dryRun) {
    return { status: "dry_run", oldMemory, newMemory };
  }

  const metadata = JSON.parse(oldMemory.metadata_json || "{}") as Record<string, unknown>;
  const updatedOld = updateMemoryItem(db, {
    ...oldMemory,
    status: "archived",
    metadata_json: json({
      ...metadata,
      superseded_by: newMemory.id,
      superseded_at: now(),
    }),
    updated_at: now(),
  });

  try {
    createMemoryEdge(db, {
      projectId: input.projectId,
      sourceMemoryId: newMemory.id,
      targetMemoryId: oldMemory.id,
      relation: "supersedes",
      confidence: 0.9,
      source: input.actor ?? "cli:lifecycle",
      rationale: `Memory ${newMemory.id} supersedes ${oldMemory.id}.`,
      evidence: [{ source: "lifecycle", reference: oldMemory.id }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Duplicate: memory edge")) {
      throw err;
    }
  }

  recordLifecycleEvent(db, {
    projectId: input.projectId,
    entityType: "memory_item",
    entityId: oldMemory.id,
    state: "superseded",
    actor: input.actor ?? "cli:lifecycle",
    payload: { superseded_by: newMemory.id },
  });
  audit(
    db,
    input.projectId,
    input.actor ?? "cli:lifecycle",
    "memory_superseded",
    "memory_item",
    oldMemory.id,
    { superseded_by: newMemory.id },
  );

  return { status: "superseded", oldMemory: updatedOld, newMemory };
}

function resolveCodePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function strongerSeverity(
  current: StaleMemorySeverity,
  next: StaleMemorySeverity,
): StaleMemorySeverity {
  return SEVERITY_RANK[next] > SEVERITY_RANK[current] ? next : current;
}

function actionForReasons(reasons: StaleMemoryReason[]): StaleMemoryAction {
  if (reasons.includes("memory_conflict")) {
    return "supersede";
  }
  if (reasons.includes("missing_file") || reasons.includes("missing_symbol")) {
    return "update_link";
  }
  if (reasons.includes("fingerprint_mismatch") || reasons.includes("low_confidence")) {
    return "review";
  }
  return "none";
}

function addStaleReason(
  findings: Map<string, StaleMemoryResult>,
  memory: MemoryItem,
  severity: StaleMemorySeverity,
  reason: StaleMemoryReasonDetail,
): void {
  const existing = findings.get(memory.id);
  if (!existing) {
    findings.set(memory.id, {
      memory,
      severity,
      suggested_action: actionForReasons([reason.reason]),
      reasons: [reason],
    });
    return;
  }
  existing.severity = strongerSeverity(existing.severity, severity);
  existing.reasons.push(reason);
  existing.suggested_action = actionForReasons(existing.reasons.map((entry) => entry.reason));
}

function currentEntityFor(entity: CodeEntity): CodeEntity | null {
  const absolutePath = resolveCodePath(entity.path);
  if (!existsSync(absolutePath)) {
    return null;
  }
  const parsed = parseFile(entity.path, readFileSync(absolutePath, "utf8"));
  const current = parsed.entities.find(
    (entry) =>
      entry.entityType === entity.entity_type && entry.symbol === (entity.symbol ?? entry.symbol),
  );
  if (!current) {
    return null;
  }
  return {
    ...entity,
    symbol: current.symbol,
    line_start: current.lineStart,
    line_end: current.lineEnd,
    fingerprint: current.fingerprint,
  };
}

export function detectStaleMemories(
  db: Database,
  input: DetectStaleMemoriesInput,
): StaleMemoryReport {
  const limit = input.limit ?? 20;
  const includeConflicts = input.includeConflicts ?? true;
  const includeLowConfidence = input.includeLowConfidence ?? false;
  const activeMemories = listMemoryItems(db, input.projectId, { status: "active", limit: 1000 });
  const activeById = new Map(activeMemories.map((item) => [item.id, item]));
  const findings = new Map<string, StaleMemoryResult>();

  const linkedRows = input.path
    ? getCodeEntitiesForMemoryRows(
        db,
        input.projectId,
        getMemoriesForLinkedEntities(db, input.projectId, input.path, input.symbol),
      )
    : getCodeEntitiesForMemoryRows(
        db,
        input.projectId,
        activeMemories.map((item) => item.id),
      );

  for (const row of linkedRows) {
    const memory = activeById.get(row.memoryId);
    if (!memory) {
      continue;
    }
    const entity = row.entity;
    const link = row.link;
    const absolutePath = resolveCodePath(entity.path);
    if (!existsSync(absolutePath)) {
      addStaleReason(findings, memory, "high", {
        reason: "missing_file",
        description: `Linked file no longer exists: ${entity.path}`,
        entity,
        link,
      });
      continue;
    }

    const current = currentEntityFor(entity);
    if (!current) {
      addStaleReason(findings, memory, "high", {
        reason: "missing_symbol",
        description: `Linked code entity no longer exists: ${entity.path}${entity.symbol ? `#${entity.symbol}` : ""}`,
        entity,
        link,
      });
      continue;
    }

    if (entity.fingerprint && current.fingerprint && entity.fingerprint !== current.fingerprint) {
      addStaleReason(findings, memory, "medium", {
        reason: "fingerprint_mismatch",
        description: `Linked code entity changed: ${entity.path}${entity.symbol ? `#${entity.symbol}` : ""}`,
        entity,
        link,
        details: {
          previous_fingerprint: entity.fingerprint,
          current_fingerprint: current.fingerprint,
        },
      });
    }
  }

  if (includeConflicts) {
    for (const memory of activeMemories) {
      const conflicts = detectMemoryConflicts(db, {
        projectId: input.projectId,
        kind: memory.kind,
        text: memory.text,
        limit: 5,
      }).filter((candidate) => candidate.memory.id !== memory.id);
      if (conflicts.length > 0) {
        addStaleReason(findings, memory, "medium", {
          reason: "memory_conflict",
          description: `Memory may conflict with ${conflicts.length} active memory item(s).`,
          details: {
            conflicts: conflicts.map((candidate) => ({
              memory_id: candidate.memory.id,
              score: candidate.score,
              reasons: candidate.reasons,
            })),
          },
        });
      }
    }
  }

  if (includeLowConfidence) {
    for (const memory of activeMemories) {
      if (memory.confidence < 0.25) {
        addStaleReason(findings, memory, "low", {
          reason: "low_confidence",
          description: `Memory confidence is low (${memory.confidence}).`,
          details: { confidence: memory.confidence },
        });
      }
    }
  }

  const results = [...findings.values()]
    .sort((a, b) => {
      const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      return (
        severityDiff ||
        b.reasons.length - a.reasons.length ||
        a.memory.created_at.localeCompare(b.memory.created_at)
      );
    })
    .slice(0, limit);

  return {
    checked_at: now(),
    results,
    summary: {
      checked_memory_count: activeMemories.length,
      flagged_memory_count: results.length,
      high_count: results.filter((result) => result.severity === "high").length,
      medium_count: results.filter((result) => result.severity === "medium").length,
      low_count: results.filter((result) => result.severity === "low").length,
    },
  };
}

function getMemoriesForLinkedEntities(
  db: Database,
  projectId: string,
  path: string,
  symbol?: string,
): string[] {
  const entities = listCodeEntitiesForPath(db, projectId, path, symbol);
  const rows = getCodeEntitiesForMemoryRows(
    db,
    projectId,
    listMemoryItems(db, projectId, { status: "active", limit: 1000 }).map((item) => item.id),
  );
  const entityIds = new Set(entities.map((entity) => entity.id));
  return [
    ...new Set(rows.filter((row) => entityIds.has(row.entity.id)).map((row) => row.memoryId)),
  ];
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s/-]/g, " ")
      .split(TOKEN_SPLIT_RE)
      .filter((token) => token.length > 2),
  );
}

function lexicalOverlapScore(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) {
      overlap++;
    }
  }
  return overlap / Math.min(left.size, right.size);
}

export function detectMemoryConflicts(
  db: Database,
  input: {
    projectId: string;
    kind: MemoryKind;
    text: string;
    limit?: number;
  },
): ConflictCandidate[] {
  const limit = input.limit ?? 5;
  const recalled = recall(
    db,
    input.projectId,
    input.text,
    Math.max(limit * 3, 15),
    "hybrid",
    null,
    null,
    {
      rerank: false,
    },
  );

  const incomingHasNegation = NEGATION_RE.test(input.text);
  return recalled
    .map((result): ConflictCandidate | null => {
      const memory = result.item;
      if (memory.status !== "active" || memory.kind !== input.kind) {
        return null;
      }

      const reasons: string[] = [];
      const overlap = lexicalOverlapScore(input.text, memory.text);
      if (overlap >= 0.35) {
        reasons.push(`lexical_overlap=${overlap.toFixed(2)}`);
      }
      if (incomingHasNegation !== NEGATION_RE.test(memory.text)) {
        reasons.push("negation_mismatch");
      }
      if (memory.text !== input.text && result.score > 0) {
        reasons.push(`retrieval_score=${result.score.toFixed(3)}`);
      }
      if (reasons.length === 0) {
        return null;
      }
      return {
        memory,
        score: Math.max(result.score, overlap),
        reasons,
      };
    })
    .filter((entry): entry is ConflictCandidate => entry !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
