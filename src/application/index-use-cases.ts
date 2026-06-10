import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { parseFile } from "../code-intel/code-parser";
import { CONFIG } from "../config";
import { getLogger } from "../infrastructure/logging";
import { findCodeEntityByKey } from "../persistence/repository";
import { createOrGetCodeEntity } from "../service/graph-service";
import { codeEntityKey } from "../service/helpers";

// ─── Types ──────────────────────────────────────────────────────────

export interface IndexResult {
  filesScanned: number;
  filesSkipped: number;
  entitiesCreated: number;
  entitiesAlreadyKnown: number;
  languages: Record<string, number>;
  /** Top-level directory names detected (src, lib, test, etc.). */
  topLevelDirs: string[];
  /** Human-readable one-line summary. */
  summary: string;
}

export interface IndexOptions {
  /** Project root directory (default: cwd). */
  rootDir?: string;
  /** Max files to scan (default: 200). */
  maxFiles?: number;
  /** Specific subdirectory to scan (relative to rootDir). */
  subPath?: string;
  /** Dry run — parse but don't persist. */
  dryRun?: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_MAX_FILES = 200;

/** Extensions the code parser can handle. */
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyx",
  ".go",
  ".rs",
]);

/** Directory names to skip during scan. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".trimemh",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".turbo",
  "coverage",
  ".nyc_output",
]);

// ─── Directory walker ───────────────────────────────────────────────

interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

/**
 * Walk the project directory and discover source files to scan.
 * Skips ignored directories and non-code files.
 */
function discoverFiles(rootDir: string, subPath?: string, maxFiles?: number): DiscoveredFile[] {
  const scanRoot = subPath ? join(rootDir, subPath) : rootDir;
  if (!existsSync(scanRoot)) {
    return [];
  }

  const files: DiscoveredFile[] = [];
  const max = maxFiles ?? DEFAULT_MAX_FILES;

  try {
    const entries = readdirSync(scanRoot, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= max) {
        break;
      }

      if (!entry.isFile()) {
        continue;
      }

      // Check if any parent directory should be skipped
      const entryPath = join(entry.parentPath ?? scanRoot, entry.name);
      const relPath = relative(rootDir, entryPath);
      const parts = relPath.split("/");

      let shouldSkip = false;
      for (const part of parts.slice(0, -1)) {
        if (SKIP_DIRS.has(part) || part.startsWith(".")) {
          shouldSkip = true;
          break;
        }
      }
      if (shouldSkip) {
        continue;
      }

      // Extension filter
      const ext = extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        continue;
      }

      // Size filter
      try {
        const st = statSync(entryPath);
        if (st.size > CONFIG.codeIntel.watcherMaxFileSizeBytes) {
          continue;
        }
        files.push({
          absolutePath: entryPath,
          relativePath: relPath,
          size: st.size,
        });
      } catch {
        // Ignore permission errors and other stat failures.
      }
    }
  } catch {
    // readdirSync may fail on permission errors
  }

  return files;
}

// ─── Project metadata detection ─────────────────────────────────────

/**
 * Extract project type from metadata files (package.json, etc.).
 */
function detectProjectMeta(rootDir: string): {
  projectType: string | null;
  runtime: string | null;
  packageManager: string | null;
  hasTests: boolean;
} {
  let projectType: string | null = null;
  let runtime: string | null = null;
  let packageManager: string | null = null;
  let hasTests = false;

  // package.json
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      projectType = pkg.name ?? null;

      // Detect runtime
      if (
        pkg.dependencies?.bun ||
        pkg.devDependencies?.bun ||
        pkg.packageManager?.startsWith("bun")
      ) {
        runtime = "Bun";
      } else if (pkg.dependencies?.next || pkg.dependencies?.react) {
        runtime = "Node.js (React/Next.js)";
      } else {
        runtime = "Node.js";
      }

      // Detect package manager
      if (pkg.packageManager?.startsWith("bun")) {
        packageManager = "bun";
      } else if (existsSync(join(rootDir, "bun.lockb")) || existsSync(join(rootDir, "bun.lock"))) {
        packageManager = "bun";
      } else if (existsSync(join(rootDir, "pnpm-lock.yaml"))) {
        packageManager = "pnpm";
      } else if (existsSync(join(rootDir, "yarn.lock"))) {
        packageManager = "yarn";
      } else if (existsSync(join(rootDir, "package-lock.json"))) {
        packageManager = "npm";
      }

      // Detect test setup
      if (pkg.scripts?.test || pkg.devDependencies?.vitest || pkg.devDependencies?.jest) {
        hasTests = true;
      }
    } catch {
      /* ignore parse errors */
    }
  }

  // tsconfig.json
  if (existsSync(join(rootDir, "tsconfig.json"))) {
    if (!runtime) {
      runtime = "TypeScript (Node.js/Bun)";
    }
  }

  return { projectType, runtime, packageManager, hasTests };
}

/**
 * Detect top-level directory structure.
 */
function detectTopLevelDirs(rootDir: string): string[] {
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// ─── Main API ───────────────────────────────────────────────────────

/**
 * Scan the project directory, parse source files, and persist code entities.
 *
 * Uses the existing regex-based parser from code-intel/code-parser.ts
 * and persists via createOrGetCodeEntity() which auto-dedupes by entity key.
 *
 * @returns Scan statistics and a human-readable summary.
 */
export function indexProject(db: Database, projectId: string, opts?: IndexOptions): IndexResult {
  const log = getLogger();
  const rootDir = opts?.rootDir ?? process.cwd();
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const dryRun = opts?.dryRun ?? false;

  log.info("index", "scan_start", { rootDir, maxFiles, dryRun });

  // Discover files
  const files = discoverFiles(rootDir, opts?.subPath, maxFiles);
  const filesSkipped = 0; // discovery already filters

  // Scan each file
  const languages: Record<string, number> = {};
  let entitiesFound = 0;
  let entitiesNew = 0;

  for (const file of files) {
    try {
      const source = readFileSync(file.absolutePath, "utf-8");
      const parseResult = parseFile(file.relativePath, source);

      // Track language stats
      const lang = parseResult.language;
      languages[lang] = (languages[lang] ?? 0) + 1;

      if (!dryRun) {
        // Persist each entity (skip "file" type — too granular)
        for (const entity of parseResult.entities) {
          if (entity.entityType === "file") {
            continue;
          }

          entitiesFound++;

          // Check if entity already exists before creating
          const key = codeEntityKey({
            path: file.relativePath,
            entityType: entity.entityType,
            symbol: entity.symbol,
            lineStart: entity.lineStart,
            lineEnd: entity.lineEnd,
          });

          const exists = findCodeEntityByKey(db, projectId, key);
          if (!exists) {
            createOrGetCodeEntity(db, {
              projectId,
              entityType: entity.entityType,
              path: file.relativePath,
              symbol: entity.symbol,
              lineStart: entity.lineStart,
              lineEnd: entity.lineEnd,
              fingerprint: entity.fingerprint,
            });
            entitiesNew++;
          }
        }
      } else {
        entitiesFound += parseResult.entities.filter((e) => e.entityType !== "file").length;
        entitiesNew = entitiesFound; // dry run: all "would be" new
      }
    } catch (err) {
      log.debug("index", "file_error", {
        path: file.relativePath,
        error: (err as Error).message,
      });
    }
  }

  // Detect project metadata
  const topLevelDirs = detectTopLevelDirs(rootDir);

  // Build summary
  const totalEntities = entitiesFound;
  const langParts = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang, count]) => `${lang}: ${count}`)
    .join(", ");

  const summary =
    files.length === 0
      ? "No source files found in project."
      : `Scanned ${files.length} files → ${totalEntities} code entities (${entitiesNew} new)${dryRun ? " (dry run)" : ""}${langParts ? ` [${langParts}]` : ""}.`;

  log.info("index", "scan_complete", {
    filesScanned: files.length,
    totalEntities,
    entitiesNew,
    languages,
    topLevelDirs,
    dryRun,
  });

  return {
    filesScanned: files.length,
    filesSkipped,
    entitiesCreated: entitiesNew,
    entitiesAlreadyKnown: entitiesFound - entitiesNew,
    languages,
    topLevelDirs,
    summary,
  };
}

/**
 * Detect tech stack info from project root files.
 * Useful for seeding project overview memories.
 */
export function detectProjectMetaForSeed(rootDir?: string): {
  projectType: string | null;
  runtime: string | null;
  packageManager: string | null;
  hasTests: boolean;
  topLevelDirs: string[];
} {
  const dir = rootDir ?? process.cwd();
  return {
    ...detectProjectMeta(dir),
    topLevelDirs: detectTopLevelDirs(dir),
  };
}
