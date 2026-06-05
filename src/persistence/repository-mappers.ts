import type {
  AuditEvent,
  CodeEntity,
  MemoryCodeLink,
  MemoryEdge,
  MemoryItem,
  MemoryLinkProposal,
  MemoryProposal,
} from "../domain/schema";

export const MEMORY_COLUMNS_WITHOUT_EMBEDDING = `
  id, project_id, kind, text, status, visibility, confidence,
  source, content_hash, evidence_json, metadata_json,
  NULL AS embedding, created_at, updated_at, expires_at
`;

export const MEMORY_COLUMNS_WITH_EMBEDDING = `
  id, project_id, kind, text, status, visibility, confidence,
  source, content_hash, evidence_json, metadata_json,
  embedding, created_at, updated_at, expires_at
`;

export function rowToMemoryItem(r: Record<string, unknown>): MemoryItem {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    kind: r.kind as MemoryItem["kind"],
    text: r.text as string,
    status: r.status as MemoryItem["status"],
    visibility: r.visibility as MemoryItem["visibility"],
    confidence: r.confidence as number,
    source: r.source as string,
    content_hash: r.content_hash as string,
    evidence_json: r.evidence_json as string,
    metadata_json: r.metadata_json as string,
    embedding: r.embedding as Uint8Array | null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    expires_at: r.expires_at as string | null,
  };
}

export function rowToProposal(r: Record<string, unknown>): MemoryProposal {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    action: r.action as MemoryProposal["action"],
    target_memory_id: r.target_memory_id as string | null,
    proposed_kind: r.proposed_kind as MemoryProposal["proposed_kind"],
    proposed_text: r.proposed_text as string,
    proposed_by: r.proposed_by as string,
    risk_level: r.risk_level as MemoryProposal["risk_level"],
    status: r.status as MemoryProposal["status"],
    rationale: r.rationale as string | null,
    evidence_json: r.evidence_json as string,
    created_at: r.created_at as string,
    decided_at: r.decided_at as string | null,
    decided_by: r.decided_by as string | null,
    decision_note: r.decision_note as string | null,
  };
}

export function rowToAuditEvent(r: Record<string, unknown>): AuditEvent {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    actor: r.actor as string,
    event_type: r.event_type as string,
    entity_type: r.entity_type as string,
    entity_id: r.entity_id as string,
    payload_json: r.payload_json as string,
    created_at: r.created_at as string,
  };
}

export function rowToMemoryEdge(r: Record<string, unknown>): MemoryEdge {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    source_memory_id: r.source_memory_id as string,
    target_memory_id: r.target_memory_id as string,
    relation: r.relation as MemoryEdge["relation"],
    confidence: r.confidence as number,
    source: r.source as string,
    rationale: r.rationale as string | null,
    evidence_json: r.evidence_json as string,
    metadata_json: r.metadata_json as string,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export function rowToCodeEntity(r: Record<string, unknown>): CodeEntity {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    entity_key: r.entity_key as string,
    entity_type: r.entity_type as CodeEntity["entity_type"],
    path: r.path as string,
    symbol: r.symbol as string | null,
    line_start: r.line_start as number | null,
    line_end: r.line_end as number | null,
    fingerprint: r.fingerprint as string | null,
    metadata_json: r.metadata_json as string,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export function rowToMemoryCodeLink(r: Record<string, unknown>): MemoryCodeLink {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    memory_id: r.memory_id as string,
    entity_id: r.entity_id as string,
    relation: r.relation as MemoryCodeLink["relation"],
    confidence: r.confidence as number,
    source: r.source as string,
    rationale: r.rationale as string | null,
    evidence_json: r.evidence_json as string,
    metadata_json: r.metadata_json as string,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export function rowToMemoryLinkProposal(r: Record<string, unknown>): MemoryLinkProposal {
  return {
    id: r.id as string,
    project_id: r.project_id as string,
    proposal_type: r.proposal_type as MemoryLinkProposal["proposal_type"],
    source_memory_id: r.source_memory_id as string | null,
    target_memory_id: r.target_memory_id as string | null,
    entity_type: r.entity_type as MemoryLinkProposal["entity_type"],
    path: r.path as string | null,
    symbol: r.symbol as string | null,
    line_start: r.line_start as number | null,
    line_end: r.line_end as number | null,
    fingerprint: r.fingerprint as string | null,
    relation: r.relation as string,
    confidence: r.confidence as number,
    proposed_by: r.proposed_by as string,
    status: r.status as MemoryLinkProposal["status"],
    rationale: r.rationale as string | null,
    evidence_json: r.evidence_json as string,
    created_at: r.created_at as string,
    decided_at: r.decided_at as string | null,
    decided_by: r.decided_by as string | null,
    decision_note: r.decision_note as string | null,
  };
}
