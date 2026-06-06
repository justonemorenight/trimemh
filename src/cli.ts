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
import { registerContextCommand } from "./cli/context-command";
import { registerDedupCommand } from "./cli/dedup-command";
import { registerGraphCommands } from "./cli/graph-commands";
import { registerMcpCommands } from "./cli/mcp-commands";
import { registerMemoryCommands } from "./cli/memory-commands";
import { registerProposalCommands } from "./cli/proposal-commands";
import { loadConfig } from "./infrastructure/config";
import { formatConfigAsJSON, generateMCPConfig } from "./mcp/config-gen";

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
          "Run with --dry-run to preview, or install anyway by creating the config manually.\n",
        );
        process.exit(1);
      }
      const result = installForAgent(memhConfig, found);
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
      const results = toInstall.map((d) => installForAgent(memhConfig, d));
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
        console.log("  Install one of these agents first, then run 'tritrimemh install' again.\n");
        console.log("  Or use --dry-run to preview the config for manual setup.\n");
        return;
      }

      if (installed.length === 1) {
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
          "\n  Run: trimemh install --target <name>  (e.g., trimemh install --target claude)",
        );
        console.log("  Run: trimemh install --all              (install for all detected)\n");
      }
    }
  });

// ─── MCP commands ──────────────────────────────────────────────────

registerMcpCommands(program);

// ─── Learn ─────────────────────────────────────────────────────────

registerLearnCommand(program);

// ─── Parse ─────────────────────────────────────────────────────────

program.parse();
