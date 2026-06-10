import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import { dedupCheckAndMerge } from "../application/dedup-use-cases";
import { CONFIG } from "../config";
import { withStructuredContextMetadata } from "../context/structured-memory";
import type { MemoryItem, RememberInput, RiskLevel, Visibility } from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { assertDirectWriteAllowed, guardString } from "../infrastructure/guardrail";
import { withWriteTransaction } from "../persistence/db";
import {
  deleteMemoryItem,
  findMemoryByHash,
  getMemoryById,
  insertMemoryItem,
  listMemoryItems as listMemories,
} from "../persistence/repository";
import { stampAgentProvenance } from "../retrieval/cross-agent";
import { contentHash } from "../retrieval/dedup";
import { serializeEmbedding } from "../retrieval/embedding";
import { localEmbeddingProvider } from "../retrieval/embedding-provider";
import {
  audit,
  candidatesForProject,
  dedupCheckAndMergeBatch,
  embeddingForText,
  guardedPayload,
  json,
  now,
} from "./helpers";

// ─── Remember (CLI:user direct write) ─────────────────────────────

export function remember(db: Database, input: RememberInput): MemoryItem {
  return withWriteTransaction(db, () => rememberOne(db, input));
}

export function rememberMany(db: Database, inputs: RememberInput[]): MemoryItem[] {
  return withWriteTransaction(db, () => {
    const semanticCandidatesByProject = new Map<
      string,
      Array<{ item: MemoryItem; embedding: Float32Array }>
    >();
    const seenHashes = new Set<string>();
    const saved: MemoryItem[] = [];

    for (const input of inputs) {
      saved.push(
        rememberOne(db, input, {
          semanticCandidatesByProject,
          seenHashes,
        }),
      );
    }

    return saved;
  });
}

function rememberOne(
  db: Database,
  input: RememberInput,
  batchState?: {
    semanticCandidatesByProject: Map<string, Array<{ item: MemoryItem; embedding: Float32Array }>>;
    seenHashes: Set<string>;
  },
): MemoryItem {
  const text = guardString(input.text, "memory.text");
  const embedding = embeddingForText(text, input.embedding);
  const hash = contentHash(text);
  const kind = input.kind;
  const risk: RiskLevel = KIND_RISK_MAP[kind];
  const hashKey = `${input.projectId}:${hash}`;

  if (batchState?.seenHashes.has(hashKey)) {
    throw new Error(
      `Duplicate: batch contains the same exact text more than once in project ${input.projectId}.`,
    );
  }

  // Check for exact duplicate in same project
  const existing = findMemoryByHash(db, input.projectId, hash);
  if (existing) {
    throw new Error(
      `Duplicate: memory "${existing.id}" already has this exact text in project ${input.projectId}. Use trimemh status to review.`,
    );
  }

  // Check for semantic near-duplicate (SDD-06)
  if (embedding) {
    const dedupData = {
      text,
      kind,
      source: input.source ?? "cli:user",
      confidence: input.confidence ?? 0.5,
      evidenceJson: json(guardedPayload(input.evidence) ?? []),
    };
    const merged = batchState
      ? dedupCheckAndMergeBatch(db, input.projectId, embedding, batchState, dedupData)
      : dedupCheckAndMerge(db, input.projectId, embedding, dedupData);
    if (merged) {
      return merged;
    }
  }

  assertDirectWriteAllowed({
    kind,
    actor: input.source ?? "cli:user",
    surface: "service",
    allowExplicitUser: true,
  });

  const item: MemoryItem = {
    id: uuidv4(),
    project_id: input.projectId,
    kind: kind,
    text,
    status: "active",
    visibility: (input.visibility ?? "private") as Visibility,
    confidence: input.confidence ?? 0.5,
    source: input.source ?? "cli:user",
    content_hash: hash,
    evidence_json: json(guardedPayload(input.evidence) ?? []),
    metadata_json: json(
      withStructuredContextMetadata({
        metadata: {
          ...stampAgentProvenance(guardedPayload(input.metadata) ?? {}),
          embedding_provider: input.embedding ? "explicit" : localEmbeddingProvider.name,
        },
        text,
        kind,
      }),
    ),
    embedding: serializeEmbedding(embedding),
    created_at: now(),
    updated_at: now(),
    expires_at: input.expiresAt ?? null,
  };

  const saved = insertMemoryItem(db, item);
  batchState?.seenHashes.add(hashKey);
  if (batchState && embedding) {
    const candidates = candidatesForProject(
      db,
      batchState.semanticCandidatesByProject,
      input.projectId,
    );
    candidates.push({ item: saved, embedding });
  }
  audit(db, input.projectId, "user", "memory_created", "memory_item", item.id, {
    kind: item.kind,
    risk_level: risk,
    has_embedding: true,
    embedding_provider: input.embedding ? "explicit" : localEmbeddingProvider.name,
  });

  return saved;
}

// ─── List memories ────────────────────────────────────────────────

export function listAll(
  db: Database,
  projectId: string,
  kind?: string,
  status?: string,
): MemoryItem[] {
  return listMemories(db, projectId, { kind, status, limit: CONFIG.service.defaultListLimit });
}

// ─── Forget (delete) ──────────────────────────────────────────────

export function forget(db: Database, projectId: string, id: string): boolean {
  const existing = getMemoryById(db, id);
  if (!existing) {
    throw new Error(`Memory "${id}" not found.`);
  }
  if (existing.project_id !== projectId) {
    throw new Error(`Memory "${id}" belongs to a different project.`);
  }

  const deleted = deleteMemoryItem(db, id);
  if (deleted) {
    audit(db, projectId, "user", "memory_deleted", "memory_item", id, {
      kind: existing.kind,
    });
  }
  return deleted;
}
