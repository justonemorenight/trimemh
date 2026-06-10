import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { TriMemhConfig } from "../domain/schema";

const CONFIG_FILE_NAME = ".memh.toml";
const TRIMEMH_DIR = ".trimemh";
const DB_FILE = "memory.db";

export type ConfigValueSource = "env" | "memh-toml" | "hash-fallback";

export interface ConfigResolutionMeta {
  cwd: string;
  configRoot: string;
  projectIdSource: ConfigValueSource;
  dbPathSource: ConfigValueSource;
  warnings: string[];
}

export interface ResolvedTriMemhConfig extends TriMemhConfig {
  meta: ConfigResolutionMeta;
}

export interface LoadConfigOptions {
  /** Override database path (e.g. MCP `--db` flag). */
  dbPath?: string;
}

// ─── Resolve project id from CWD or config file ──────────────────

function hashString(s: string): string {
  // Simple djb2 hash — stable across sessions, no crypto needed
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function readTomlValue(content: string, key: string): string | null {
  const match = content.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
  return match?.[1] ?? null;
}

function readConfigFile(configRoot: string): { projectId: string | null; dbPath: string | null } {
  const configPath = join(configRoot, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return { projectId: null, dbPath: null };
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    return {
      projectId: readTomlValue(content, "project_id"),
      dbPath: readTomlValue(content, "db_path"),
    };
  } catch {
    return { projectId: null, dbPath: null };
  }
}

/** Walk up from startDir to filesystem root to find a directory containing .memh.toml. */
export function findConfigRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE_NAME))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function resolveProjectId(cwd: string): string {
  const configRoot = findConfigRoot(cwd) ?? resolve(cwd);
  const fromFile = readConfigFile(configRoot).projectId;
  if (fromFile) {
    return fromFile;
  }
  return hashString(resolve(cwd));
}

// ─── Resolve database path ────────────────────────────────────────

export function resolveDbPath(cwd: string, explicitPath?: string): string {
  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
  }

  const configRoot = findConfigRoot(cwd) ?? resolve(cwd);
  const configured = readConfigFile(configRoot).dbPath;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(configRoot, configured);
  }

  // Default: .trimemh/memory.db under config root
  const memhDir = join(configRoot, TRIMEMH_DIR);
  if (!existsSync(memhDir)) {
    mkdirSync(memhDir, { recursive: true });
  }
  return join(memhDir, DB_FILE);
}

function resolveProjectIdWithSource(
  workDir: string,
  configRoot: string,
): { value: string; source: ConfigValueSource } {
  if (process.env.TRIMEMH_PROJECT_ID) {
    return { value: process.env.TRIMEMH_PROJECT_ID, source: "env" };
  }

  const fromFile = readConfigFile(configRoot).projectId;
  if (fromFile) {
    return { value: fromFile, source: "memh-toml" };
  }

  return { value: hashString(workDir), source: "hash-fallback" };
}

function resolveDbPathWithSource(
  workDir: string,
  configRoot: string,
  explicitPath?: string,
): { value: string; source: ConfigValueSource } {
  if (process.env.TRIMEMH_DB_PATH) {
    const envPath = process.env.TRIMEMH_DB_PATH;
    return {
      value: isAbsolute(envPath) ? envPath : resolve(workDir, envPath),
      source: "env",
    };
  }

  if (explicitPath) {
    return {
      value: isAbsolute(explicitPath) ? explicitPath : resolve(workDir, explicitPath),
      source: "env",
    };
  }

  const configured = readConfigFile(configRoot).dbPath;
  if (configured) {
    return {
      value: isAbsolute(configured) ? configured : resolve(configRoot, configured),
      source: "memh-toml",
    };
  }

  return { value: resolveDbPath(configRoot), source: "hash-fallback" };
}

// ─── Load full config ─────────────────────────────────────────────

export function loadResolvedConfig(
  cwd?: string,
  options?: LoadConfigOptions,
): ResolvedTriMemhConfig {
  const workDir = resolve(cwd ?? process.cwd());
  const warnings: string[] = [];

  const configRootFromCwd = findConfigRoot(workDir);
  let configRoot = configRootFromCwd ?? workDir;

  if (configRootFromCwd && configRootFromCwd !== workDir) {
    warnings.push(`cwd has no .memh.toml but found one at ${configRootFromCwd}`);
  }

  // When db path is pinned, also walk up from the db directory for project config.
  const dbHint = options?.dbPath ?? process.env.TRIMEMH_DB_PATH;
  if (dbHint && !process.env.TRIMEMH_PROJECT_ID) {
    const dbDir = dirname(isAbsolute(dbHint) ? dbHint : resolve(workDir, dbHint));
    const configRootFromDb = findConfigRoot(dbDir);
    if (configRootFromDb) {
      configRoot = configRootFromDb;
      if (configRootFromDb !== workDir && !configRootFromCwd) {
        warnings.push(`resolved project config from db path at ${configRootFromDb}`);
      }
    }
  }

  const project = resolveProjectIdWithSource(workDir, configRoot);
  const db = resolveDbPathWithSource(workDir, configRoot, options?.dbPath);

  return {
    projectId: project.value,
    dbPath: db.value,
    meta: {
      cwd: workDir,
      configRoot,
      projectIdSource: project.source,
      dbPathSource: db.source,
      warnings,
    },
  };
}

export function loadConfig(cwd?: string, options?: LoadConfigOptions): TriMemhConfig {
  const resolved = loadResolvedConfig(cwd, options);
  return {
    projectId: resolved.projectId,
    dbPath: resolved.dbPath,
  };
}

export function formatConfigSourceLabel(meta: ConfigResolutionMeta): string {
  return `project_id=${meta.projectIdSource}, db_path=${meta.dbPathSource}`;
}

export function formatConfigDebugLines(resolved: ResolvedTriMemhConfig): string[] {
  const lines = [
    `Project: ${resolved.projectId}`,
    `DB: ${resolved.dbPath}`,
    `CWD: ${resolved.meta.cwd}`,
    `Config source: ${formatConfigSourceLabel(resolved.meta)}`,
  ];
  for (const warning of resolved.meta.warnings) {
    lines.push(`⚠️ Warning: ${warning}`);
  }
  return lines;
}

// ─── Global data directory (for non-project-scoped operations) ───

export function globalDataDir(): string {
  const dir = join(homedir(), ".trimemh");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
