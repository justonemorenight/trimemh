#!/usr/bin/env bun

import { Command } from "commander";

import { formatInitResult, initProject } from "./application/init-use-cases";
import { registerContextCommand } from "./cli/context-command";
import { registerDedupCommand } from "./cli/dedup-command";
import { registerEvalCommand } from "./cli/eval-command";
import { registerGraphCommands } from "./cli/graph-commands";
import { registerHooksCommand } from "./cli/hooks-command";
import {
  detectAgents,
  formatInstallPreview,
  installForAgent,
  printDetection,
  printInstallResults,
  printPostInstall,
} from "./cli/install-command";
import { registerLearnCommand } from "./cli/learn-command";
import { registerLifecycleCommand } from "./cli/lifecycle-command";
import { registerMcpCommands } from "./cli/mcp-commands";
import { registerMemoryCommands } from "./cli/memory-commands";
import { registerProposalCommands } from "./cli/proposal-commands";
import { registerReviewCommand } from "./cli/review-command";
import { registerSessionCommand } from "./cli/session-command";
import { withDb } from "./cli/with-db";
import { loadConfig } from "./infrastructure/config";
import { indexProject, seedProjectMemories } from "./service";

const program = new Command();

program
  .name("trimemh")
  .description("Memory Harness — local-first governance-first agent memory")
  .version("0.1.0");

// Register command groups from sub-modules
registerMemoryCommands(program);
registerProposalCommands(program);
registerDedupCommand(program);
registerGraphCommands(program);
registerContextCommand(program);
registerHooksCommand(program);
registerEvalCommand(program);
registerSessionCommand(program);
registerReviewCommand(program);
registerLifecycleCommand(program);

// ─── init ──────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize triMemh in this project")
  .option("--dry-run", "Preview project initialization without writing files")
  .option("--force", "Re-run initialization for an existing triMemh project")
  .option("--mode <mode>", "Project mode: auto, empty, existing", "auto")
  .option("--db <path>", "Custom database path")
  .option("--no-scan", "Skip code scanning")
  .option("--no-seed", "Skip baseline memory seeding")
  .option("--no-gitignore", "Do not add .trimemh/ to .gitignore")
  .action((opts) => {
    const mode = opts.mode as "auto" | "empty" | "existing";
    if (!["auto", "empty", "existing"].includes(mode)) {
      console.error("[triMemh] Invalid mode. Use: auto, empty, or existing.");
      process.exit(1);
    }

    const result = initProject({
      dbPath: opts.db,
      dryRun: opts.dryRun ?? false,
      force: opts.force ?? false,
      mode,
      scanCode: opts.scan === false ? false : undefined,
      seed: opts.seed,
      updateGitignore: opts.gitignore,
    });
    console.log(formatInitResult(result));
  });

// ─── install ───────────────────────────────────────────────────────

program
  .command("install")
  .description("Auto-detect AI agents and install MCP config")
  .option(
    "-t, --target <agent>",
    "Install for specific agent (claude-code, codex, cursor, continue, windsurf, copilot-cli, aider, generic)",
  )
  .option("--all", "Install for all detected agents")
  .option("--with-hooks", "Also install lifecycle hook capture for claude-code/codex")
  .option("--dry-run", "Show what would be installed without making changes")
  // biome-ignore lint/suspicious/useAwait: warning suppression
  .action(async (opts) => {
    const memhConfig = loadConfig();
    const detected = detectAgents();

    if (opts.dryRun) {
      console.log("\n🧪 Dry run — no files will be modified.\n");
      printDetection(detected);
      const selected = opts.target
        ? detected.filter((d) => d.agent.id === opts.target.toLowerCase())
        : detected;
      if (opts.target && selected.length === 0) {
        console.error(
          `\nUnknown agent "${opts.target}". Known: claude-code, codex, cursor, continue, windsurf, copilot-cli, aider, generic\n`,
        );
        process.exit(1);
      }
      for (const d of selected) {
        if (d.installed || d.agent.id === "generic" || opts.target) {
          console.log(`  ${d.agent.icon} ${d.agent.name}:`);
          console.log(`    → ${d.configPath}`);
          console.log(
            formatInstallPreview(memhConfig, d, { withHooks: opts.withHooks })
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
      const targetId = opts.target.toLowerCase();
      const found = detected.find((d) => d.agent.id === targetId);
      if (!found) {
        console.error(
          `\nUnknown agent "${opts.target}". Known: claude-code, codex, cursor, continue, windsurf, copilot-cli, aider, generic\n`,
        );
        process.exit(1);
      }
      if (!found.installed && found.agent.id !== "generic") {
        console.error(`\n${found.agent.name} not detected on this system.\n`);
        console.error(`Config file would be at: ${found.configPath}`);
        console.error(
          "Run with --dry-run to preview, or install anyway by creating the config manually.\n",
        );
        process.exit(1);
      }
      const result = installForAgent(memhConfig, found, { withHooks: opts.withHooks });
      printInstallResults([result]);
      if (result.success) {
        printPostInstall([found.agent]);
      }
    } else if (opts.all) {
      const toInstall = detected.filter((d) => d.installed);
      if (toInstall.length === 0) {
        console.log("\nNo AI agents detected on this system.\n");
        console.log(
          "Supported agents: Claude Code, Cursor IDE, OpenAI Codex, GitHub Copilot, Aider\n",
        );
        return;
      }
      const results = toInstall.map((d) =>
        installForAgent(memhConfig, d, { withHooks: opts.withHooks && d.agent.supportsHooks }),
      );
      printInstallResults(results);
      const succeeded = results.filter((r) => r.success).map((r) => r.agent);
      if (succeeded.length > 0) {
        printPostInstall(succeeded);
      }
    } else {
      printDetection(detected);
      const installed = detected.filter((d) => d.installed);

      if (installed.length === 0) {
        console.log("\n  No AI agents detected on this system.\n");
        console.log("  Supported: Claude Code, Cursor IDE, OpenAI Codex, GitHub Copilot, Aider");
        console.log("  Install one of these agents first, then run 'trimemh install' again.\n");
        console.log("  Or use --dry-run to preview the config for manual setup.\n");
        return;
      }

      if (installed.length === 1) {
        const agent = installed[0];
        if (!agent) {
          return;
        }
        console.log(`\n  Auto-installing for ${agent.agent.icon} ${agent.agent.name}...\n`);
        const result = installForAgent(memhConfig, agent, { withHooks: opts.withHooks });
        printInstallResults([result]);
        if (result.success) {
          printPostInstall([agent.agent]);
        }
      } else {
        console.log("\n  Multiple agents detected. Choose one or run with --all:\n");
        for (let i = 0; i < installed.length; i++) {
          const d = installed[i];
          if (!d) {
            continue;
          }
          console.log(`  ${i + 1}. ${d.agent.icon} ${d.agent.name} → ${d.configPath}`);
        }
        console.log("  a. All of the above");
        console.log(
          "\n  Run: trimemh install --target <name>  (e.g., trimemh install --target claude-code)",
        );
        console.log("  Run: trimemh install --all              (install for all detected)\n");
      }
    }
  });

// ─── MCP commands ──────────────────────────────────────────────────

registerMcpCommands(program);

// ─── Learn ─────────────────────────────────────────────────────────

registerLearnCommand(program);

// ─── Scan ──────────────────────────────────────────────────────────

program
  .command("scan")
  .description("Scan project codebase and index code entities into the memory graph")
  .option("--path <path>", "Scan a specific subdirectory")
  .option("--max-files <number>", "Max files to scan", "200")
  .option("--dry-run", "Parse and report without persisting")
  .option("--seed", "Also create project overview seed memories")
  .option("--db <path>", "Custom database path")
  .action(
    withDb((db, config, opts) => {
      const maxFiles = parseInt(opts.maxFiles, 10);

      console.log(`[triMemh] Scanning ${opts.path ?? "project root"} (max ${maxFiles} files)...`);
      const result = indexProject(db, config.projectId, {
        rootDir: process.cwd(),
        subPath: opts.path,
        maxFiles,
        dryRun: opts.dryRun ?? false,
      });

      console.log(`[triMemh] ${result.summary}`);

      if (result.topLevelDirs.length > 0) {
        console.log(`[triMemh] Directories: ${result.topLevelDirs.join(", ")}`);
      }

      if (opts.seed && result.filesScanned > 0 && !opts.dryRun) {
        const seeds = seedProjectMemories(db, config.projectId, result);
        console.log(`[triMemh] Created ${seeds.length} seed memories.`);
      }

      if (opts.dryRun) {
        console.log("[triMemh] Dry run — no changes persisted.");
      }
    }),
  );

// ─── Parse ─────────────────────────────────────────────────────────

program.parse();
