import type { Database } from "bun:sqlite";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { CONFIG } from "../config";
import { assembleMemoryContext } from "../context/context-runtime";
import type {
  CodeEntityType,
  CodeLinkRelation,
  MemoryEdgeRelation,
  MemoryKind,
  RiskLevel,
} from "../domain/schema";
import { CODE_LINK_RELATIONS, KIND_RISK_MAP, MEMORY_EDGE_RELATIONS } from "../domain/schema";
import { type ResolvedTriMemhConfig, formatConfigDebugLines } from "../infrastructure/config";
import { capSearchLimit, guardOutput, guardedArgumentsHash } from "../infrastructure/guardrail";
import type { RateLimiter } from "../infrastructure/rate-limit";
import { embedText } from "../retrieval/embedding-provider";
import { applyFeedback } from "../retrieval/feedback";
import {
  approve,
  closeSession,
  formatProjectMismatchWarnings,
  formatProposalResultExtras,
  getCodeImpact,
  mcpCodeSearch,
  mcpGet,
  mcpHybridSearch,
  mcpMemoryCodeLinkPropose,
  mcpMemoryLinkPropose,
  mcpPropose,
  mcpRelated,
  mcpRetrieveFull,
  mcpSearch,
  mcpStats,
  proposals,
  reject,
} from "../service";
import { formatIdLine } from "../service/id-resolution";
import { formatProposalBatchHints, staleProposalIds } from "../service/proposal-dedup";
import { checkRateLimit } from "./runtime";
import {
  ApproveSchema,
  CodeImpactInputSchema,
  CodeSearchInputSchema,
  ContextInputSchema,
  FeedbackInputSchema,
  GetInputSchema,
  ListProposalsSchema,
  MemoryCodeLinkProposeInputSchema,
  MemoryLinkProposeInputSchema,
  ProposeInputSchema,
  RejectSchema,
  RelatedInputSchema,
  RetrieveInputSchema,
  SearchInputSchema,
  SessionCloseInputSchema,
} from "./schemas";

type TextContent = { type: "text"; text: string };

function rateLimitError(retryAfter: number): { content: TextContent[]; isError: true } {
  return {
    content: [{ type: "text", text: `Rate limit exceeded. Retry in ${retryAfter}s.` }],
    isError: true,
  };
}

export function registerMemoryTools(
  server: McpServer,
  db: Database,
  config: ResolvedTriMemhConfig,
  rateLimiter: RateLimiter,
): void {
  const { projectId } = config;

  function runtimeDebugLines(): string[] {
    return formatConfigDebugLines(config);
  }

  function statsDebugLines(stats: ReturnType<typeof mcpStats>): string[] {
    return [...runtimeDebugLines(), ...formatProjectMismatchWarnings(db, projectId, stats)];
  }
  server.registerTool(
    "memory_search",
    {
      description:
        "Search memories using FTS5 full-text, vector embedding similarity, or hybrid RRF fusion. Mode 'fts' (default) uses keyword search, 'vector' uses embedding similarity, 'hybrid' combines both with Reciprocal Rank Fusion. Use this to find relevant context before proposing new memories.",
      inputSchema: SearchInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_search");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { query, mode, embedding } = params;
      const limit = capSearchLimit(params.limit, "mcp");
      try {
        let results: Awaited<ReturnType<typeof mcpSearch>>;

        if (mode === "vector" || mode === "hybrid") {
          const queryEmbedding =
            embedding && embedding.length > 0 ? new Float32Array(embedding) : embedText(query);
          results = mcpHybridSearch(
            db,
            projectId,
            mode === "hybrid" ? query : "",
            queryEmbedding,
            limit,
          );
        } else {
          results = mcpSearch(db, projectId, query, limit);
        }

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: guardOutput(`No matching memories found (mode: ${mode}).`),
              },
            ],
          };
        }

        const formatted = guardOutput(
          results
            .map((r) => {
              const related = r.related?.length
                ? `\n  related:\n${r.related
                    .map(
                      (rel) =>
                        `    - [${rel.id.slice(0, CONFIG.mcp.shortIdLength)}] ${rel.direction} ${rel.relation}: ${rel.text.slice(0, CONFIG.mcp.snippetLength)}${rel.text.length > CONFIG.mcp.snippetLength ? "…" : ""}`,
                    )
                    .join("\n")}`
                : "";
              const why = r.explanation
                ? `\n  why: score=${r.explanation.composite_score} | ${r.explanation.why_selected.join(" ")}`
                : "";
              return `[${r.id.slice(0, CONFIG.mcp.shortIdLength)}] (${r.kind}, confidence: ${r.confidence})\n  ${formatIdLine(r.id)}\n  ${r.snippet}\n  source: ${r.source} | created: ${r.created_at?.slice(0, 10) ?? "unknown"}${why}${related}`;
            })
            .join("\n\n"),
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} memories (${mode}):\n\n${formatted}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Search error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_context",
    {
      description:
        "IMPORTANT: Call this tool at the START of every new task or conversation turn to load project memory context. Assembles progressive memory context XML for the current turn. Includes Layer 1 index, semantic/code-path/operational Layer 2 details, optional one-turn Layer 3 lineage, LRU/budget metadata. Provide the task description as 'query' and currently open file paths as 'open_paths' for best results.",
      inputSchema: ContextInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_context");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      try {
        const assembled = assembleMemoryContext({
          db,
          projectId,
          query: params.query,
          openPaths: params.open_paths,
          includeLineageForIds: params.include_lineage_for_ids,
          modelContextTokens: params.model_context_tokens,
          taskType: params.task_type,
          memoryContextBudgetRatio: params.memory_context_budget_ratio,
          evidenceMode: params.evidence_mode,
          retrievalRounds: params.retrieval_rounds,
          compressionPolicy: params.compression_policy,
        });

        const metadata = [
          ...runtimeDebugLines(),
          `selected_detail_ids=${assembled.selectedDetailIds.join(",") || "none"}`,
          `lineage_ids=${assembled.lineageIds.join(",") || "none"}`,
          `compacted_index=${assembled.compactedIndex}`,
          `over_budget=${assembled.overBudget}`,
          `task_type=${assembled.taskType}`,
          `budget_ratio=${assembled.budgetRatio}`,
          `budget_tokens=${assembled.budgetTokens}`,
          `estimated_prompt_tokens=${assembled.estimatedPromptTokens}`,
          `evidence_span_count=${assembled.evidenceSpanCount}`,
          `evidence_memory_ids=${assembled.evidenceMemoryIds.join(",") || "none"}`,
          `retrieval_rounds=${assembled.retrievalRounds}`,
          `compression_policy_id=${assembled.compressionPolicyId}`,
          `ccr_compressed=${assembled.ccrStats.compressedCount}`,
          `ccr_full=${assembled.ccrStats.fullCount}`,
          `ccr_tokens_saved=${assembled.ccrStats.totalTokensSaved}`,
          `ccr_retrievable=${assembled.ccrStats.retrievableCount}`,
          `prefix_changed=${assembled.prefixChanged}`,
        ].join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `${assembled.xml}\n\n<!-- memh_runtime\n${metadata}\n-->`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Context assembly error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_related",
    {
      description:
        "Return graph-related memories for a memory ID. Traversal depth is capped at 2. Use this when you need relationship context around an existing memory.",
      inputSchema: RelatedInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_related");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { id, depth } = params;
      try {
        const related = mcpRelated(db, projectId, id, depth);
        if (related.length === 0) {
          return { content: [{ type: "text" as const, text: "No related memories found." }] };
        }
        const text = guardOutput(
          related
            .map(
              (r) =>
                `[${r.item.id.slice(0, CONFIG.mcp.shortIdLength)}] depth ${r.depth} | ${r.direction} ${r.edge.relation} | ${r.item.kind}\n  ${r.item.text}`,
            )
            .join("\n\n"),
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Related error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_link_propose",
    {
      description:
        "Propose a memory-to-memory graph edge. Creates a pending proposal for agent review. Use memory_list_proposals to find it, then memory_approve to confirm. Set require_review=true to ensure explicit review.",
      inputSchema: MemoryLinkProposeInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const {
        source_memory_id,
        relation,
        target_memory_id,
        rationale,
        confidence,
        require_review,
      } = params;
      if (!MEMORY_EDGE_RELATIONS.includes(relation as MemoryEdgeRelation)) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(
                `Invalid relation "${relation}". Valid: ${MEMORY_EDGE_RELATIONS.join(", ")}`,
              ),
            },
          ],
          isError: true,
        };
      }

      const rl = checkRateLimit(rateLimiter, "memory_link_propose");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      try {
        const argsHash = guardedArgumentsHash({
          source_memory_id,
          relation,
          target_memory_id,
          rationale: rationale ?? "",
          confidence,
        });

        const result = mcpMemoryLinkPropose(db, {
          projectId,
          sourceMemoryId: source_memory_id,
          targetMemoryId: target_memory_id,
          relation: relation as MemoryEdgeRelation,
          rationale: rationale ?? undefined,
          confidence,
          proposedBy: "mcp:agent",
          argumentsHash: argsHash,
          requireReview: require_review ?? undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(
                `${result.message}\nStatus: ${result.status}\nType: ${result.proposal_type}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Link proposal error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_code_link_propose",
    {
      description:
        "Propose a memory-to-code link. Creates a pending proposal for agent review. Use memory_list_proposals to find it, then memory_approve to confirm. Set require_review=true to ensure explicit review.",
      inputSchema: MemoryCodeLinkProposeInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const {
        memory_id,
        path,
        relation,
        entity_type,
        symbol,
        line_start,
        line_end,
        fingerprint,
        rationale,
        confidence,
        require_review,
      } = params;
      if (!CODE_LINK_RELATIONS.includes(relation as CodeLinkRelation)) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(
                `Invalid relation "${relation}". Valid: ${CODE_LINK_RELATIONS.join(", ")}`,
              ),
            },
          ],
          isError: true,
        };
      }
      if (!["file", "function", "class", "module", "section"].includes(entity_type)) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(
                `Invalid entity_type "${entity_type}". Valid: file, function, class, module, section`,
              ),
            },
          ],
          isError: true,
        };
      }

      const rl = checkRateLimit(rateLimiter, "memory_code_link_propose");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      try {
        const argsHash = guardedArgumentsHash({
          memory_id,
          path,
          relation,
          entity_type,
          symbol: symbol ?? "",
          line_start: line_start ?? 0,
          line_end: line_end ?? 0,
          fingerprint: fingerprint ?? "",
          rationale: rationale ?? "",
          confidence,
        });

        const result = mcpMemoryCodeLinkPropose(db, {
          projectId,
          memoryId: memory_id,
          path,
          relation: relation as CodeLinkRelation,
          entityType: entity_type as CodeEntityType,
          symbol: symbol ?? undefined,
          lineStart: line_start ?? undefined,
          lineEnd: line_end ?? undefined,
          fingerprint: fingerprint ?? undefined,
          rationale: rationale ?? undefined,
          confidence,
          proposedBy: "mcp:agent",
          argumentsHash: argsHash,
          requireReview: require_review ?? undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(
                `${result.message}\nStatus: ${result.status}\nType: ${result.proposal_type}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Code link proposal error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_code_search",
    {
      description:
        "Find memories linked to a code path and optional symbol. Returns explicit memory-code links only.",
      inputSchema: CodeSearchInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const { path, symbol } = params;
      const rl = checkRateLimit(rateLimiter, "memory_code_search");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      try {
        const results = mcpCodeSearch(db, projectId, path, symbol ?? undefined);
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: "No code-linked memories found." }] };
        }
        const text = guardOutput(
          results
            .map(
              (r) =>
                `[${r.item.id.slice(0, CONFIG.mcp.shortIdLength)}] ${r.link.relation} ${r.entity.path}${r.entity.symbol ? `#${r.entity.symbol}` : ""}\n  ${r.item.text}`,
            )
            .join("\n\n"),
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Code search error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_code_impact",
    {
      description:
        "Explain the memory-backed impact radius for a code path and optional symbol. Returns linked memories, related memory graph context, and other code paths sharing those memories.",
      inputSchema: CodeImpactInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const { path, symbol, depth } = params;
      const rl = checkRateLimit(rateLimiter, "memory_code_search");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      try {
        const impact = getCodeImpact(db, { projectId, path, symbol, depth });
        if (impact.summary.entity_count === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: guardOutput(
                  `No indexed code entities found for ${path}${symbol ? `#${symbol}` : ""}.`,
                ),
              },
            ],
          };
        }

        const linked = impact.linked_memories
          .slice(0, 8)
          .map(
            (entry) =>
              `- [${entry.item.id.slice(0, CONFIG.mcp.shortIdLength)}] ${entry.link.relation}: ${entry.item.text.slice(0, CONFIG.mcp.snippetLength)}`,
          )
          .join("\n");
        const related = impact.related_memories
          .slice(0, 6)
          .map(
            (entry) =>
              `- [${entry.item.id.slice(0, CONFIG.mcp.shortIdLength)}] ${entry.direction} ${entry.edge.relation}: ${entry.item.text.slice(0, CONFIG.mcp.snippetLength)}`,
          )
          .join("\n");
        const paths = impact.affected_paths
          .slice(0, 10)
          .map(
            (entry) =>
              `- ${entry.entity.path}${entry.entity.symbol ? `#${entry.entity.symbol}` : ""} via ${entry.relation} memory ${entry.memory_id.slice(0, CONFIG.mcp.shortIdLength)}`,
          )
          .join("\n");

        const text = [
          `Impact for ${impact.query.path}${impact.query.symbol ? `#${impact.query.symbol}` : ""}`,
          `entities=${impact.summary.entity_count} linked_memories=${impact.summary.linked_memory_count} related_memories=${impact.summary.related_memory_count} affected_paths=${impact.summary.affected_path_count}`,
          linked ? `\nLinked memories:\n${linked}` : "\nLinked memories: none",
          related ? `\nRelated graph memories:\n${related}` : "\nRelated graph memories: none",
          paths ? `\nAffected paths:\n${paths}` : "\nAffected paths: none",
        ].join("\n");

        return { content: [{ type: "text" as const, text: guardOutput(text) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Code impact error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_propose",
    {
      description:
        "Propose a new memory to persist project knowledge. Low/medium-risk kinds auto-approve by default. Set require_review=true to force pending review, or auto_approve=false to force pending. Set auto_approve=true to request immediate approval when risk allows. After proposing, check suggested_code_link paths and call memory_code_link_propose if useful.",
      inputSchema: ProposeInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_propose");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { kind, text, rationale, require_review, auto_approve, confidence } = params;
      const validKinds = Object.keys(KIND_RISK_MAP);
      if (!validKinds.includes(kind as string)) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Invalid kind "${kind}". Valid kinds: ${validKinds.join(", ")}`),
            },
          ],
          isError: true,
        };
      }

      const memoryKind = kind as MemoryKind;
      const risk: RiskLevel = KIND_RISK_MAP[memoryKind];

      try {
        const argsHash = guardedArgumentsHash({ kind, text, rationale: rationale ?? "" });

        const result = mcpPropose(db, {
          kind: memoryKind,
          text,
          projectId,
          proposedBy: "mcp:agent",
          rationale: rationale ?? undefined,
          argumentsHash: argsHash,
          requireReview: require_review ?? undefined,
          autoApprove: auto_approve ?? undefined,
          confidence: confidence ?? undefined,
        });

        const msg = [result.message, ...formatProposalResultExtras(result)];

        if (result.status === "approved") {
          msg.push("✅ Memory is now active and searchable.");
        } else {
          const kindLabel = `${kind} (${risk} risk)`;
          if (risk === "critical") {
            msg.push(
              `⚠️ CRITICAL risk ${kindLabel} — review carefully. Use memory_list_proposals to find it, then memory_approve or memory_reject.`,
            );
          } else if (risk === "high") {
            msg.push(
              `⚠️ HIGH risk ${kindLabel} — review before approving. Use memory_list_proposals + memory_approve.`,
            );
          } else {
            msg.push(
              `⏳ Pending agent review. In your next turn, use memory_list_proposals to review and memory_approve to confirm.`,
            );
          }
        }

        return {
          content: [{ type: "text" as const, text: guardOutput(msg.join("\n")) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Proposal error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Agent Review Tools ──────────────────────────────────────

  server.registerTool(
    "memory_list_proposals",
    {
      description:
        "List pending proposals that need your review. After proposing memories with memory_propose, use this in your next turn to find proposals awaiting approval. Then use memory_approve or memory_reject to decide their fate.",
      inputSchema: ListProposalsSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_list_proposals");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { status: filterStatus, limit } = params;
      try {
        const items = proposals(db, projectId, filterStatus);
        const limited = items.slice(0, limit);
        const stale = staleProposalIds(limited);
        const hints = formatProposalBatchHints(limited);

        if (limited.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No ${filterStatus} proposals found.` }],
          };
        }

        const text = limited
          .map(
            (p) =>
              `[${p.id.slice(0, 8)}] ${formatIdLine(p.id)}\n  ${p.risk_level.padEnd(8)} | ${p.proposed_kind.padEnd(16)} | ${p.proposed_by}${stale.has(p.id) ? " | stale" : ""}\n  "${p.proposed_text.slice(0, 120)}${p.proposed_text.length > 120 ? "…" : ""}"\n  rationale: ${p.rationale ?? "none"}`,
          )
          .join("\n\n");

        const footer = [
          "",
          ...hints,
          "── Use memory_approve <id> to accept or memory_reject <id> to decline.",
        ].join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(
                `${limited.length} ${filterStatus} proposal(s):\n\n${text}${footer}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`List proposals error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_approve",
    {
      description:
        "Approve a pending memory proposal. The proposal is converted into an active, searchable memory. Use this after reviewing proposals from memory_list_proposals.",
      inputSchema: ApproveSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_approve");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { proposal_id } = params;
      try {
        const memory = approve(db, projectId, proposal_id, "mcp:agent");
        if (memory) {
          return {
            content: [
              {
                type: "text" as const,
                text: guardOutput(
                  `✅ Approved: memory ${memory.id.slice(0, 8)} created (kind: ${memory.kind}). Now active and searchable.`,
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`✅ Approved: proposal ${proposal_id} processed (delete action).`),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Approve error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_reject",
    {
      description:
        "Reject a pending memory proposal. The proposal is declined and will not become active. Use this when a proposal is incorrect, redundant, or low-quality. Provide a brief note explaining why.",
      inputSchema: RejectSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_reject");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { proposal_id, note } = params;
      try {
        const declined = reject(
          db,
          projectId,
          proposal_id,
          note ?? "Rejected by agent",
          "mcp:agent",
        );
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(
                `❌ Rejected: proposal ${declined.id.slice(0, 8)} (${declined.proposed_kind}). Note: ${declined.decision_note}`,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Reject error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_get",
    {
      description:
        "Retrieve a specific memory by its ID. Returns the full memory item including metadata and evidence.",
      inputSchema: GetInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_get");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { id } = params;
      try {
        const item = mcpGet(db, projectId, id);
        if (!item) {
          return {
            content: [
              {
                type: "text" as const,
                text: guardOutput(`Memory "${id}" not found in current project.`),
              },
            ],
          };
        }

        const text = guardOutput(
          [
            `ID: ${item.id}`,
            `Kind: ${item.kind}`,
            `Status: ${item.status}`,
            `Confidence: ${item.confidence}`,
            `Source: ${item.source}`,
            `Created: ${item.created_at}`,
            `Updated: ${item.updated_at}`,
            `Text: ${item.text}`,
          ].join("\n"),
        );

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_retrieve",
    {
      description:
        "Retrieve the FULL original text of a memory that was compressed/deferred in the context. Use this when you need to see the complete content of a memory that was summarized with '[N words compressed — retrieve with: memory_retrieve(\"memory_id\")]'. This is the CCR (Context Compression with Retrieval) mechanism — context is sent compressed to save tokens, and you fetch full details on demand.",
      inputSchema: RetrieveInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_retrieve");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { memory_id } = params;
      try {
        const result = mcpRetrieveFull(db, projectId, memory_id);
        if (!result) {
          return {
            content: [
              {
                type: "text" as const,
                text: guardOutput(
                  `Memory "${memory_id}" not found in current project. It may have expired or been archived.`,
                ),
              },
            ],
          };
        }

        return {
          content: [{ type: "text" as const, text: guardOutput(result.retrieval_context) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Retrieve error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_feedback",
    {
      description:
        "Report whether a retrieved memory was useful for the current task. This feedback trains the memory scoring system (P2 Agent Intelligence): useful memories rise in ranking, unhelpful memories decay. After using memories from memory_search or memory_context, briefly rate them with this tool to improve future retrieval accuracy.",
      inputSchema: FeedbackInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_feedback");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      const { memory_id, useful, reason } = params;
      try {
        const result = applyFeedback(db, {
          memoryId: memory_id,
          useful,
          reason,
          actor: "mcp:agent",
          projectId,
        });

        const msg = [
          `Feedback recorded for ${result.memoryId.slice(0, CONFIG.mcp.shortIdLength)}`,
          formatIdLine(result.memoryId),
          `Score: ${result.previousScore} → ${result.newScore} (${result.direction})`,
          `Total feedback events: ${result.totalFeedbackEvents}`,
        ];
        if (reason) {
          msg.push(`Reason: ${reason}`);
        }

        return {
          content: [{ type: "text" as const, text: guardOutput(msg.join("\n")) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Feedback error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_session_close",
    {
      description:
        "End-of-turn/session compact summary. Creates normalized session_summary, decision, and tooling memories in one call. Auto-approves low/medium risk by default. Returns suggested_code_link paths extracted from files/text.",
      inputSchema: SessionCloseInputSchema,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async (params) => {
      const rl = checkRateLimit(rateLimiter, "memory_session_close");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      try {
        const result = closeSession(db, {
          projectId,
          agentId: "mcp:agent",
          sessionId: params.session_id,
          summary: params.summary,
          files: params.files,
          commands: params.commands,
          decisions: params.decisions,
          tooling: params.tooling,
          handoffNotes: params.handoff_notes,
          autoApprove: params.auto_approve,
          requireReview: false,
        });

        return {
          content: [{ type: "text" as const, text: guardOutput(result.message) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Session close error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "memory_stats",
    {
      description:
        "Get memory statistics for the current project: total active memories, breakdown by kind and status, pending proposals count.",
      inputSchema: undefined,
    },
    // biome-ignore lint/suspicious/useAwait: warning suppression
    async () => {
      const rl = checkRateLimit(rateLimiter, "memory_stats");
      if (!rl.allowed) {
        return rateLimitError(rl.retryAfter);
      }

      try {
        const stats = mcpStats(db, projectId);
        const text = guardOutput(
          [
            ...statsDebugLines(stats),
            "",
            `Total active memories: ${stats.total}`,
            `Pending proposals: ${stats.pendingProposals}`,
            `By kind: ${JSON.stringify(stats.byKind)}`,
            `By status: ${JSON.stringify(stats.byStatus)}`,
          ].join("\n"),
        );

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: guardOutput(`Error: ${(err as Error).message}`),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
