import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectProject, initProject } from "../src/application/init-use-cases";
import { loadConfig } from "../src/infrastructure/config";
import { closeDb, getDb } from "../src/persistence/db";
import { listAll } from "../src/service";

const ROOT = "/tmp/trimemh-init-tests";
let counter = 0;

function fixture(name: string): string {
  const dir = join(ROOT, `${name}-${counter++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  closeDb();
  rmSync(ROOT, { recursive: true, force: true });
});

describe("project init", () => {
  it("dry-runs without creating project files", () => {
    const cwd = fixture("dry");
    const result = initProject({ cwd, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.detection.mode).toBe("empty");
    expect(result.actions.some((entry) => entry.status === "planned")).toBe(true);
    expect(existsSync(join(cwd, ".memh.toml"))).toBe(false);
    expect(existsSync(join(cwd, ".trimemh"))).toBe(false);
  });

  it("initializes an empty project with config, db, gitignore, and baseline memories", () => {
    const cwd = fixture("empty");
    mkdirSync(join(cwd, ".git"));

    const result = initProject({ cwd });

    expect(result.detection.mode).toBe("empty");
    expect(result.createdConfig).toBe(true);
    expect(result.migrationsRun).toBe(true);
    expect(result.scannedFiles).toBe(0);
    expect(result.seededMemories).toBe(2);
    expect(readFileSync(join(cwd, ".memh.toml"), "utf-8")).toContain("project_id");
    expect(readFileSync(join(cwd, ".gitignore"), "utf-8")).toContain(".trimemh/");

    const db = getDb(result.config.dbPath);
    const items = listAll(db, result.config.projectId);
    expect(items.length).toBe(2);
  });

  it("attaches to an existing project and indexes code", () => {
    const cwd = fixture("existing");
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { test: "bun test" },
        devDependencies: { typescript: "^5" },
      }),
    );
    mkdirSync(join(cwd, "src"));
    writeFileSync(
      join(cwd, "src", "service.ts"),
      "export function loadConfig() { return { ok: true }; }\nexport class Runner {}\n",
    );

    const result = initProject({ cwd });

    expect(result.detection.mode).toBe("existing");
    expect(result.detection.stack).toContain("typescript");
    expect(result.scannedFiles).toBe(1);
    expect(result.indexedEntities).toBeGreaterThanOrEqual(2);
    expect(result.seededMemories).toBe(2);
  });

  it("is idempotent across repeated init runs", () => {
    const cwd = fixture("idempotent");
    writeFileSync(join(cwd, "index.ts"), "export function main() { return 1; }\n");

    const first = initProject({ cwd });
    const second = initProject({ cwd });
    const db = getDb(second.config.dbPath);
    const items = listAll(db, second.config.projectId);

    expect(first.seededMemories).toBe(2);
    expect(second.detection.mode).toBe("already_initialized");
    expect(second.seededMemories).toBe(0);
    expect(second.skippedSeedMemories).toBe(0);
    expect(items.length).toBe(2);
  });

  it("reads db_path from .memh.toml after init", () => {
    const cwd = fixture("custom-db");
    const result = initProject({ cwd, dbPath: "data/custom.db" });
    const loaded = loadConfig(cwd);

    expect(result.config.dbPath).toBe(join(cwd, "data/custom.db"));
    expect(loaded.dbPath).toBe(join(cwd, "data/custom.db"));
  });

  it("detects forced modes", () => {
    const cwd = fixture("forced");
    writeFileSync(join(cwd, "index.ts"), "export const x = 1;\n");

    expect(detectProject(cwd, "empty").mode).toBe("empty");
    expect(detectProject(cwd, "existing").mode).toBe("existing");
  });
});
