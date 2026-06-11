import type { Database } from "bun:sqlite";

import { CONFIG } from "../config";
import type { AuditEvent, MemoryProposal, MemoryStats, ProposalStatus } from "../domain/schema";
import {
  getAuditEvents,
  getMemoryStats,
  listPendingProposals,
  listProposals,
} from "../persistence/repository";

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
