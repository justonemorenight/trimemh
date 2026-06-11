import type { Database } from "bun:sqlite";

import { v4 as uuidv4 } from "uuid";

import type { MemoryKind, MemoryProposal, ProposeInput, RiskLevel } from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { guardString, handleSecurityViolation } from "../infrastructure/guardrail";
import { getMemoryById, insertProposal } from "../persistence/repository";
import { audit, guardedPayload, json, now } from "./helpers";
import { recordLifecycleEvent } from "./lifecycle-service";

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
