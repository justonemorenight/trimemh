import { Command } from "commander";

import {
  listSessionRegistry,
  listSessionSummaries,
  sessionHistory,
  summarizeSession,
} from "../service/session-service";
import { withDb } from "./with-db";

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseFiles(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export function registerSessionCommand(program: Command): void {
  program
    .command("session")
    .description("Session memory workflows")
    .addCommand(
      new Command("summarize")
        .description("Propose a first-class session handoff summary")
        .requiredOption("--summary <text>", "Session summary text")
        .option("--agent <agent>", "Agent id", "unknown")
        .option("--session-id <id>", "Session id")
        .option("--parent-session-id <id>", "Parent/forked session id")
        .option("--files <paths>", "Comma-separated files")
        .option("--handoff <text>", "Handoff notes")
        .option("--source-event <event>", "Source lifecycle event")
        .option("--dry-run", "Normalize without creating a proposal")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const result = summarizeSession(db, {
              projectId: config.projectId,
              agentId: opts.agent,
              sessionId: opts.sessionId,
              parentSessionId: opts.parentSessionId,
              summary: opts.summary,
              files: parseFiles(opts.files),
              handoffNotes: opts.handoff,
              sourceEvent: opts.sourceEvent,
              dryRun: opts.dryRun ?? false,
            });
            console.log(JSON.stringify(result, null, 2));
          }),
        ),
    )
    .addCommand(
      new Command("history")
        .description("Search first-class session summaries")
        .option("--agent <agent>", "Filter by agent id")
        .option("--session-id <id>", "Filter by session id")
        .option("--limit <number>", "Max results", "10")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const items = sessionHistory(db, {
              projectId: config.projectId,
              agentId: opts.agent,
              sessionId: opts.sessionId,
              limit: parsePositiveInteger(opts.limit, "--limit"),
            });
            for (const item of items) {
              console.log(`${item.id} | ${item.source} | ${item.created_at}`);
              console.log(item.text);
              console.log();
            }
          }),
        ),
    )
    .addCommand(
      new Command("list")
        .description("List active session summaries")
        .option("--limit <number>", "Max results", "20")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const items = listSessionSummaries(
              db,
              config.projectId,
              parsePositiveInteger(opts.limit, "--limit"),
            );
            for (const item of items) {
              console.log(`${item.id.slice(0, 8)} | ${item.source} | ${item.text.split("\n")[0]}`);
            }
          }),
        ),
    )
    .addCommand(
      new Command("registry")
        .description("List first-class session registry records")
        .option("--agent <agent>", "Filter by agent id")
        .option("--session-id <id>", "Filter by session id")
        .option("--parent-session-id <id>", "Filter by parent session id")
        .option("--limit <number>", "Max results", "20")
        .option("--db <path>", "Custom database path")
        .action(
          withDb((db, config, opts) => {
            const sessions = listSessionRegistry(db, {
              projectId: config.projectId,
              agentId: opts.agent,
              sessionId: opts.sessionId,
              parentSessionId: opts.parentSessionId,
              limit: parsePositiveInteger(opts.limit, "--limit"),
            });
            for (const session of sessions) {
              console.log(
                `${session.agent_id}/${session.session_id} | updated=${session.updated_at}`,
              );
              if (session.parent_session_id) {
                console.log(`parent=${session.parent_session_id}`);
              }
              console.log(session.summary);
              if (session.handoff_notes) {
                console.log(`handoff=${session.handoff_notes}`);
              }
              console.log();
            }
          }),
        ),
    );
}
