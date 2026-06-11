import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

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
  SuggestedCodeLink,
} from "../domain/schema";
import { KIND_RISK_MAP } from "../domain/schema";
import { getActiveMemoryCountsByProject } from "../persistence/proposal-repo";
import { getMemoryStats, getRelatedMemoryRows, insertAuditEvent } from "../persistence/repository";
import { shouldAutoApproveLink, shouldAutoApproveMemory } from "./auto-approval";
import { suggestCodeLinksFromText } from "./code-link-suggest";
import {
  approveMemoryLinkProposal,
  getRelatedMemories,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
} from "./graph-service";
import { resolveMemoryId } from "./id-resolution";
import { findSimilarPendingProposal, mergePendingProposal } from "./proposal-dedup";
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
export function mcpPropose(
  db: Database,
  input: ProposeInput,
  opts?: { extraPaths?: string[] },
): McpProposalResult {
  const risk: RiskLevel = KIND_RISK_MAP[input.kind];
  const suggested = suggestCodeLinksFromText(input.text, opts?.extraPaths ?? []);

  const similar = findSimilarPendingProposal(db, input.projectId, input.kind, input.text);
  if (similar && !input.requireReview) {
    mergePendingProposal(db, similar, input.text, input.rationale);
    return {
      proposal_id: similar.id,
      status: "pending",
      risk_level: risk,
      merged_into_proposal_id: similar.id,
      suggested_code_links: suggested,
      message: `Merged into existing pending proposal ${similar.id} (similar ${input.kind}). Review with memory_list_proposals.`,
    };
  }

  const decision = shouldAutoApproveMemory({
    kind: input.kind,
    source: input.proposedBy,
    confidence: input.confidence,
    requireReview: input.requireReview,
    autoApprove: input.autoApprove,
  });

  if (decision.autoApprove) {
    const proposal = propose(db, input);
    const approved = approve(db, input.projectId, proposal.id, input.proposedBy);

    return {
      proposal_id: proposal.id,
      status: "approved",
      risk_level: risk,
      memory_id: approved?.id,
      suggested_code_links: suggested,
      message: approved
        ? `Auto-approved: memory ${approved.id} created. Risk: ${risk}.`
        : `Auto-approved: proposal ${proposal.id} processed (delete action).`,
    };
  }

  const proposal = propose(db, input);

  return {
    proposal_id: proposal.id,
    status: "pending",
    risk_level: risk,
    suggested_code_links: suggested,
    message: `Proposal ${proposal.id} created (pending agent review). Review in next turn with memory_list_proposals.`,
  };
}

export function mcpGet(db: Database, projectId: string, id: string): MemoryItem | null {
  try {
    return resolveMemoryId(db, projectId, id);
  } catch {
    return null;
  }
}

export function mcpStats(db: Database, projectId: string): MemoryStats {
  return getMemoryStats(db, projectId);
}

export function formatProjectMismatchWarnings(
  db: Database,
  projectId: string,
  stats: MemoryStats,
): string[] {
  if (stats.total > 0) {
    return [];
  }

  const counts = getActiveMemoryCountsByProject(db);
  const others = counts.filter((row) => row.project_id !== projectId && row.cnt > 0);
  if (others.length === 0) {
    return [];
  }

  const summary = others.map((row) => `${row.project_id} (${row.cnt})`).join(", ");
  return [
    `⚠️ Warning: DB has active memories for other project_id(s): ${summary} — current project "${projectId}" has 0`,
  ];
}

export function mcpRelated(
  db: Database,
  projectId: string,
  memoryId: string,
  depth = 1,
): RelatedMemoryResult[] {
  const resolved = resolveMemoryId(db, projectId, memoryId);
  return getRelatedMemories(db, projectId, resolved.id, depth);
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
  let item: MemoryItem;
  try {
    item = resolveMemoryId(db, projectId, id);
  } catch {
    return null;
  }

  try {
    const timestamp = new Date().toISOString();
    insertAuditEvent(db, {
      id: randomUUID(),
      project_id: projectId,
      actor: "mcp:memory_retrieve",
      event_type: "memory_retrieve",
      entity_type: "memory_item",
      entity_id: item.id,
      payload_json: JSON.stringify({
        requested_id: id,
        resolved_id: item.id,
        text_chars: item.text.length,
        estimated_tokens: Math.ceil(item.text.length / 4),
        timestamp,
      }),
      created_at: timestamp,
    });
  } catch {
    // Retrieval correctness takes precedence over telemetry.
  }

  const related = getRelatedMemoryRows(db, projectId, item.id, 1).slice(0, 5);
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

export function formatProposalResultExtras(result: McpProposalResult): string[] {
  const lines: string[] = [];
  if (result.memory_id) {
    lines.push(`memory_id: ${result.memory_id}`);
  }
  if (result.merged_into_proposal_id) {
    lines.push(`merged_into: ${result.merged_into_proposal_id}`);
  }
  if (result.suggested_code_links?.length) {
    lines.push(
      ...result.suggested_code_links.map(
        (link: SuggestedCodeLink) => `suggested_code_link: ${link.path} (${link.relation})`,
      ),
    );
  }
  return lines;
}

export function mcpCodeSearch(
  db: Database,
  projectId: string,
  path: string,
  symbol?: string,
): CodeMemoryResult[] {
  return getMemoriesForCode(db, projectId, path, symbol);
}
