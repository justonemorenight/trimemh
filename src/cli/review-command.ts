import { readFileSync } from "node:fs";

import { Command } from "commander";

import {
  type ClaudeReviewRequest,
  buildClaudeReviewCommand,
  runClaudeReview,
} from "../service/claude-review-service";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatCommand(command: string[]): string {
  return command
    .map((part) => (part === "" || part.includes(" ") ? shellQuote(part) : part))
    .join(" ");
}

function readInput(opts: { input?: string; text?: string }): string {
  if (opts.text) {
    return opts.text;
  }
  if (opts.input) {
    return readFileSync(opts.input, "utf-8");
  }
  return "";
}

function currentPatch(): string {
  const result = Bun.spawnSync(["git", "diff"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr?.toString().trim() || "unknown error";
    throw new Error(`Unable to read current patch with "git diff": ${detail}`);
  }
  return result.stdout?.toString() ?? "";
}

function handleReview(
  request: ClaudeReviewRequest,
  opts: { withClaude?: boolean; dryRun?: boolean },
) {
  const command = buildClaudeReviewCommand(request);
  if (opts.dryRun || !opts.withClaude) {
    console.log(formatCommand(command));
    return;
  }

  const review = runClaudeReview(request);
  console.log(JSON.stringify(review, null, 2));
}

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Read-only Claude architecture review workflows")
    .addCommand(
      new Command("plan")
        .description("Review a plan with Claude as a read-only critic")
        .option("--input <path>", "Plan file")
        .option("--text <text>", "Plan text")
        .option("--with-claude", "Execute Claude review")
        .option("--dry-run", "Print the Claude command without executing it")
        .action((opts) => {
          handleReview(
            {
              kind: "plan",
              content: readInput(opts),
            },
            opts,
          );
        }),
    )
    .addCommand(
      new Command("patch")
        .description("Review the current git diff with Claude as a read-only critic")
        .option("--with-claude", "Execute Claude review")
        .option("--dry-run", "Print the Claude command without executing it")
        .action((opts) => {
          handleReview(
            {
              kind: "patch",
              content: currentPatch(),
            },
            opts,
          );
        }),
    );
}
