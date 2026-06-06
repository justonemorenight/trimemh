import { Command } from "commander";

import type { CodeEntityType, CodeLinkRelation, MemoryEdgeRelation } from "../domain/schema";
import {
  approveMemoryLinkProposal,
  createMemoryCodeLink,
  createMemoryEdge,
  getMemoriesForCode,
  getRelatedMemories,
  proposeMemoryCodeLink,
  proposeMemoryEdge,
  rejectMemoryLinkProposal,
} from "../service";
import { withDb } from "./with-db";

export function registerGraphCommands(program: Command): void {
  const linkCommand = new Command("link").description("Create or review memory graph/code links");

  registerLinkMemoryCommand(linkCommand);
  registerLinkCodeCommand(linkCommand);
  registerLinkProposeMemoryCommand(linkCommand);
  registerLinkProposeCodeCommand(linkCommand);
  registerLinkApproveCommand(linkCommand);
  registerLinkRejectCommand(linkCommand);

  program.addCommand(linkCommand);

  registerRelatedCommand(program);

  const codeCommand = new Command("code").description("Code entity memory commands");
  registerCodeMemoriesCommand(codeCommand);
  program.addCommand(codeCommand);
}

// ─── link memory ──────────────────────────────────────────────────

function registerLinkMemoryCommand(linkCommand: Command): void {
  linkCommand
    .command("memory")
    .description("Create a direct memory-to-memory edge")
    .argument("<source-id>", "Source memory ID")
    .argument(
      "<relation>",
      "supports, contradicts, depends_on, derived_from, supersedes, relates_to",
    )
    .argument("<target-id>", "Target memory ID")
    .option("--rationale <text>", "Why this link exists")
    .option("--confidence <number>", "Confidence 0-1", "0.5")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, sourceId, relation, targetId, opts) => {
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
      }),
    );
}

// ─── link code ────────────────────────────────────────────────────

function registerLinkCodeCommand(linkCommand: Command): void {
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
    .action(
      withDb((db, config, memoryId, path, opts) => {
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
      }),
    );
}

// ─── link propose-memory ──────────────────────────────────────────

function registerLinkProposeMemoryCommand(linkCommand: Command): void {
  linkCommand
    .command("propose-memory")
    .description("Create a pending memory-to-memory edge proposal")
    .argument("<source-id>", "Source memory ID")
    .argument(
      "<relation>",
      "supports, contradicts, depends_on, derived_from, supersedes, relates_to",
    )
    .argument("<target-id>", "Target memory ID")
    .requiredOption("--rationale <text>", "Why this link should exist")
    .option("--by <source>", "Who proposed this", "cli:user")
    .option("--confidence <number>", "Confidence 0-1", "0.5")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, sourceId, relation, targetId, opts) => {
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
      }),
    );
}

// ─── link propose-code ────────────────────────────────────────────

function registerLinkProposeCodeCommand(linkCommand: Command): void {
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
    .action(
      withDb((db, config, memoryId, path, opts) => {
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
      }),
    );
}

// ─── link approve ─────────────────────────────────────────────────

function registerLinkApproveCommand(linkCommand: Command): void {
  linkCommand
    .command("approve")
    .description("Approve a pending memory link proposal")
    .argument("<proposal-id>", "Link proposal ID")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, proposalId, _opts) => {
        const created = approveMemoryLinkProposal(db, config.projectId, proposalId, "user");
        console.log(`[triMemh] Link proposal approved: ${proposalId}`);
        console.log(`  created: ${created.id}`);
      }),
    );
}

// ─── link reject ──────────────────────────────────────────────────

function registerLinkRejectCommand(linkCommand: Command): void {
  linkCommand
    .command("reject")
    .description("Reject a pending memory link proposal")
    .argument("<proposal-id>", "Link proposal ID")
    .option("--note <text>", "Reason for rejection", "Rejected by user")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, proposalId, opts) => {
        const rejected = rejectMemoryLinkProposal(
          db,
          config.projectId,
          proposalId,
          opts.note,
          "user",
        );
        console.log(`[triMemh] Link proposal rejected: ${rejected.id}`);
        console.log(`  note: ${rejected.decision_note}`);
      }),
    );
}

// ─── related ──────────────────────────────────────────────────────

function registerRelatedCommand(program: Command): void {
  program
    .command("related")
    .description("Show memories related to a memory by graph traversal")
    .argument("<memory-id>", "Memory ID")
    .option("--depth <number>", "Traversal depth, capped at 2", "1")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, memoryId, opts) => {
        const related = getRelatedMemories(
          db,
          config.projectId,
          memoryId,
          parseInt(opts.depth, 10),
        );
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
      }),
    );
}

// ─── code memories ────────────────────────────────────────────────

function registerCodeMemoriesCommand(codeCommand: Command): void {
  codeCommand
    .command("memories")
    .description("Show memories linked to a code path/symbol")
    .argument("<path>", "Code file path")
    .option("--symbol <symbol>", "Function/class/module symbol")
    .option("--db <path>", "Custom database path")
    .action(
      withDb((db, config, path, opts) => {
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
      }),
    );
}
