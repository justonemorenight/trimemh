import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  findConfigRoot,
  loadConfig,
  loadResolvedConfig,
  resolveProjectId,
} from "../src/infrastructure/config";
import { closeDb, getDb, runMigrations } from "../src/persistence/db";
import { formatProjectMismatchWarnings, mcpStats } from "../src/service/mcp-service";
import { remember } from "../src/service/memory-service";

const ROOT = "/tmp/trimemh-config-tests";
let counter = 0;
const originalProjectId = process.env.TRIMEMH_PROJECT_ID;
const originalDbPath = process.env.TRIMEMH_DB_PATH;

function fixture(name: string): string {
  const dir = join(ROOT, `${name}-${counter++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeProjectConfig(dir: string, opts: { projectId?: string; dbPath?: string } = {}): void {
  const lines = [
    opts.projectId ? `project_id = "${opts.projectId}"` : null,
    opts.dbPath ? `db_path = "${opts.dbPath}"` : null,
  ].filter(Boolean);
  writeFileSync(join(dir, ".memh.toml"), `${lines.join("\n")}\n`);
}

afterEach(() => {
  if (originalProjectId === undefined) {
    delete process.env.TRIMEMH_PROJECT_ID;
  } else {
    process.env.TRIMEMH_PROJECT_ID = originalProjectId;
  }
  if (originalDbPath === undefined) {
    delete process.env.TRIMEMH_DB_PATH;
  } else {
    process.env.TRIMEMH_DB_PATH = originalDbPath;
  }
  closeDb();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("reads project_id and db_path from .memh.toml", () => {
    const project = fixture("toml");
    writeProjectConfig(project, {
      projectId: "abc12345",
      dbPath: ".trimemh/memory.db",
    });

    const config = loadConfig(project);
    expect(config.projectId).toBe("abc12345");
    expect(config.dbPath).toBe(join(project, ".trimemh", "memory.db"));
  });

  it("walks up parent directories to find .memh.toml", () => {
    const project = fixture("walk-up");
    writeProjectConfig(project, { projectId: "walk-proj" });
    const nested = join(project, "src", "components");
    mkdirSync(nested, { recursive: true });

    const config = loadConfig(nested);
    expect(config.projectId).toBe("walk-proj");
    expect(findConfigRoot(nested)).toBe(project);
  });

  it("warns when cwd differs from discovered config root", () => {
    const project = fixture("warn");
    writeProjectConfig(project, { projectId: "warn-proj" });
    const nested = join(project, "apps", "web");
    mkdirSync(nested, { recursive: true });

    const resolved = loadResolvedConfig(nested);
    expect(resolved.projectId).toBe("warn-proj");
    expect(resolved.meta.warnings.some((w) => w.includes("found one at"))).toBe(true);
  });

  it("honors TRIMEMH_PROJECT_ID and TRIMEMH_DB_PATH env overrides", () => {
    const cwd = fixture("env");
    writeProjectConfig(cwd, { projectId: "from-toml" });

    process.env.TRIMEMH_PROJECT_ID = "env-project";
    process.env.TRIMEMH_DB_PATH = join(cwd, "pinned.db");

    const resolved = loadResolvedConfig(cwd);
    expect(resolved.projectId).toBe("env-project");
    expect(resolved.dbPath).toBe(join(cwd, "pinned.db"));
    expect(resolved.meta.projectIdSource).toBe("env");
    expect(resolved.meta.dbPathSource).toBe("env");
  });

  it("derives project_id from db path when db is pinned without env project id", () => {
    const project = fixture("db-pin");
    writeProjectConfig(project, { projectId: "db-derived" });
    const dbPath = join(project, ".trimemh", "memory.db");
    mkdirSync(join(project, ".trimemh"), { recursive: true });

    const wrongCwd = join(project, "wrong-cwd");
    mkdirSync(wrongCwd, { recursive: true });

    const resolved = loadResolvedConfig(wrongCwd, { dbPath });
    expect(resolved.projectId).toBe("db-derived");
    expect(resolved.dbPath).toBe(dbPath);
  });

  it("falls back to cwd hash when no config exists", () => {
    const cwd = fixture("hash");
    expect(resolveProjectId(cwd)).toBe(loadConfig(cwd).projectId);
    expect(loadResolvedConfig(cwd).meta.projectIdSource).toBe("hash-fallback");
  });

  it("reports project mismatch when db has memories for another project_id", () => {
    const dir = fixture("mismatch");
    const dbPath = join(dir, "memory.db");
    const db = getDb(dbPath);
    runMigrations(db);

    remember(db, {
      kind: "fact",
      text: "stored under real-project",
      projectId: "real-project",
      source: "cli:user:explicit",
    });

    const stats = mcpStats(db, "wrong-project");
    const warnings = formatProjectMismatchWarnings(db, "wrong-project", stats);

    expect(stats.total).toBe(0);
    expect(warnings.some((line) => line.includes("real-project"))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });
});
