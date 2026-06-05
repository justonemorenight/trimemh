import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import type { DedupReport } from "./application/dedup-use-cases";
import { dedupCheckAndMerge, dedupMerge, dedupScan } from "./application/dedup-use-cases";
import { getMemoriesForCode, hybridRecall, recall } from "./application/recall-use-cases";
import { audit, embeddingForText, guardedPayload, json, now } from "./application/service-helpers";
import { detectAdversarialOverride } from "./context/compiler";
import type {
  AuditEvent,
  CodeEntity,
  CodeEntityInput,
  CodeEntityType,
  CodeLinkRelation,
  CodeMemoryResult,
  CreateMemoryCodeLinkInput,
  CreateMemoryEdgeInput,
  McpLinkProposalResult,
  McpProposalResult,
  McpSearchResult,
  MemoryCodeLink,
  MemoryEdge,
  MemoryEdgeRelation,
  MemoryItem,
  MemoryKind,
  MemoryLinkProposal,
  MemoryProposal,
  MemoryStats,
  ProposalStatus,
  ProposeInput,
  ProposeMemoryCodeLinkInput,
  ProposeMemoryEdgeInput,
  RelatedMemoryResult,
  RememberInput,
  RiskLevel,
  Visibility,
} from "./domain/schema";
import { CODE_LINK_RELATIONS, KIND_RISK_MAP, MEMORY_EDGE_RELATIONS } from "./domain/schema";
import {
  assertDirectWriteAllowed,
  guardString,
  handleSecurityViolation,
} from "./infrastructure/guardrail";
import {
  deleteMemoryItem,
  findCodeEntityByKey,
  findMemoryByHash,
  findMemoryCodeLink,
  findMemoryEdge,
  getAuditEvents,
  getMemoryById,
  getMemoryLinkProposalById,
  getMemoryStats,
  getProposalById,
  getRelatedMemoryRows,
  insertCodeEntity,
  insertMemoryCodeLink,
  insertMemoryEdge,
  insertMemoryItem,
  insertMemoryLinkProposal,
  insertProposal,
  listMemoryItems as listMemories,
  listPendingProposals,
  listProposals,
  searchMemoryFts,
  updateMemoryItem,
  updateMemoryLinkProposal,
  updateProposal,
} from "./persistence/repository";
import { stampAgentProvenance } from "./retrieval/cross-agent";
import { contentHash } from "./retrieval/dedup";
import { serializeEmbedding } from "./retrieval/embedding";
import { localEmbeddingProvider } from "./retrieval/embedding-provider";

export type { DedupReport };
export { dedupMerge, dedupScan, getMemoriesForCode, hybridRecall, recall };

// ─── Helpers ──────────────────────────────────────────────────────

function requireRationaleForRelation(relation: string, rationale?: string | null): void {
  if (["contradicts", "supersedes", "depends_on"].includes(relation) && !rationale?.trim()) {
    throw new Error(`Relation "${relation}" requires a non-empty rationale.`);
  }
}

function assertMemoryInProject(item: MemoryItem | null, projectId: string, id: string): MemoryItem {
  if (!item) {
    throw new Error(`Memory "${id}" not found.`);
  }
  if (item.project_id !== projectId) {
    throw new Error(`Memory "${id}" belongs to a different project.`);
  }
  return item;
}

function normalizeDepth(depth = 1): number {
  return Math.max(1, Math.min(depth, 2));
}

export function codeEntityKey(input: {
  path: string;
  entityType: CodeEntityType;
  symbol?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}): string {
  return [
    input.path,
    input.entityType,
    input.symbol ?? "",
    input.lineStart ?? "",
    input.lineEnd ?? "",
  ].join("#");
}

// ─── Remember (CLI:user direct write) ─────────────────────────────

export function remember(db: Database, input: RememberInput): MemoryItem {
  const text = guardString(input.text, "memory.text");
  const embedding = embeddingForText(text, input.embedding);
  const hash = contentHash(text);
  const kind = input.kind;
  const risk: RiskLevel = KIND_RISK_MAP[kind];

  // Check for exact duplicate in same project
  const existing = findMemoryByHash(db, input.projectId, hash);
  if (existing) {
    throw new Error(
      `Duplicate: memory "${existing.id}" already has this exact text in project ${input.projectId}. Use trimemh status to review.`,
    );
  }

  // Check for semantic near-duplicate (SDD-06)
  // Only runs when embedding is available; silently skipped otherwise.
  if (embedding) {
    const merged = dedupCheckAndMerge(db, input.projectId, embedding, {
      text,
      kind,
      source: input.source ?? "cli:user",
      confidence: input.confidence ?? 0.5,
      evidenceJson: json(guardedPayload(input.evidence) ?? []),
    });
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
    metadata_json: json({
      ...stampAgentProvenance(guardedPayload(input.metadata) ?? {}),
      embedding_provider: input.embedding ? "explicit" : localEmbeddingProvider.name,
    }),
    embedding: serializeEmbedding(embedding),
    created_at: now(),
    updated_at: now(),
    expires_at: input.expiresAt ?? null,
  };

  const saved = insertMemoryItem(db, item);
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
  // biome-ignore lint/nursery/noShadow: warning suppression
  status?: string,
): MemoryItem[] {
  return listMemories(db, projectId, { kind, status, limit: 100 });
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

// ─── Propose (from agent/MCP/reflect) ─────────────────────────────

export function propose(db: Database, input: ProposeInput): MemoryProposal {
  let risk: RiskLevel = KIND_RISK_MAP[input.kind];
  let overrideAttempt = false;
  let targetKind: string | undefined;

  if (input.targetMemoryId) {
    const target = getMemoryById(db, input.targetMemoryId);
    if (target) {
      targetKind = target.kind;
      const targetRisk = KIND_RISK_MAP[target.kind];
      if (targetRisk === "high" || targetRisk === "critical") {
        risk = "critical";
        overrideAttempt = true;
      }
    }
  }

  const text = guardString(input.text, "proposal.text");
  const rationale = input.rationale
    ? guardString(input.rationale, "proposal.rationale")
    : undefined;

  const proposal: MemoryProposal = {
    id: uuidv4(),
    project_id: input.projectId,
    action: input.action ?? "create",
    target_memory_id: input.targetMemoryId ?? null,
    proposed_kind: input.kind,
    proposed_text: text,
    proposed_by: input.proposedBy,
    risk_level: risk,
    status: "pending",
    rationale: rationale ?? null,
    evidence_json: json(guardedPayload(input.evidence) ?? []),
    created_at: now(),
    decided_at: null,
    decided_by: null,
    decision_note: null,
  };

  const saved = insertProposal(db, proposal);

  if (overrideAttempt) {
    handleSecurityViolation({
      db,
      projectId: input.projectId,
      actor: input.proposedBy,
      violationCode: "adversarial_override_attempt",
      detail: `Proposed ${input.action ?? "create"} action targets ${KIND_RISK_MAP[targetKind as MemoryKind]} memory ${input.targetMemoryId}.`,
      surface: "service",
      entityId: proposal.id,
    });
    audit(
      db,
      input.projectId,
      input.proposedBy,
      "override_attempt_detected",
      "memory_proposal",
      proposal.id,
      {
        action: input.action ?? "create",
        target_memory_id: input.targetMemoryId,
        target_kind: targetKind,
      },
    );
  } else {
    audit(
      db,
      input.projectId,
      input.proposedBy,
      "proposal_created",
      "memory_proposal",
      proposal.id,
      {
        kind: input.kind,
        risk_level: risk,
        ...(input.argumentsHash ? { arguments_hash: input.argumentsHash } : {}),
      },
    );
  }

  return saved;
}

// ─── Approve ──────────────────────────────────────────────────────

export function approve(
  db: Database,
  projectId: string,
  proposalId: string,
  decidedBy = "user",
): MemoryItem | null {
  const proposal = getProposalById(db, proposalId);
  if (!proposal) {
    throw new Error(`Proposal "${proposalId}" not found.`);
  }
  if (proposal.project_id !== projectId) {
    throw new Error("Proposal belongs to a different project.");
  }
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}.`);
  }

  // Mark proposal as approved
  proposal.status = "approved";
  proposal.decided_at = now();
  proposal.decided_by = decidedBy;
  updateProposal(db, proposal);
  audit(db, projectId, decidedBy, "proposal_approved", "memory_proposal", proposalId, {
    kind: proposal.proposed_kind,
    risk_level: proposal.risk_level,
  });

  // Create or update the memory item
  if (proposal.action === "create") {
    const hash = contentHash(proposal.proposed_text);

    // Check for duplicate again
    const existing = findMemoryByHash(db, projectId, hash);
    if (existing) {
      throw new Error(`Cannot approve: memory "${existing.id}" already has this exact text.`);
    }

    const item: MemoryItem = {
      id: uuidv4(),
      project_id: projectId,
      kind: proposal.proposed_kind,
      text: proposal.proposed_text,
      status: "active",
      visibility: "private",
      confidence: 0.5,
      source: `mcp:${proposal.proposed_by}`,
      content_hash: hash,
      evidence_json: proposal.evidence_json,
      metadata_json: json({
        approved_from_proposal: proposalId,
        embedding_provider: localEmbeddingProvider.name,
      }),
      embedding: serializeEmbedding(embeddingForText(proposal.proposed_text)),
      created_at: now(),
      updated_at: now(),
      expires_at: null,
    };

    const saved = insertMemoryItem(db, item);
    audit(db, projectId, decidedBy, "memory_created", "memory_item", item.id, {
      from_proposal: proposalId,
    });
    return saved;
  }

  if (proposal.action === "update" && proposal.target_memory_id) {
    const existing = getMemoryById(db, proposal.target_memory_id);
    if (!existing) {
      throw new Error(`Target memory "${proposal.target_memory_id}" not found.`);
    }

    existing.text = proposal.proposed_text;
    existing.kind = proposal.proposed_kind;
    existing.updated_at = now();
    existing.content_hash = contentHash(proposal.proposed_text);
    existing.embedding = serializeEmbedding(embeddingForText(proposal.proposed_text));
    existing.metadata_json = json({
      ...JSON.parse(existing.metadata_json || "{}"),
      updated_from_proposal: proposalId,
      embedding_provider: localEmbeddingProvider.name,
    });

    // FTS5 sync handled by trigger
    const updated = updateMemoryItem(db, existing);
    audit(db, projectId, decidedBy, "memory_updated", "memory_item", updated.id, {
      from_proposal: proposalId,
    });
    return updated;
  }

  if (proposal.action === "delete" && proposal.target_memory_id) {
    const deleted = deleteMemoryItem(db, proposal.target_memory_id);
    if (deleted) {
      audit(db, projectId, decidedBy, "memory_deleted", "memory_item", proposal.target_memory_id, {
        from_proposal: proposalId,
      });
    }
    return null;
  }

  return null;
}

// ─── Reject ───────────────────────────────────────────────────────

export function reject(
  db: Database,
  projectId: string,
  proposalId: string,
  note: string,
  decidedBy = "user",
): MemoryProposal {
  const proposal = getProposalById(db, proposalId);
  if (!proposal) {
    throw new Error(`Proposal "${proposalId}" not found.`);
  }
  if (proposal.project_id !== projectId) {
    throw new Error("Proposal belongs to a different project.");
  }
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}.`);
  }

  proposal.status = "rejected";
  proposal.decided_at = now();
  proposal.decided_by = decidedBy;
  proposal.decision_note = note;
  updateProposal(db, proposal);

  audit(db, projectId, decidedBy, "proposal_rejected", "memory_proposal", proposalId, {
    note,
    kind: proposal.proposed_kind,
  });

  return proposal;
}

// ─── Status / stats ───────────────────────────────────────────────

export function status(
  db: Database,
  projectId: string,
): { stats: MemoryStats; pendingProposals: MemoryProposal[]; recentAudit: AuditEvent[] } {
  return {
    stats: getMemoryStats(db, projectId),
    pendingProposals: listPendingProposals(db, projectId),
    recentAudit: getAuditEvents(db, projectId, 20),
  };
}

export function proposals(
  db: Database,
  projectId: string,
  // biome-ignore lint/nursery/noShadow: warning suppression
  status?: ProposalStatus,
): MemoryProposal[] {
  return listProposals(db, projectId, { status, limit: 100 });
}

// ─── Memory Graph + Code Links ───────────────────────────────────

export function createMemoryEdge(db: Database, input: CreateMemoryEdgeInput): MemoryEdge {
  if (!MEMORY_EDGE_RELATIONS.includes(input.relation)) {
    throw new Error(`Invalid memory edge relation "${input.relation}".`);
  }
  requireRationaleForRelation(input.relation, input.rationale);

  if (input.sourceMemoryId === input.targetMemoryId) {
    throw new Error("Cannot create a memory edge from a memory to itself.");
  }

  assertMemoryInProject(
    getMemoryById(db, input.sourceMemoryId),
    input.projectId,
    input.sourceMemoryId,
  );
  assertMemoryInProject(
    getMemoryById(db, input.targetMemoryId),
    input.projectId,
    input.targetMemoryId,
  );

  const existing = findMemoryEdge(
    db,
    input.projectId,
    input.sourceMemoryId,
    input.targetMemoryId,
    input.relation,
  );
  if (existing) {
    throw new Error(
      `Duplicate: memory edge "${existing.id}" already links ${input.sourceMemoryId} -> ${input.targetMemoryId} as ${input.relation}.`,
    );
  }

  const edge: MemoryEdge = {
    id: uuidv4(),
    project_id: input.projectId,
    source_memory_id: input.sourceMemoryId,
    target_memory_id: input.targetMemoryId,
    relation: input.relation,
    confidence: input.confidence ?? 0.5,
    source: input.source ?? "cli:user",
    rationale: input.rationale ? guardString(input.rationale, "memory_edge.rationale") : null,
    evidence_json: json(guardedPayload(input.evidence) ?? []),
    metadata_json: json(guardedPayload(input.metadata) ?? {}),
    created_at: now(),
    updated_at: now(),
  };

  const saved = insertMemoryEdge(db, edge);
  audit(db, input.projectId, edge.source, "memory_edge_created", "memory_edge", edge.id, {
    source_memory_id: edge.source_memory_id,
    target_memory_id: edge.target_memory_id,
    relation: edge.relation,
  });
  return saved;
}

export function proposeMemoryEdge(db: Database, input: ProposeMemoryEdgeInput): MemoryLinkProposal {
  if (!MEMORY_EDGE_RELATIONS.includes(input.relation)) {
    throw new Error(`Invalid memory edge relation "${input.relation}".`);
  }
  requireRationaleForRelation(input.relation, input.rationale);
  if (input.sourceMemoryId === input.targetMemoryId) {
    throw new Error("Cannot propose a memory edge from a memory to itself.");
  }
  assertMemoryInProject(
    getMemoryById(db, input.sourceMemoryId),
    input.projectId,
    input.sourceMemoryId,
  );
  const target = assertMemoryInProject(
    getMemoryById(db, input.targetMemoryId),
    input.projectId,
    input.targetMemoryId,
  );
  const override = detectAdversarialOverride({
    relation: input.relation,
    target,
  });
  const rationale = input.rationale
    ? guardString(input.rationale, "memory_link_proposal.rationale")
    : undefined;

  const proposal: MemoryLinkProposal = {
    id: uuidv4(),
    project_id: input.projectId,
    proposal_type: "memory_edge",
    source_memory_id: input.sourceMemoryId,
    target_memory_id: input.targetMemoryId,
    entity_type: null,
    path: null,
    symbol: null,
    line_start: null,
    line_end: null,
    fingerprint: null,
    relation: input.relation,
    confidence: input.confidence ?? 0.5,
    proposed_by: input.proposedBy,
    status: "pending",
    rationale: rationale ?? null,
    evidence_json: json(guardedPayload(input.evidence) ?? []),
    created_at: now(),
    decided_at: null,
    decided_by: null,
    decision_note: null,
  };

  const saved = insertMemoryLinkProposal(db, proposal);
  if (override.override) {
    handleSecurityViolation({
      db,
      projectId: input.projectId,
      actor: input.proposedBy,
      violationCode: "adversarial_override_attempt",
      detail: `Proposed ${input.relation} link targets ${override.targetRisk} memory ${target.id}.`,
      surface: "service",
      entityId: proposal.id,
    });
    audit(
      db,
      input.projectId,
      input.proposedBy,
      "override_attempt_detected",
      "memory_link_proposal",
      proposal.id,
      {
        proposal_type: "memory_edge",
        relation: input.relation,
        target_memory_id: target.id,
        target_kind: target.kind,
        target_risk: override.targetRisk,
        forced_risk_level: override.forcedRisk,
        status: "pending",
      },
    );
  }
  audit(
    db,
    input.projectId,
    input.proposedBy,
    "link_proposal_created",
    "memory_link_proposal",
    proposal.id,
    {
      proposal_type: "memory_edge",
      relation: input.relation,
      ...(input.argumentsHash ? { arguments_hash: input.argumentsHash } : {}),
    },
  );
  return saved;
}

export function getRelatedMemories(
  db: Database,
  projectId: string,
  memoryId: string,
  depth = 1,
): RelatedMemoryResult[] {
  assertMemoryInProject(getMemoryById(db, memoryId), projectId, memoryId);
  return getRelatedMemoryRows(db, projectId, memoryId, normalizeDepth(depth));
}

export function createOrGetCodeEntity(db: Database, input: CodeEntityInput): CodeEntity {
  const path = guardString(input.path, "code_entity.path");
  const symbol = input.symbol ? guardString(input.symbol, "code_entity.symbol") : undefined;
  const fingerprint = input.fingerprint
    ? guardString(input.fingerprint, "code_entity.fingerprint")
    : undefined;
  const entityKey = codeEntityKey({
    path,
    entityType: input.entityType,
    symbol: symbol ?? null,
    lineStart: input.lineStart ?? null,
    lineEnd: input.lineEnd ?? null,
  });
  const existing = findCodeEntityByKey(db, input.projectId, entityKey);
  if (existing) {
    return existing;
  }

  const entity: CodeEntity = {
    id: uuidv4(),
    project_id: input.projectId,
    entity_key: entityKey,
    entity_type: input.entityType,
    path,
    symbol: symbol ?? null,
    line_start: input.lineStart ?? null,
    line_end: input.lineEnd ?? null,
    fingerprint: fingerprint ?? null,
    metadata_json: json(guardedPayload(input.metadata) ?? {}),
    created_at: now(),
    updated_at: now(),
  };
  return insertCodeEntity(db, entity);
}

export function createMemoryCodeLink(
  db: Database,
  input: CreateMemoryCodeLinkInput,
): MemoryCodeLink {
  if (!CODE_LINK_RELATIONS.includes(input.relation)) {
    throw new Error(`Invalid code link relation "${input.relation}".`);
  }
  requireRationaleForRelation(input.relation, input.rationale);
  assertMemoryInProject(getMemoryById(db, input.memoryId), input.projectId, input.memoryId);

  const entity = createOrGetCodeEntity(db, input);
  const existing = findMemoryCodeLink(
    db,
    input.projectId,
    input.memoryId,
    entity.id,
    input.relation,
  );
  if (existing) {
    throw new Error(
      `Duplicate: memory code link "${existing.id}" already links ${input.memoryId} to ${entity.entity_key} as ${input.relation}.`,
    );
  }

  const link: MemoryCodeLink = {
    id: uuidv4(),
    project_id: input.projectId,
    memory_id: input.memoryId,
    entity_id: entity.id,
    relation: input.relation,
    confidence: input.confidence ?? 0.5,
    source: input.source ?? "cli:user",
    rationale: input.rationale ? guardString(input.rationale, "memory_code_link.rationale") : null,
    evidence_json: json(guardedPayload(input.evidence) ?? []),
    metadata_json: json(guardedPayload(input.metadata) ?? {}),
    created_at: now(),
    updated_at: now(),
  };

  const saved = insertMemoryCodeLink(db, link);
  audit(db, input.projectId, link.source, "memory_code_link_created", "memory_code_link", link.id, {
    memory_id: link.memory_id,
    entity_id: link.entity_id,
    relation: link.relation,
  });
  return saved;
}

export function proposeMemoryCodeLink(
  db: Database,
  input: ProposeMemoryCodeLinkInput,
): MemoryLinkProposal {
  if (!CODE_LINK_RELATIONS.includes(input.relation)) {
    throw new Error(`Invalid code link relation "${input.relation}".`);
  }
  requireRationaleForRelation(input.relation, input.rationale);
  assertMemoryInProject(getMemoryById(db, input.memoryId), input.projectId, input.memoryId);
  const path = guardString(input.path, "memory_code_link.path");
  const symbol = input.symbol ? guardString(input.symbol, "memory_code_link.symbol") : undefined;
  const fingerprint = input.fingerprint
    ? guardString(input.fingerprint, "memory_code_link.fingerprint")
    : undefined;
  const rationale = input.rationale
    ? guardString(input.rationale, "memory_code_link.rationale")
    : undefined;

  const proposal: MemoryLinkProposal = {
    id: uuidv4(),
    project_id: input.projectId,
    proposal_type: "memory_code_link",
    source_memory_id: input.memoryId,
    target_memory_id: null,
    entity_type: input.entityType,
    path,
    symbol: symbol ?? null,
    line_start: input.lineStart ?? null,
    line_end: input.lineEnd ?? null,
    fingerprint: fingerprint ?? null,
    relation: input.relation,
    confidence: input.confidence ?? 0.5,
    proposed_by: input.proposedBy,
    status: "pending",
    rationale: rationale ?? null,
    evidence_json: json(guardedPayload(input.evidence) ?? []),
    created_at: now(),
    decided_at: null,
    decided_by: null,
    decision_note: null,
  };

  const saved = insertMemoryLinkProposal(db, proposal);
  audit(
    db,
    input.projectId,
    input.proposedBy,
    "link_proposal_created",
    "memory_link_proposal",
    proposal.id,
    {
      proposal_type: "memory_code_link",
      relation: input.relation,
      ...(input.argumentsHash ? { arguments_hash: input.argumentsHash } : {}),
    },
  );
  return saved;
}

export function approveMemoryLinkProposal(
  db: Database,
  projectId: string,
  proposalId: string,
  decidedBy = "user",
): MemoryEdge | MemoryCodeLink {
  const proposal = getMemoryLinkProposalById(db, proposalId);
  if (!proposal) {
    throw new Error(`Link proposal "${proposalId}" not found.`);
  }
  if (proposal.project_id !== projectId) {
    throw new Error("Link proposal belongs to a different project.");
  }
  if (proposal.status !== "pending") {
    throw new Error(`Link proposal is already ${proposal.status}.`);
  }

  let created: MemoryEdge | MemoryCodeLink;
  if (proposal.proposal_type === "memory_edge") {
    if (!(proposal.source_memory_id && proposal.target_memory_id)) {
      throw new Error("Memory edge proposal is missing memory IDs.");
    }
    created = createMemoryEdge(db, {
      projectId,
      sourceMemoryId: proposal.source_memory_id,
      targetMemoryId: proposal.target_memory_id,
      relation: proposal.relation as MemoryEdgeRelation,
      confidence: proposal.confidence,
      source: `proposal:${proposal.proposed_by}`,
      rationale: proposal.rationale ?? undefined,
      evidence: JSON.parse(proposal.evidence_json),
      metadata: { approved_from_link_proposal: proposalId },
    });
  } else {
    if (!(proposal.source_memory_id && proposal.entity_type && proposal.path)) {
      throw new Error("Memory code link proposal is missing code entity fields.");
    }
    created = createMemoryCodeLink(db, {
      projectId,
      memoryId: proposal.source_memory_id,
      entityType: proposal.entity_type,
      path: proposal.path,
      symbol: proposal.symbol ?? undefined,
      lineStart: proposal.line_start ?? undefined,
      lineEnd: proposal.line_end ?? undefined,
      fingerprint: proposal.fingerprint ?? undefined,
      relation: proposal.relation as CodeLinkRelation,
      confidence: proposal.confidence,
      source: `proposal:${proposal.proposed_by}`,
      rationale: proposal.rationale ?? undefined,
      evidence: JSON.parse(proposal.evidence_json),
      metadata: { approved_from_link_proposal: proposalId },
    });
  }

  proposal.status = "approved";
  proposal.decided_at = now();
  proposal.decided_by = decidedBy;
  updateMemoryLinkProposal(db, proposal);
  audit(db, projectId, decidedBy, "link_proposal_approved", "memory_link_proposal", proposalId, {
    proposal_type: proposal.proposal_type,
    created_id: created.id,
  });

  return created;
}

export function rejectMemoryLinkProposal(
  db: Database,
  projectId: string,
  proposalId: string,
  note: string,
  decidedBy = "user",
): MemoryLinkProposal {
  const proposal = getMemoryLinkProposalById(db, proposalId);
  if (!proposal) {
    throw new Error(`Link proposal "${proposalId}" not found.`);
  }
  if (proposal.project_id !== projectId) {
    throw new Error("Link proposal belongs to a different project.");
  }
  if (proposal.status !== "pending") {
    throw new Error(`Link proposal is already ${proposal.status}.`);
  }

  proposal.status = "rejected";
  proposal.decided_at = now();
  proposal.decided_by = decidedBy;
  proposal.decision_note = note;
  updateMemoryLinkProposal(db, proposal);
  audit(db, projectId, decidedBy, "link_proposal_rejected", "memory_link_proposal", proposalId, {
    note,
    proposal_type: proposal.proposal_type,
  });
  return proposal;
}

// ─── MCP-facing service calls ──────────────────────────────────────

export function mcpSearch(
  db: Database,
  projectId: string,
  query: string,
  limit = 10,
): McpSearchResult[] {
  const results = searchMemoryFts(db, projectId, query, limit);
  return results.map((r) => ({
    id: r.item.id,
    kind: r.item.kind as MemoryKind,
    text: r.item.text,
    snippet: r.snippet,
    confidence: r.item.confidence,
    source: r.item.source,
    created_at: r.item.created_at,
    related: getRelatedMemoryRows(db, projectId, r.item.id, 1)
      .slice(0, 3)
      .map((related) => ({
        id: related.item.id,
        kind: related.item.kind as MemoryKind,
        text: related.item.text,
        relation: related.edge.relation,
        direction: related.direction,
      })),
  }));
}

export function mcpHybridSearch(
  db: Database,
  projectId: string,
  query: string,
  embedding: Float32Array | null,
  limit = 10,
): McpSearchResult[] {
  const results = hybridRecall(db, projectId, query || null, embedding, limit);
  return results.map((r) => ({
    id: r.item.id,
    kind: r.item.kind as MemoryKind,
    text: r.item.text,
    snippet: r.item.text.slice(0, 200),
    confidence: r.item.confidence,
    source: r.item.source,
    created_at: r.item.created_at,
    related: getRelatedMemoryRows(db, projectId, r.item.id, 1)
      .slice(0, 3)
      .map((rel) => ({
        id: rel.item.id,
        kind: rel.item.kind as MemoryKind,
        text: rel.item.text,
        relation: rel.edge.relation,
        direction: rel.direction,
      })),
  }));
}

export function mcpPropose(db: Database, input: ProposeInput): McpProposalResult {
  const proposal = propose(db, input);
  return {
    proposal_id: proposal.id,
    status: proposal.status as ProposalStatus,
    risk_level: proposal.risk_level as RiskLevel,
    message: `Proposal ${proposal.id} created. Risk level: ${proposal.risk_level}. Awaiting user approval.`,
  };
}

export function mcpGet(db: Database, projectId: string, id: string): MemoryItem | null {
  const item = getMemoryById(db, id);
  if (!item || item.project_id !== projectId) {
    return null;
  }
  return item;
}

export function mcpStats(db: Database, projectId: string): MemoryStats {
  return getMemoryStats(db, projectId);
}

export function mcpRelated(
  db: Database,
  projectId: string,
  memoryId: string,
  depth = 1,
): RelatedMemoryResult[] {
  return getRelatedMemories(db, projectId, memoryId, depth);
}

export function mcpMemoryLinkPropose(
  db: Database,
  input: ProposeMemoryEdgeInput,
): McpLinkProposalResult {
  const proposal = proposeMemoryEdge(db, input);
  return {
    proposal_id: proposal.id,
    status: proposal.status,
    proposal_type: proposal.proposal_type,
    message: `Memory link proposal ${proposal.id} created. Awaiting user approval via trimemh link approve ${proposal.id}.`,
  };
}

export function mcpMemoryCodeLinkPropose(
  db: Database,
  input: ProposeMemoryCodeLinkInput,
): McpLinkProposalResult {
  const proposal = proposeMemoryCodeLink(db, input);
  return {
    proposal_id: proposal.id,
    status: proposal.status,
    proposal_type: proposal.proposal_type,
    message: `Memory code link proposal ${proposal.id} created. Awaiting user approval via trimemh link approve ${proposal.id}.`,
  };
}

/**
 * Retrieve a full memory by ID for CCR deferred detail retrieval.
 * This is called by the `memory_retrieve` MCP tool when the LLM
 * needs to fetch the original text of a compressed detail.
 *
 * Unlike `mcpGet`, this function is optimized for CCR retrieval:
 * it returns the full text with metadata about what was saved.
 */
export function mcpRetrieveFull(
  db: Database,
  projectId: string,
  id: string,
): { item: MemoryItem; retrieval_context: string } | null {
  const item = getMemoryById(db, id);
  if (!item || item.project_id !== projectId) {
    return null;
  }

  const related = getRelatedMemoryRows(db, projectId, id, 1).slice(0, 5);
  const relatedText =
    related.length > 0
      ? "\n\nRelated memories:\n" +
        related
          .map(
            (r) =>
              `  [${r.item.id.slice(0, 8)}] ${r.direction} ${r.edge.relation}: ${r.item.text.slice(0, 120)}`,
          )
          .join("\n")
      : "";

  return {
    item,
    retrieval_context: [
      `Memory ID: ${item.id}`,
      `Kind: ${item.kind}`,
      `Confidence: ${item.confidence}`,
      `Source: ${item.source}`,
      `Created: ${item.created_at}`,
      `Updated: ${item.updated_at}`,
      `--- FULL TEXT (${item.text.length} chars, ~${Math.ceil(item.text.length / 4)} tokens) ---`,
      item.text,
      `--- END FULL TEXT ---`,
      relatedText,
    ].join("\n"),
  };
}

export function mcpCodeSearch(
  db: Database,
  projectId: string,
  path: string,
  symbol?: string,
): CodeMemoryResult[] {
  return getMemoriesForCode(db, projectId, path, symbol);
}
