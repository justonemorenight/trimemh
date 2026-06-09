import { Command } from "commander";

import { loadResolvedConfig } from "../infrastructure/config";
import { formatConfigAsJSON, generateMCPConfig } from "../mcp/config-gen";
import { startMcpServer } from "../mcp/server";
import { getDb, runMigrations } from "../persistence/db";

function redirectConsoleLogToStderr(): void {
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
}

export function registerMcpCommands(program: Command): void {
  program
    .command("mcp")
    .description("MCP server commands")
    .addCommand(
      new Command("serve")
        .description("Start MCP stdio server for agent integration")
        .option("--db <path>", "Custom database path")
        .action(async (opts) => {
          redirectConsoleLogToStderr();

          const config = loadResolvedConfig(undefined, { dbPath: opts.db });
          const db = getDb(config.dbPath);
          runMigrations(db);

          console.error(
            `[triMemh] MCP server starting (project: ${config.projectId}, db: ${config.dbPath})`,
          );
          for (const warning of config.meta.warnings) {
            console.error(`[triMemh] WARNING: ${warning}`);
          }
          await startMcpServer(db, config);
          // MCP server runs until stdin closes
        }),
    )
    .addCommand(
      new Command("config")
        .description("Generate MCP client config JSON for Claude Code, Cursor, etc.")
        .action(() => {
          const memhConfig = loadResolvedConfig();
          const generated = generateMCPConfig(memhConfig, "generic");
          console.log(formatConfigAsJSON(generated));
          console.error("\n[triMemh] Add this to your MCP client config.");
          console.error("[triMemh] Or run 'trimemh install' for automatic setup.\n");
        }),
    );
}
