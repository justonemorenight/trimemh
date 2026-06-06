import type { Database } from "bun:sqlite";
import { v4 as uuidv4 } from "uuid";

import type {
  CodeEntity,
  CodeEntityInput,
  CodeEntityType,
  CodeLinkRelation,
  CodeMemoryResult,
  CreateMemoryCodeLinkInput,
  CreateMemoryEdgeInput,
  MemoryCodeLink,
  MemoryEdge,
  MemoryEdgeRelation,
  MemoryItem,
  MemoryLinkProposal,
  ProposeMemoryCodeLinkInput,
  ProposeMemoryEdgeInput,
  RelatedMemoryResult,
} from "../domain/schema";
import { CODE_LINK_RELATIONS, MEMORY_EDGE_RELATIONS } from "../domain/schema";
import { guardString } from "../infrastructure/guardrail";
import { handleSecurityViolation } from "../infrastructure/guardrail";
import { detectAdversarialOverride } from "../context/compiler";
import {
  findCodeEntityByKey,
  findMemoryCodeLink,
  findMemoryEdge,
  getMemoryById,
  getMemoryLinkProposalById,
  getRelatedMemoryRows,
  insertCodeEntity,
  insertMemoryCodeLink,
  insertMemoryEdge,
  insertMemoryLinkProposal,
  updateMemoryLinkProposal,
} from "../persistence/repository";
import {
  assertMemoryInProject,
  audit,
  codeEntityKey,
  guardedPayload,
  json,
  normalizeDepth,
  now,
  requireRationaleForRelation,
} from "./helpers";

// ─── Memory Graph Edges ───────────────────────────────────────────

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

// ─── Code Entities + Memory Code Links ────────────────────────────

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

// ─── Approve / Reject Link Proposals ──────────────────────────────

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
