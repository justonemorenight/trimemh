import type { Database } from "bun:sqlite";
import {
  type Stats,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import type { MemoryKind, TriMemhConfig } from "../domain/schema";
import { resolveProjectId } from "../infrastructure/config";
import { closeDb, getDb, runMigrations } from "../persistence/db";
import { listAll, remember } from "../service/memory-service";
import { indexProject } from "./index-use-cases";

export type InitMode = "empty" | "existing" | "already_initialized";

export interface InitOptions {
  cwd?: string;
  dbPath?: string;
  dryRun?: boolean;
  force?: boolean;
  mode?: "auto" | "empty" | "existing";
  scanCode?: boolean;
  seed?: boolean;
  updateGitignore?: boolean;
}

export interface ProjectDetection {
  cwd: string;
  mode: InitMode;
  hasGit: boolean;
  hasConfig: boolean;
  hasDb: boolean;
  sourceFileCount: number;
  manifestFiles: string[];
  stack: string[];
  commands: string[];
}

export interface InitAction {
  label: string;
  status: "planned" | "done" | "skipped";
  detail?: string;
}

export interface InitResult {
  config: TriMemhConfig;
  detection: ProjectDetection;
  actions: InitAction[];
  createdConfig: boolean;
  createdGitignoreEntry: boolean;
  migrationsRun: boolean;
  seededMemories: number;
  skippedSeedMemories: number;
  scannedFiles: number;
  indexedEntities: number;
  dryRun: boolean;
}

const CONFIG_FILE_NAME = ".memh.toml";
const TRIMEMH_DIR = ".trimemh";
const DB_FILE = "memory.db";
const IGNORE_DIRS = new Set([
  ".git",
  ".trimemh",
  ".memh",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
  "__pycache__",
]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".sh",
  ".md",
]);
const MAX_SCAN_FILES = 500;
const MAX_SCAN_BYTES = 1_000_000;
const LINE_SPLIT_PATTERN = /\r?\n/;

function defaultDbPath(cwd: string): string {
  return join(cwd, TRIMEMH_DIR, DB_FILE);
}

function configPath(cwd: string): string {
  return join(cwd, CONFIG_FILE_NAME);
}

function extension(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx) : "";
}

function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function detectStack(cwd: string): {
  manifestFiles: string[];
  stack: string[];
  commands: string[];
} {
  const manifestFiles: string[] = [];
  const stack = new Set<string>();
  const commands = new Set<string>();

  const packageJsonPath = join(cwd, "package.json");
  if (existsSync(packageJsonPath)) {
    manifestFiles.push("package.json");
    stack.add("javascript/typescript");
    const pkg = safeReadJson(packageJsonPath);
    const deps = {
      ...((pkg?.dependencies as Record<string, unknown> | undefined) ?? {}),
      ...((pkg?.devDependencies as Record<string, unknown> | undefined) ?? {}),
    };
    if ("typescript" in deps) {
      stack.add("typescript");
    }
    if ("react" in deps || "next" in deps) {
      stack.add("react");
    }
    if ("hono" in deps) {
      stack.add("hono");
    }
    const scripts = pkg?.scripts as Record<string, unknown> | undefined;
    for (const name of ["test", "build", "lint", "dev"]) {
      if (typeof scripts?.[name] === "string") {
        commands.add(`npm run ${name}`);
      }
    }
  }

  for (const [file, label] of [
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
  ] as const) {
    if (existsSync(join(cwd, file))) {
      manifestFiles.push(file);
      stack.add(label);
    }
  }

  return {
    manifestFiles,
    stack: [...stack].sort(),
    commands: [...commands].sort(),
  };
}

function walkSourceFiles(cwd: string, maxFiles = MAX_SCAN_FILES): string[] {
  const root = resolve(cwd);
  const files: string[] = [];
  const visit = (dir: string) => {
    if (files.length >= maxFiles) {
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      if (IGNORE_DIRS.has(entry)) {
        continue;
      }
      const full = join(dir, entry);
      let stat: Stats;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) {
        continue;
      }
      if (SOURCE_EXTENSIONS.has(extension(entry))) {
        files.push(relative(root, full));
      }
    }
  };
  visit(root);
  return files.sort();
}

export function detectProject(
  cwd = process.cwd(),
  forcedMode: InitOptions["mode"] = "auto",
): ProjectDetection {
  const root = resolve(cwd);
  const hasConfig = existsSync(configPath(root));
  const dbPath = defaultDbPath(root);
  const hasDb = existsSync(dbPath);
  const hasGit = existsSync(join(root, ".git"));
  const sourceFiles = walkSourceFiles(root, 1_000);
  const { manifestFiles, stack, commands } = detectStack(root);

  let mode: InitMode;
  if (hasConfig || hasDb) {
    mode = "already_initialized";
  } else if (forcedMode === "empty") {
    mode = "empty";
  } else if (forcedMode === "existing") {
    mode = "existing";
  } else {
    mode = sourceFiles.length > 0 || manifestFiles.length > 0 ? "existing" : "empty";
  }

  return {
    cwd: root,
    mode,
    hasGit,
    hasConfig,
    hasDb,
    sourceFileCount: sourceFiles.length,
    manifestFiles,
    stack,
    commands,
  };
}

function writeConfigFile(cwd: string, config: TriMemhConfig, mode: InitMode): void {
  const content = [
    "# triMemh project config",
    `project_id = "${config.projectId}"`,
    `db_path = "${relative(cwd, config.dbPath) || config.dbPath}"`,
    `init_mode = "${mode}"`,
    `created_at = "${new Date().toISOString()}"`,
    "",
  ].join("\n");
  writeFileSync(configPath(cwd), content);
}

function ensureGitignore(cwd: string): boolean {
  const gitignorePath = join(cwd, ".gitignore");
  const entry = ".trimemh/";
  if (existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, "utf-8");
    if (current.split(LINE_SPLIT_PATTERN).some((line) => line.trim() === entry)) {
      return false;
    }
    appendFileSync(gitignorePath, `${current.endsWith("\n") ? "" : "\n"}${entry}\n`);
    return true;
  }
  writeFileSync(gitignorePath, `${entry}\n`);
  return true;
}

function seedTexts(detection: ProjectDetection, scannedFiles: number, indexedEntities: number) {
  const stack = detection.stack.length > 0 ? detection.stack.join(", ") : "unknown";
  if (detection.mode === "empty") {
    return [
      {
        kind: "fact" as MemoryKind,
        text: "triMemh initialized this empty project; no source files or architecture decisions were detected yet.",
      },
      {
        kind: "decision" as MemoryKind,
        text: "triMemh bootstrap mode is empty; capture durable architecture decisions as the project evolves.",
      },
    ];
  }

  return [
    {
      kind: "fact" as MemoryKind,
      text: `triMemh attached to an existing project. Detected stack: ${stack}.`,
    },
    {
      kind: "code_context" as MemoryKind,
      text: `Initial code index scanned ${scannedFiles} file(s) and extracted ${indexedEntities} code entity record(s).`,
    },
  ];
}

function seedBaselineMemories(
  db: Database,
  projectId: string,
  detection: ProjectDetection,
  scannedFiles: number,
  indexedEntities: number,
): { seeded: number; skipped: number } {
  const existing = new Set(listAll(db, projectId).map((item) => item.text));
  let seeded = 0;
  let skipped = 0;

  for (const seed of seedTexts(detection, scannedFiles, indexedEntities)) {
    if (existing.has(seed.text)) {
      skipped++;
      continue;
    }
    remember(db, {
      kind: seed.kind,
      text: seed.text,
      projectId,
      source: "cli:init",
      confidence: 0.65,
      metadata: {
        init_mode: detection.mode,
        source: "trimemh_init",
      },
    });
    seeded++;
  }

  return { seeded, skipped };
}

function scanCode(
  db: Database,
  config: TriMemhConfig,
  cwd: string,
): { files: number; entities: number } {
  const result = indexProject(db, config.projectId, {
    rootDir: cwd,
    maxFiles: MAX_SCAN_FILES,
  });
  return { files: result.filesScanned, entities: result.entitiesCreated };
}

function action(
  actions: InitAction[],
  label: string,
  status: InitAction["status"],
  detail?: string,
) {
  actions.push({ label, status, detail });
}

export function initProject(options: InitOptions = {}): InitResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const modeOption = options.mode ?? "auto";
  const detection = detectProject(cwd, modeOption);
  const dbPath = options.dbPath ? resolve(cwd, options.dbPath) : defaultDbPath(cwd);
  const config: TriMemhConfig = {
    projectId: resolveProjectId(cwd),
    dbPath,
  };
  const dryRun = options.dryRun ?? false;
  const seed = options.seed ?? true;
  const effectiveSeed =
    seed && (detection.mode !== "already_initialized" || options.force === true);
  const updateGitignore = options.updateGitignore ?? true;
  const shouldScan =
    options.scanCode ??
    (detection.mode === "existing" ||
      (detection.mode === "already_initialized" && options.force === true));
  const actions: InitAction[] = [];

  const createdConfig = !detection.hasConfig;
  const shouldWriteGitignore =
    updateGitignore && (detection.hasGit || existsSync(join(cwd, ".gitignore")));

  action(
    actions,
    "detect_project",
    dryRun ? "planned" : "done",
    `${detection.mode}; ${detection.sourceFileCount} source file(s); stack=${detection.stack.join(", ") || "unknown"}`,
  );
  action(
    actions,
    "write_config",
    createdConfig ? (dryRun ? "planned" : "done") : "skipped",
    configPath(cwd),
  );
  action(actions, "run_migrations", dryRun ? "planned" : "done", dbPath);
  if (shouldWriteGitignore) {
    action(actions, "update_gitignore", dryRun ? "planned" : "done", ".trimemh/");
  } else {
    action(actions, "update_gitignore", "skipped", "not a git project or already handled");
  }
  action(
    actions,
    "scan_code",
    shouldScan ? (dryRun ? "planned" : "done") : "skipped",
    shouldScan
      ? `up to ${MAX_SCAN_FILES} source files`
      : detection.mode === "already_initialized" && !options.force
        ? "already initialized"
        : "empty project mode",
  );
  action(
    actions,
    "seed_memories",
    effectiveSeed ? (dryRun ? "planned" : "done") : "skipped",
    detection.mode === "already_initialized" && !options.force ? "already initialized" : undefined,
  );

  if (dryRun) {
    return {
      config,
      detection,
      actions,
      createdConfig,
      createdGitignoreEntry: shouldWriteGitignore,
      migrationsRun: false,
      seededMemories: effectiveSeed ? seedTexts(detection, 0, 0).length : 0,
      skippedSeedMemories: 0,
      scannedFiles: shouldScan ? Math.min(detection.sourceFileCount, MAX_SCAN_FILES) : 0,
      indexedEntities: 0,
      dryRun,
    };
  }

  if (createdConfig || options.force) {
    writeConfigFile(cwd, config, detection.mode);
  }
  mkdirSync(join(cwd, TRIMEMH_DIR), { recursive: true });

  let createdGitignoreEntry = false;
  if (shouldWriteGitignore) {
    createdGitignoreEntry = ensureGitignore(cwd);
  }

  const db = getDb(dbPath);
  runMigrations(db);

  const scanned = shouldScan ? scanCode(db, config, cwd) : { files: 0, entities: 0 };
  const seeded = effectiveSeed
    ? seedBaselineMemories(db, config.projectId, detection, scanned.files, scanned.entities)
    : { seeded: 0, skipped: 0 };
  closeDb();

  return {
    config,
    detection,
    actions,
    createdConfig,
    createdGitignoreEntry,
    migrationsRun: true,
    seededMemories: seeded.seeded,
    skippedSeedMemories: seeded.skipped,
    scannedFiles: scanned.files,
    indexedEntities: scanned.entities,
    dryRun,
  };
}

export function formatInitResult(result: InitResult): string {
  const lines = [
    result.dryRun ? "[triMemh] Init dry run" : "[triMemh] Init complete",
    `  project: ${basename(result.detection.cwd)} (${result.config.projectId})`,
    `  mode: ${result.detection.mode}`,
    `  db: ${result.config.dbPath}`,
    `  stack: ${result.detection.stack.join(", ") || "unknown"}`,
    `  code index: ${result.scannedFiles} file(s), ${result.indexedEntities} entity record(s)`,
    `  seeded memories: ${result.seededMemories} new, ${result.skippedSeedMemories} skipped`,
    "",
    "  actions:",
    ...result.actions.map((entry) => {
      const marker = entry.status === "done" ? "ok" : entry.status === "planned" ? "plan" : "skip";
      return `    - ${marker} ${entry.label}${entry.detail ? `: ${entry.detail}` : ""}`;
    }),
    "",
    "  next:",
    "    trimemh install",
    "    trimemh mcp serve",
    "    trimemh scan --seed",
  ];
  return lines.join("\n");
}
