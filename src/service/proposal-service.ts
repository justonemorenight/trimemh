import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import { CONFIG } from "../config";
import { withStructuredContextMetadata } from "../context/structured-memory";
import type {
  AuditEvent,
  MemoryItem,
  MemoryKind,
  MemoryProposal,
  MemoryStats,
  ProposalStatus,
  ProposeInput,
  RiskLevel,
} from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { guardString, handleSecurityViolation } from "../infrastructure/guardrail";
import {
  deleteMemoryItem,
  findMemoryByHash,
  getAuditEvents,
  getMemoryById,
  getMemoryStats,
  insertMemoryItem,
  insertProposal,
  listPendingProposals,
  listProposals,
  updateMemoryItem,
  updateProposal,
} from "../persistence/repository";
import { contentHash } from "../retrieval/dedup";
import { serializeEmbedding } from "../retrieval/embedding";
import { localEmbeddingProvider } from "../retrieval/embedding-provider";
import { audit, embeddingForText, guardedPayload, json, now } from "./helpers";
import { resolveProposalId } from "./id-resolution";
import { recordLifecycleEvent } from "./lifecycle-service";

function parseMetadataJson(metadataJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(metadataJson || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  recordLifecycleEvent(db, {
    projectId: input.projectId,
    entityType: "memory_proposal",
    entityId: proposal.id,
    state: input.requireReview || overrideAttempt ? "needs_review" : "proposed",
    actor: input.proposedBy,
    payloadHash: input.argumentsHash,
    payload: {
      action: proposal.action,
      kind: proposal.proposed_kind,
      risk_level: proposal.risk_level,
      require_review: input.requireReview ?? false,
    },
  });

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
  const proposal = resolveProposalId(db, projectId, proposalId);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}.`);
  }

  // Mark proposal as approved
  proposal.status = "approved";
  proposal.decided_at = now();
  proposal.decided_by = decidedBy;
  updateProposal(db, proposal);
  recordLifecycleEvent(db, {
    projectId,
    entityType: "memory_proposal",
    entityId: proposal.id,
    state: "approved",
    actor: decidedBy,
    payload: {
      kind: proposal.proposed_kind,
      risk_level: proposal.risk_level,
      action: proposal.action,
    },
  });
  audit(db, projectId, decidedBy, "proposal_approved", "memory_proposal", proposal.id, {
    kind: proposal.proposed_kind,
    risk_level: proposal.risk_level,
  });

  // Create or update the memory item
  if (proposal.action === "create") {
    const hash = contentHash(proposal.proposed_text);

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
      metadata_json: json(
        withStructuredContextMetadata({
          metadata: {
            approved_from_proposal: proposal.id,
            embedding_provider: localEmbeddingProvider.name,
          },
          text: proposal.proposed_text,
          kind: proposal.proposed_kind,
        }),
      ),
      embedding: serializeEmbedding(embeddingForText(proposal.proposed_text)),
      created_at: now(),
      updated_at: now(),
      expires_at: null,
    };

    const saved = insertMemoryItem(db, item);
    recordLifecycleEvent(db, {
      projectId,
      entityType: "memory_item",
      entityId: item.id,
      state: "merged",
      actor: decidedBy,
      payload: { from_proposal: proposal.id },
    });
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
    existing.metadata_json = json(
      withStructuredContextMetadata({
        metadataJson: existing.metadata_json,
        metadata: {
          ...parseMetadataJson(existing.metadata_json),
          updated_from_proposal: proposalId,
          embedding_provider: localEmbeddingProvider.name,
        },
        text: proposal.proposed_text,
        kind: proposal.proposed_kind,
      }),
    );

    // FTS5 sync handled by trigger
    const updated = updateMemoryItem(db, existing);
    recordLifecycleEvent(db, {
      projectId,
      entityType: "memory_item",
      entityId: updated.id,
      state: "merged",
      actor: decidedBy,
      payload: { from_proposal: proposalId, action: "update" },
    });
    audit(db, projectId, decidedBy, "memory_updated", "memory_item", updated.id, {
      from_proposal: proposalId,
    });
    return updated;
  }

  if (proposal.action === "delete" && proposal.target_memory_id) {
    const deleted = deleteMemoryItem(db, proposal.target_memory_id);
    if (deleted) {
      recordLifecycleEvent(db, {
        projectId,
        entityType: "memory_item",
        entityId: proposal.target_memory_id,
        state: "expired",
        actor: decidedBy,
        payload: { from_proposal: proposalId, action: "delete" },
      });
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
  const proposal = resolveProposalId(db, projectId, proposalId);
  if (proposal.status !== "pending") {
    throw new Error(`Proposal is already ${proposal.status}.`);
  }

  proposal.status = "rejected";
  proposal.decided_at = now();
  proposal.decided_by = decidedBy;
  proposal.decision_note = note;
  updateProposal(db, proposal);
  recordLifecycleEvent(db, {
    projectId,
    entityType: "memory_proposal",
    entityId: proposal.id,
    state: "rejected",
    actor: decidedBy,
    payload: { note, kind: proposal.proposed_kind },
  });

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
  return listProposals(db, projectId, { status, limit: CONFIG.service.defaultListLimit });
}
