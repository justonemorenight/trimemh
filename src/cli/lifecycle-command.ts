import { Command } from "commander";

import type { MemoryKind } from "../domain/schema";
import { MEMORY_KINDS } from "../domain/schema";
import type { LifecycleEntityType, LifecycleState } from "../persistence/repository";
import {
  detectMemoryConflicts,
  expireMemories,
  lifecycleEvents,
  supersedeMemory,
} from "../service/lifecycle-service";
import { withDb } from "./with-db";

const ENTITY_TYPES = ["memory_event", "memory_proposal", "memory_item", "session"] as const;
const LIFECYCLE_STATES = [
  "observed",
  "proposed",
  "needs_review",
  "approved",
  "rejected",
  "merged",
  "superseded",
  "expired",
] as const;

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseEntityType(value?: string): LifecycleEntityType | undefined {
  if (!value) {
    return undefined;
  }
  if (ENTITY_TYPES.includes(value as LifecycleEntityType)) {
    return value as LifecycleEntityType;
  }
  throw new Error(`Invalid entity type "${value}". Use: ${ENTITY_TYPES.join(", ")}`);
}

function parseLifecycleState(value?: string): LifecycleState | undefined {
  if (!value) {
    return undefined;
  }
  if (LIFECYCLE_STATES.includes(value as LifecycleState)) {
    return value as LifecycleState;
  }
  throw new Error(`Invalid lifecycle state "${value}". Use: ${LIFECYCLE_STATES.join(", ")}`);
}

function parseKind(value: string): MemoryKind {
  if (MEMORY_KINDS.includes(value as MemoryKind)) {
    return value as MemoryKind;
  }
  throw new Error(`Invalid kind "${value}". Use: ${MEMORY_KINDS.join(", ")}`);
}

export function registerLifecycleCommand(program: Command): void {
  program
    .command("lifecycle")
    .description("Memory lifecycle operations")
    .addCommand(
      new Command("list")
        .description("List lifecycle events")
        .option("--entity-type <type>", "memory_event, memory_proposal, memory_item, session")
        .option("--entity-id <id>", "Filter by entity id")
        .option("--state <state>", "Filter by lifecycle state")
        .option("--limit <number>", "Max results", "50")
        .option("--json", "Print JSON")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const events = lifecycleEvents(db, config.projectId, {
              entityType: parseEntityType(opts.entityType),
              entityId: opts.entityId,
              state: parseLifecycleState(opts.state),
              limit: parsePositiveInteger(opts.limit, "--limit"),
            });

            if (opts.json) {
              console.log(JSON.stringify(events, null, 2));
              return;
            }

            for (const event of events) {
              console.log(
                `${event.created_at} | ${event.state} | ${event.entity_type}:${event.entity_id} | ${event.actor}`,
              );
              if (event.payload_hash) {
                console.log(`payload_hash=${event.payload_hash}`);
              }
            }
          }),
        ),
    )
    .addCommand(
      new Command("expire")
        .description("Expire active memories whose expires_at is before a cutoff")
        .option("--before <iso>", "Expire memories before this ISO timestamp; defaults to now")
        .option("--source-prefix <prefix>", "Only expire memories with this source prefix")
        .option("--actor <actor>", "Lifecycle actor", "cli:lifecycle")
        .option("--dry-run", "Show candidates without updating")
        .option("--json", "Print JSON")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const result = expireMemories(db, {
              projectId: config.projectId,
              before: opts.before,
              sourcePrefix: opts.sourcePrefix,
              actor: opts.actor,
              dryRun: opts.dryRun ?? false,
            });
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              `${result.status}: ${result.expired.length} memories before ${result.before}`,
            );
            for (const item of result.expired) {
              console.log(
                `${item.id} | ${item.kind} | ${item.source} | expires_at=${item.expires_at}`,
              );
            }
          }),
        ),
    )
    .addCommand(
      new Command("supersede")
        .description("Archive an old memory and link a replacement as superseding it")
        .argument("<old-memory-id>", "Memory being superseded")
        .argument("<new-memory-id>", "Replacement memory")
        .option("--actor <actor>", "Lifecycle actor", "cli:lifecycle")
        .option("--dry-run", "Show operation without updating")
        .option("--json", "Print JSON")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, oldMemoryId, newMemoryId, opts) => {
            const result = supersedeMemory(db, {
              projectId: config.projectId,
              oldMemoryId,
              newMemoryId,
              actor: opts.actor,
              dryRun: opts.dryRun ?? false,
            });
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            console.log(
              `${result.status}: ${result.newMemory.id} supersedes ${result.oldMemory.id}`,
            );
          }),
        ),
    )
    .addCommand(
      new Command("conflicts")
        .description("Find active memories that may conflict with candidate text")
        .requiredOption("--kind <kind>", "Memory kind")
        .requiredOption("--text <text>", "Candidate memory text")
        .option("--limit <number>", "Max results", "5")
        .option("--json", "Print JSON")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const result = detectMemoryConflicts(db, {
              projectId: config.projectId,
              kind: parseKind(opts.kind),
              text: opts.text,
              limit: parsePositiveInteger(opts.limit, "--limit"),
            });
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }
            for (const candidate of result) {
              console.log(
                `${candidate.memory.id} | score=${candidate.score.toFixed(3)} | ${candidate.reasons.join(", ")}`,
              );
              console.log(candidate.memory.text);
              console.log();
            }
          }),
        ),
    );
}
