import type { Database } from "bun:sqlite";

import { getMemoriesForCode, recall } from "../application/recall-use-cases";
import { CONFIG } from "../config";
import type {
  CodeMemoryResult,
  McpLinkProposalResult,
  McpProposalResult,
  McpSearchResult,
  MemoryItem,
  MemoryKind,
  MemoryStats,
  ProposeInput,
  ProposeMemoryCodeLinkInput,
  ProposeMemoryEdgeInput,
  RelatedMemoryResult,
  RiskLevel,
} from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { getMemoryById, getMemoryStats, getRelatedMemoryRows } from "../persistence/repository";
import { shouldAutoApproveLink, shouldAutoApproveMemory } from "./auto-approval";
import {
  approveMemoryLinkProposal,
  getRelatedMemories,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
} from "./graph-service";
import { approve, propose } from "./proposal-service";

// ─── MCP-facing service calls ──────────────────────────────────────

export function mcpSearch(
  db: Database,
  projectId: string,
  query: string,
  limit = CONFIG.service.defaultSearchLimit,
): McpSearchResult[] {
  const results = recall(db, projectId, query, limit, "fts", null, null, {
    rerank: false,
  });
  return results.map((r) => ({
    id: r.item.id,
    kind: r.item.kind as MemoryKind,
    text: r.item.text,
    snippet: r.snippet,
    confidence: r.item.confidence,
    source: r.item.source,
    created_at: r.item.created_at,
    explanation: r.explanation,
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
  limit = CONFIG.service.defaultSearchLimit,
): McpSearchResult[] {
  const mode = query ? "hybrid" : "vector";
  const results = recall(db, projectId, query || "", limit, mode, embedding, null, {
    rerank: false,
  });
  return results.map((r) => ({
    id: r.item.id,
    kind: r.item.kind as MemoryKind,
    text: r.item.text,
    snippet: r.item.text.slice(0, CONFIG.service.snippetLength),
    confidence: r.item.confidence,
    source: r.item.source,
    created_at: r.item.created_at,
    explanation: r.explanation,
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

/**
 * Propose a new memory via MCP.
 *
 * Default behavior: creates a PENDING proposal for agent review.
 * The agent should review and approve/reject pending proposals in the
 * next turn using `memory_list_proposals` + `memory_approve`/`memory_reject`.
 *
 * Auto-approve can be enabled via TRIMEMH_AUTO_APPROVE env var or
 * by setting CONFIG.autoApprove.enabled = true.
 */
export function mcpPropose(db: Database, input: ProposeInput): McpProposalResult {
  const risk: RiskLevel = KIND_RISK_MAP[input.kind];
  const decision = shouldAutoApproveMemory({
    kind: input.kind,
    source: input.proposedBy,
    confidence: input.confidence,
    requireReview: input.requireReview,
  });

  if (decision.autoApprove) {
    const proposal = propose(db, input);
    const approved = approve(db, input.projectId, proposal.id, input.proposedBy);

    return {
      proposal_id: proposal.id,
      status: "approved",
      risk_level: risk,
      message: approved
        ? `Auto-approved: memory ${approved.id} created. Risk: ${risk}.`
        : `Auto-approved: proposal ${proposal.id} processed (delete action).`,
    };
  }

  // Default: create pending proposal for agent review
  const proposal = propose(db, input);

  return {
    proposal_id: proposal.id,
    status: "pending",
    risk_level: risk,
    message: `Proposal ${proposal.id} created (pending agent review). Review in next turn with memory_list_proposals.`,
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

/**
 * Propose a memory-to-memory link via MCP.
 *
 * Default: creates pending proposal for agent review.
 * Auto-approved only when TRIMEMH_AUTO_APPROVE or config enables it.
 */
export function mcpMemoryLinkPropose(
  db: Database,
  input: ProposeMemoryEdgeInput,
): McpLinkProposalResult {
  const decision = shouldAutoApproveLink({
    relation: input.relation,
    source: input.proposedBy,
    requireReview: input.requireReview,
  });

  const proposal = proposeMemoryEdge(db, input);

  if (decision.autoApprove) {
    const created = approveMemoryLinkProposal(db, input.projectId, proposal.id, input.proposedBy);
    return {
      proposal_id: proposal.id,
      status: "approved",
      proposal_type: proposal.proposal_type,
      message: `Auto-approved: link ${created.id} created.`,
    };
  }

  return {
    proposal_id: proposal.id,
    status: "pending",
    proposal_type: proposal.proposal_type,
    message: `Link proposal ${proposal.id} created (pending agent review). Review with memory_list_proposals.`,
  };
}

/**
 * Propose a memory-to-code link via MCP.
 *
 * Default: creates pending proposal for agent review.
 * Auto-approved only when TRIMEMH_AUTO_APPROVE or config enables it.
 */
export function mcpMemoryCodeLinkPropose(
  db: Database,
  input: ProposeMemoryCodeLinkInput,
): McpLinkProposalResult {
  const decision = shouldAutoApproveLink({
    relation: input.relation,
    source: input.proposedBy,
    requireReview: input.requireReview,
  });

  const proposal = proposeMemoryCodeLink(db, input);

  if (decision.autoApprove) {
    const created = approveMemoryLinkProposal(db, input.projectId, proposal.id, input.proposedBy);
    return {
      proposal_id: proposal.id,
      status: "approved",
      proposal_type: proposal.proposal_type,
      message: `Auto-approved: code link ${created.id} created.`,
    };
  }

  return {
    proposal_id: proposal.id,
    status: "pending",
    proposal_type: proposal.proposal_type,
    message: `Code link proposal ${proposal.id} created (pending agent review). Review with memory_list_proposals.`,
  };
}

/**
 * Retrieve a full memory by ID for CCR deferred detail retrieval.
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
