import { Command } from "commander";

import { captureHookEvent, parseHookEvent } from "../service/hook-service";
import { withDb } from "./with-db";

async function readStdinJson(): Promise<unknown> {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid hook JSON payload: ${(err as Error).message}`, { cause: err });
  }
}

export function registerHooksCommand(program: Command): void {
  program
    .command("hooks")
    .description("Lifecycle hook ingestion commands")
    .addCommand(
      new Command("capture")
        .description("Capture a lifecycle hook payload from stdin")
        .requiredOption("--event <event>", "Hook event name")
        .option("--agent <agent>", "Agent id that emitted the hook", "unknown")
        .option("--db <path>", "Custom database path")
        .option("--dry-run", "Normalize and print without writing proposals")
        .action(
          withDb(async (db, config, opts) => {
            const event = parseHookEvent(opts.event);
            const payload = await readStdinJson();
            const result = captureHookEvent(db, {
              event,
              agent: opts.agent,
              projectId: config.projectId,
              payload,
              dryRun: opts.dryRun ?? false,
            });

            console.log(
              JSON.stringify(
                {
                  status: result.status,
                  event: result.event,
                  agent: result.agent,
                  kind: result.kind,
                  proposal_id: result.proposalId,
                  payload_hash: result.payloadHash,
                  lifecycle_state: result.lifecycleState,
                  normalized_event: result.normalizedEvent,
                  redacted: result.redacted,
                  truncated: result.truncated,
                  require_review: result.requireReview,
                  message: result.message,
                },
                null,
                2,
              ),
            );
          }),
        ),
    );
}
