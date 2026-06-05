#!/usr/bin/env bun

import { Command } from "commander";

import {
  detectAgents,
  installForAgent,
  printDetection,
  printInstallResults,
  printPostInstall,
} from "./cli/install-command";
import { registerLearnCommand } from "./cli/learn-command";
import { assembleMemoryContext } from "./context/context-runtime";
import type {
  CodeEntityType,
  CodeLinkRelation,
  MemoryEdgeRelation,
  MemoryKind,
  Visibility,
} from "./domain/schema";
import { loadConfig } from "./infrastructure/config";
import { formatConfigAsJSON, generateMCPConfig } from "./mcp/config-gen";
import { startMcpServer } from "./mcp/server";
import { closeDb, getDb, runMigrations } from "./persistence/db";
import {
  approve,
  approveMemoryLinkProposal,
  createMemoryCodeLink,
  createMemoryEdge,
  dedupMerge,
  dedupScan,
  forget,
  getMemoriesForCode,
  getRelatedMemories,
  listAll,
  propose,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
  recall,
  reject,
  rejectMemoryLinkProposal,
  remember,
  status,
} from "./service";

const program = new Command();

function csv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

program
  .name("trimemh")
  .description("Memory Harness — local-first governance-first agent memory")
  .version("0.1.0");

// ─── init ─────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize memory database for the current project")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    console.log(`[triMemh] Initialized at ${dbPath}`);
    console.log(`[triMemh] Project ID: ${config.projectId}`);
    closeDb();
  });

// ─── remember ─────────────────────────────────────────────────────

program
  .command("remember")
  .description("Write a memory directly (low/medium risk only)")
  .requiredOption("--kind <kind>", "Memory kind: preference, fact, decision, etc.")
  .requiredOption("--text <text>", "Memory text content")
  .option("--confidence <number>", "Confidence 0-1", "0.5")
  .option("--visibility <visibility>", "private, team, or public", "private")
  .option("--source <source>", "Source label", "cli:user:explicit")
  .option("--expires <iso-date>", "Expiration date (ISO 8601)")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    try {
      const item = remember(db, {
        kind: opts.kind as MemoryKind,
        text: opts.text,
        projectId: config.projectId,
        confidence: parseFloat(opts.confidence),
        visibility: opts.visibility as Visibility,
        source: opts.source,
        expiresAt: opts.expires ?? undefined,
      });
      console.log(`[triMemh] Remembered: ${item.id}`);
      console.log(`  kind: ${item.kind}`);
      console.log(`  text: ${item.text.slice(0, 80)}${item.text.length > 80 ? "…" : ""}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }

    closeDb();
  });

// ─── recall ───────────────────────────────────────────────────────

program
  .command("recall")
  .description("Search memories using FTS5")
  .argument("<query>", "Search query")
  .option("--limit <number>", "Max results", "10")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (query, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    const results = recall(db, config.projectId, query, parseInt(opts.limit, 10));
    if (results.length === 0) {
      console.log("[triMemh] No memories found.");
    } else {
      for (const r of results) {
        console.log(`── ${r.item.id} (${r.item.kind}, confidence: ${r.item.confidence})`);
        console.log(`   ${r.snippet}`);
        console.log();
      }
    }

    closeDb();
  });

// ─── list ─────────────────────────────────────────────────────────

program
  .command("list")
  .description("List memories in current project")
  .option("--kind <kind>", "Filter by kind")
  .option("--status <status>", "Filter by status (active/archived/expired)")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    const items = listAll(db, config.projectId, opts.kind, opts.status);
    if (items.length === 0) {
      console.log("[triMemh] No memories found.");
    } else {
      for (const item of items) {
        const preview = item.text.replace(/\n/g, " ").slice(0, 100);
        console.log(
          `${item.id.slice(0, 8)} | ${item.kind.padEnd(16)} | ${item.status} | ${preview}${item.text.length > 100 ? "…" : ""}`,
        );
      }
      console.log(`\n[triMemh] ${items.length} memories total.`);
    }

    closeDb();
  });

// ─── forget ───────────────────────────────────────────────────────

program
  .command("forget")
  .description("Delete a memory by id")
  .argument("<id>", "Memory ID (or prefix)")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (id, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    try {
      const deleted = forget(db, config.projectId, id);
      if (deleted) {
        console.log(`[triMemh] Forgotten: ${id}`);
      }
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }

    closeDb();
  });

// ─── propose ──────────────────────────────────────────────────────

program
  .command("propose")
  .description("Create a pending proposal (for agent/reflect use)")
  .requiredOption("--kind <kind>", "Memory kind")
  .requiredOption("--text <text>", "Proposed memory text")
  .option("--by <source>", "Who proposed this", "cli:user")
  .option("--rationale <text>", "Why this memory should exist")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    const p = propose(db, {
      kind: opts.kind as MemoryKind,
      text: opts.text,
      projectId: config.projectId,
      proposedBy: opts.by,
      rationale: opts.rationale,
    });

    console.log(`[triMemh] Proposal created: ${p.id}`);
    console.log(`  kind: ${p.proposed_kind}`);
    console.log(`  risk: ${p.risk_level}`);
    console.log(`  status: ${p.status}`);
    console.log(
      `  Use "tritrimemh approve ${p.id.slice(0, 8)}" to accept or "tritrimemh reject ${p.id.slice(0, 8)}" to decline.`,
    );

    closeDb();
  });

// ─── approve ──────────────────────────────────────────────────────

program
  .command("approve")
  .description("Approve a pending proposal")
  .argument("<proposal-id>", "Proposal ID (or prefix)")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (proposalId, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    try {
      const item = approve(db, config.projectId, proposalId, "user");
      if (item) {
        console.log(`[triMemh] Approved and created memory: ${item.id}`);
        console.log(`  kind: ${item.kind}`);
      } else {
        console.log(`[triMemh] Approved (delete action — no new memory).`);
      }
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }

    closeDb();
  });

// ─── reject ───────────────────────────────────────────────────────

program
  .command("reject")
  .description("Reject a pending proposal")
  .argument("<proposal-id>", "Proposal ID (or prefix)")
  .option("--note <text>", "Reason for rejection", "Rejected by user")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (proposalId, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    try {
      const p = reject(db, config.projectId, proposalId, opts.note, "user");
      console.log(`[triMemh] Rejected: ${p.id}`);
      console.log(`  note: ${p.decision_note}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }

    closeDb();
  });

// ─── status ───────────────────────────────────────────────────────

program
  .command("status")
  .description("Show memory statistics and pending proposals")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    const s = status(db, config.projectId);
    console.log(`[triMemh] Project: ${config.projectId}`);
    console.log(`[triMemh] DB path: ${dbPath}`);
    console.log();
    console.log("── Stats ──");
    console.log(`  Total active memories: ${s.stats.total}`);
    console.log(`  Pending proposals:    ${s.stats.pendingProposals}`);
    console.log("  By kind:", s.stats.byKind);
    console.log("  By status:", s.stats.byStatus);

    if (s.pendingProposals.length > 0) {
      console.log();
      console.log("── Pending Proposals ──");
      for (const p of s.pendingProposals) {
        const preview = p.proposed_text.replace(/\n/g, " ").slice(0, 80);
        console.log(
          `  ${p.id.slice(0, 8)} | ${p.risk_level.padEnd(8)} | ${p.proposed_kind.padEnd(16)} | ${preview}…`,
        );
      }
    }

    console.log();
    console.log("── Recent Audit (last 5) ──");
    for (const e of s.recentAudit.slice(0, 5)) {
      console.log(
        `  ${e.created_at.slice(0, 19)} | ${e.event_type.padEnd(18)} | ${e.entity_type}:${e.entity_id.slice(0, 8)}`,
      );
    }

    closeDb();
  });

// ─── dedup ───────────────────────────────────────────────────────

program
  .command("dedup")
  .description("Scan for near-duplicate memories using semantic similarity")
  .option("--db <path>", "Custom database path")
  .option("--threshold <number>", "Cosine similarity threshold (0-1)", "0.90")
  .option("--fix", "Auto-merge near-duplicates (older kept, newer merged)")
  .option("--dry-run", "Show what would be merged without executing")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    const threshold = parseFloat(opts.threshold);
    if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
      console.error("[triMemh] Invalid threshold. Must be between 0 and 1.");
      closeDb();
      process.exit(1);
    }

    const report = dedupScan(db, config.projectId, threshold);

    console.log(`[triMemh] Project: ${config.projectId}`);
    console.log(`[triMemh] Memories with embeddings: ${report.totalMemoriesWithEmbeddings}`);
    console.log(`[triMemh] Threshold: ${report.threshold}`);
    console.log(`[triMemh] Near-duplicate pairs found: ${report.pairs.length}`);
    console.log();

    if (report.pairs.length === 0) {
      console.log("No near-duplicates detected.");
      closeDb();
      return;
    }

    for (const pair of report.pairs) {
      console.log(`── ${(pair.similarity * 100).toFixed(1)}% similar ──`);
      console.log(
        `  A [${pair.memoryA.kind}] ${pair.memoryA.id.slice(0, 8)}: ${pair.memoryA.text}…`,
      );
      console.log(
        `  B [${pair.memoryB.kind}] ${pair.memoryB.id.slice(0, 8)}: ${pair.memoryB.text}…`,
      );
      console.log();
    }

    if (opts.fix && !opts.dryRun) {
      console.log("── Merging near-duplicates ──");
      for (const pair of report.pairs) {
        try {
          const merged = dedupMerge(db, config.projectId, pair.memoryB.id, pair.memoryA.id);
          console.log(`  Merged ${pair.memoryB.id.slice(0, 8)} → ${merged.id.slice(0, 8)}`);
        } catch (err) {
          console.error(`  Failed: ${(err as Error).message}`);
        }
      }
    } else if (opts.fix && opts.dryRun) {
      console.log("── Dry run (no changes made) ──");
    }

    closeDb();
  });

// ─── graph/code link commands ────────────────────────────────────

const linkCommand = new Command("link").description("Create or review memory graph/code links");

linkCommand
  .command("memory")
  .description("Create a direct memory-to-memory edge")
  .argument("<source-id>", "Source memory ID")
  .argument("<relation>", "supports, contradicts, depends_on, derived_from, supersedes, relates_to")
  .argument("<target-id>", "Target memory ID")
  .option("--rationale <text>", "Why this link exists")
  .option("--confidence <number>", "Confidence 0-1", "0.5")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (sourceId, relation, targetId, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    try {
      const edge = createMemoryEdge(db, {
        projectId: config.projectId,
        sourceMemoryId: sourceId,
        targetMemoryId: targetId,
        relation: relation as MemoryEdgeRelation,
        rationale: opts.rationale,
        confidence: parseFloat(opts.confidence),
        source: "cli:user:explicit",
      });
      console.log(`[triMemh] Memory edge created: ${edge.id}`);
      console.log(`  ${edge.source_memory_id} --${edge.relation}--> ${edge.target_memory_id}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }
    closeDb();
  });

linkCommand
  .command("code")
  .description("Create a direct memory-to-code link")
  .argument("<memory-id>", "Memory ID")
  .argument("<path>", "Code file path")
  .option(
    "--relation <relation>",
    "relates_to, documents, warns_about, implements, depends_on",
    "relates_to",
  )
  .option("--entity-type <type>", "file, function, class, module, section", "file")
  .option("--symbol <symbol>", "Function/class/module symbol")
  .option("--line-start <number>", "Start line")
  .option("--line-end <number>", "End line")
  .option("--fingerprint <hash>", "Code fingerprint/hash")
  .option("--rationale <text>", "Why this link exists")
  .option("--confidence <number>", "Confidence 0-1", "0.5")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (memoryId, path, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    try {
      const link = createMemoryCodeLink(db, {
        projectId: config.projectId,
        memoryId,
        path,
        entityType: opts.entityType as CodeEntityType,
        symbol: opts.symbol,
        lineStart: opts.lineStart ? parseInt(opts.lineStart, 10) : undefined,
        lineEnd: opts.lineEnd ? parseInt(opts.lineEnd, 10) : undefined,
        fingerprint: opts.fingerprint,
        relation: opts.relation as CodeLinkRelation,
        rationale: opts.rationale,
        confidence: parseFloat(opts.confidence),
        source: "cli:user:explicit",
      });
      console.log(`[triMemh] Memory code link created: ${link.id}`);
      console.log(`  memory: ${link.memory_id}`);
      console.log(`  entity: ${link.entity_id}`);
      console.log(`  relation: ${link.relation}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }
    closeDb();
  });

linkCommand
  .command("propose-memory")
  .description("Create a pending memory-to-memory edge proposal")
  .argument("<source-id>", "Source memory ID")
  .argument("<relation>", "supports, contradicts, depends_on, derived_from, supersedes, relates_to")
  .argument("<target-id>", "Target memory ID")
  .requiredOption("--rationale <text>", "Why this link should exist")
  .option("--by <source>", "Who proposed this", "cli:user")
  .option("--confidence <number>", "Confidence 0-1", "0.5")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (sourceId, relation, targetId, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    try {
      const proposal = proposeMemoryEdge(db, {
        projectId: config.projectId,
        sourceMemoryId: sourceId,
        targetMemoryId: targetId,
        relation: relation as MemoryEdgeRelation,
        rationale: opts.rationale,
        confidence: parseFloat(opts.confidence),
        proposedBy: opts.by,
      });
      console.log(`[triMemh] Link proposal created: ${proposal.id}`);
      console.log(`  type: ${proposal.proposal_type}`);
      console.log(`  status: ${proposal.status}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }
    closeDb();
  });

linkCommand
  .command("propose-code")
  .description("Create a pending memory-to-code link proposal")
  .argument("<memory-id>", "Memory ID")
  .argument("<path>", "Code file path")
  .option(
    "--relation <relation>",
    "relates_to, documents, warns_about, implements, depends_on",
    "relates_to",
  )
  .option("--entity-type <type>", "file, function, class, module, section", "file")
  .option("--symbol <symbol>", "Function/class/module symbol")
  .option("--line-start <number>", "Start line")
  .option("--line-end <number>", "End line")
  .option("--fingerprint <hash>", "Code fingerprint/hash")
  .option("--rationale <text>", "Why this link should exist")
  .option("--by <source>", "Who proposed this", "cli:user")
  .option("--confidence <number>", "Confidence 0-1", "0.5")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (memoryId, path, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    try {
      const proposal = proposeMemoryCodeLink(db, {
        projectId: config.projectId,
        memoryId,
        path,
        entityType: opts.entityType as CodeEntityType,
        symbol: opts.symbol,
        lineStart: opts.lineStart ? parseInt(opts.lineStart, 10) : undefined,
        lineEnd: opts.lineEnd ? parseInt(opts.lineEnd, 10) : undefined,
        fingerprint: opts.fingerprint,
        relation: opts.relation as CodeLinkRelation,
        rationale: opts.rationale,
        confidence: parseFloat(opts.confidence),
        proposedBy: opts.by,
      });
      console.log(`[triMemh] Link proposal created: ${proposal.id}`);
      console.log(`  type: ${proposal.proposal_type}`);
      console.log(`  status: ${proposal.status}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }
    closeDb();
  });

linkCommand
  .command("approve")
  .description("Approve a pending memory link proposal")
  .argument("<proposal-id>", "Link proposal ID")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (proposalId, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    try {
      const created = approveMemoryLinkProposal(db, config.projectId, proposalId, "user");
      console.log(`[triMemh] Link proposal approved: ${proposalId}`);
      console.log(`  created: ${created.id}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }
    closeDb();
  });

linkCommand
  .command("reject")
  .description("Reject a pending memory link proposal")
  .argument("<proposal-id>", "Link proposal ID")
  .option("--note <text>", "Reason for rejection", "Rejected by user")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (proposalId, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    try {
      const rejected = rejectMemoryLinkProposal(
        db,
        config.projectId,
        proposalId,
        opts.note,
        "user",
      );
      console.log(`[triMemh] Link proposal rejected: ${rejected.id}`);
      console.log(`  note: ${rejected.decision_note}`);
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }
    closeDb();
  });

program.addCommand(linkCommand);

program
  .command("related")
  .description("Show memories related to a memory by graph traversal")
  .argument("<memory-id>", "Memory ID")
  .option("--depth <number>", "Traversal depth, capped at 2", "1")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (memoryId, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    try {
      const related = getRelatedMemories(db, config.projectId, memoryId, parseInt(opts.depth, 10));
      if (related.length === 0) {
        console.log("[triMemh] No related memories found.");
      } else {
        for (const r of related) {
          console.log(
            `${r.item.id.slice(0, 8)} | depth ${r.depth} | ${r.direction} ${r.edge.relation} | ${r.item.kind}`,
          );
          console.log(`  ${r.item.text.slice(0, 120)}${r.item.text.length > 120 ? "…" : ""}`);
        }
      }
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }
    closeDb();
  });

const codeCommand = new Command("code").description("Code entity memory commands");

codeCommand
  .command("memories")
  .description("Show memories linked to a code path/symbol")
  .argument("<path>", "Code file path")
  .option("--symbol <symbol>", "Function/class/module symbol")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (path, opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);
    const results = getMemoriesForCode(db, config.projectId, path, opts.symbol);
    if (results.length === 0) {
      console.log("[triMemh] No code-linked memories found.");
    } else {
      for (const r of results) {
        console.log(
          `${r.item.id.slice(0, 8)} | ${r.link.relation} | ${r.entity.path}${r.entity.symbol ? `#${r.entity.symbol}` : ""}`,
        );
        console.log(`  ${r.item.text.slice(0, 120)}${r.item.text.length > 120 ? "…" : ""}`);
      }
    }
    closeDb();
  });

program.addCommand(codeCommand);

// ─── context ──────────────────────────────────────────────────────

program
  .command("context")
  .description("Assemble progressive memory context XML for the current turn")
  .option("--query <text>", "Current task/query text for semantic and operational triggers")
  .option("--paths <csv>", "Comma-separated open code paths")
  .option("--lineage <csv>", "Comma-separated memory IDs to include one-turn lineage for")
  .option("--tokens <number>", "Model context window tokens", "32000")
  .option("--db <path>", "Custom database path")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const config = loadConfig();
    const dbPath = opts.db ?? config.dbPath;
    const db = getDb(dbPath);
    runMigrations(db);

    try {
      const assembled = assembleMemoryContext({
        db,
        projectId: config.projectId,
        query: opts.query,
        openPaths: csv(opts.paths),
        includeLineageForIds: csv(opts.lineage),
        modelContextTokens: parseInt(opts.tokens, 10),
      });
      console.log(assembled.xml);
      console.error(
        `[triMemh] selected details: ${assembled.selectedDetailIds.join(", ") || "none"}`,
      );
      if (assembled.overBudget) {
        console.error(
          "[triMemh] warning: memory context remains over budget after compaction/eviction.",
        );
      }
    } catch (err: unknown) {
      console.error(`[triMemh] Error: ${(err as Error).message}`);
      process.exit(1);
    }

    closeDb();
  });

// ─── install ───────────────────────────────────────────────────────

program
  .command("install")
  .description("Auto-detect AI agents and install MCP config")
  .option(
    "-t, --target <agent>",
    "Install for specific agent (claude, cursor, codex, copilot, aider)",
  )
  .option("--all", "Install for all detected agents")
  .option("--dry-run", "Show what would be installed without making changes")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const memhConfig = loadConfig();
    const detected = detectAgents();

    if (opts.dryRun) {
      console.log("\n🧪 Dry run — no files will be modified.\n");
      printDetection(detected);
      for (const d of detected) {
        if (d.installed) {
          const generated = generateMCPConfig(memhConfig, d.agent.target);
          console.log(`  ${d.agent.icon} ${d.agent.name}:`);
          console.log(`    → ${d.configPath}`);
          console.log(
            formatConfigAsJSON(generated)
              .split("\n")
              .map((l) => `    ${l}`)
              .join("\n"),
          );
          console.log();
        }
      }
      return;
    }

    if (opts.target) {
      // Install for specific agent
      const targetId = opts.target.toLowerCase();
      const found = detected.find((d) => d.agent.id === targetId);
      if (!found) {
        console.error(
          `\nUnknown agent "${opts.target}". Known: claude, cursor, codex, copilot, aider\n`,
        );
        process.exit(1);
      }
      if (!found.installed) {
        console.error(`\n${found.agent.name} not detected on this system.\n`);
        console.error(`Config file would be at: ${found.configPath}`);
        console.error(
          `Run with --dry-run to preview, or install anyway by creating the config manually.\n`,
        );
        process.exit(1);
      }
      const result = installForAgent(memhConfig, found);
      printInstallResults([result]);
      if (result.success) {
        printPostInstall([found.agent]);
      }
    } else if (opts.all) {
      // Install for all detected agents
      const toInstall = detected.filter((d) => d.installed);
      if (toInstall.length === 0) {
        console.log("\nNo AI agents detected on this system.\n");
        console.log(
          "Supported agents: Claude Code, Cursor IDE, OpenAI Codex, GitHub Copilot, Aider\n",
        );
        return;
      }
      const results = toInstall.map((d) => installForAgent(memhConfig, d));
      printInstallResults(results);
      const succeeded = results.filter((r) => r.success).map((r) => r.agent);
      if (succeeded.length > 0) {
        printPostInstall(succeeded);
      }
    } else {
      // Interactive mode: show detected agents
      printDetection(detected);
      const installed = detected.filter((d) => d.installed);

      if (installed.length === 0) {
        console.log(`\n  No AI agents detected on this system.\n`);
        console.log(`  Supported: Claude Code, Cursor IDE, OpenAI Codex, GitHub Copilot, Aider`);
        console.log(`  Install one of these agents first, then run 'tritrimemh install' again.\n`);
        console.log(`  Or use --dry-run to preview the config for manual setup.\n`);
        return;
      }

      if (installed.length === 1) {
        // Single agent — auto-install
        const agent = installed[0];
        if (!agent) {
          return;
        }
        console.log(`\n  Auto-installing for ${agent.agent.icon} ${agent.agent.name}...\n`);
        const result = installForAgent(memhConfig, agent);
        printInstallResults([result]);
        if (result.success) {
          printPostInstall([agent.agent]);
        }
      } else {
        // Multiple agents — show options
        console.log(`\n  Multiple agents detected. Choose one or run with --all:\n`);
        for (let i = 0; i < installed.length; i++) {
          const d = installed[i];
          if (!d) {
            continue;
          }
          console.log(`  ${i + 1}. ${d.agent.icon} ${d.agent.name} → ${d.configPath}`);
        }
        console.log(`  a. All of the above`);
        console.log(
          `\n  Run: trimemh install --target <name>  (e.g., trimemh install --target claude)`,
        );
        console.log(`  Run: trimemh install --all              (install for all detected)\n`);
      }
    }
  });

// ─── mcp serve ────────────────────────────────────────────────────

program
  .command("mcp")
  .description("MCP server commands")
  .addCommand(
    new Command("serve")
      .description("Start MCP stdio server for agent integration")
      .option("--db <path>", "Custom database path")
      .action(async (opts) => {
        const config = loadConfig();
        const dbPath = opts.db ?? config.dbPath;
        const db = getDb(dbPath);
        runMigrations(db);

        console.error(`[triMemh] MCP server starting (project: ${config.projectId})`);
        await startMcpServer(db, config.projectId);
        // MCP server runs until stdin closes
      }),
  )
  .addCommand(
    new Command("config")
      .description("Generate MCP client config JSON for Claude Code, Cursor, etc.")
      .action(() => {
        const memhConfig = loadConfig();
        const generated = generateMCPConfig(memhConfig, "generic");
        console.log(formatConfigAsJSON(generated));
        console.error("\n[triMemh] Add this to your MCP client config.");
        console.error("[triMemh] Or run 'tritrimemh install' for automatic setup.\n");
      }),
  );

registerLearnCommand(program);

// ─── Parse ────────────────────────────────────────────────────────

program.parse();
