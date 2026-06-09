import type { Database } from "bun:sqlite";

import type { IndexResult } from "./index-use-cases";
import { detectProjectMetaForSeed } from "./index-use-cases";
import type { MemoryItem } from "../domain/schema";
import { remember } from "../service/memory-service";

/**
 * Create initial project overview memories after a codebase scan.
 *
 * These seed memories give the agent immediate context about the project
 * without needing to discover everything from scratch.
 */
export function seedProjectMemories(
  db: Database,
  projectId: string,
  scanResult: IndexResult,
  opts?: {
    rootDir?: string;
    /** Skip if there's nothing to report (empty project). */
    skipEmpty?: boolean;
  },
): MemoryItem[] {
  const rootDir = opts?.rootDir ?? process.cwd();
  const seeds: MemoryItem[] = [];

  // Skip if nothing was scanned
  if (opts?.skipEmpty !== false && scanResult.filesScanned === 0) {
    return seeds;
  }

  const meta = detectProjectMetaForSeed(rootDir);

  // ─── 1. Project overview ─────────────────────────────────────────

  const overviewParts: string[] = [];
  overviewParts.push(
    `Project codebase scan completed: ${scanResult.filesScanned} source files indexed, ${scanResult.entitiesCreated} code entities extracted.`,
  );

  if (scanResult.topLevelDirs.length > 0) {
    overviewParts.push(`Top-level directories: ${scanResult.topLevelDirs.join(", ")}.`);
  }

  const langEntries = Object.entries(scanResult.languages).sort((a, b) => b[1] - a[1]);
  if (langEntries.length > 0) {
    overviewParts.push(
      `Languages detected: ${langEntries.map(([lang, count]) => `${lang} (${count} files)`).join(", ")}.`,
    );
  }

  const overview = remember(db, {
    kind: "fact",
    text: overviewParts.join(" "),
    projectId,
    source: "memh:seed",
    confidence: 0.9,
    metadata: { specificity: "bootstrap" },
  });
  seeds.push(overview);

  // ─── 2. Tech stack ────────────────────────────────────────────────

  const techParts: string[] = [];
  if (meta.runtime) {
    techParts.push(`Runtime: ${meta.runtime}.`);
  }
  if (meta.packageManager) {
    techParts.push(`Package manager: ${meta.packageManager}.`);
  }
  if (meta.hasTests) {
    techParts.push("Test suite is configured.");
  }
  if (meta.projectType) {
    techParts.push(`Project name: ${meta.projectType}.`);
  }

  if (techParts.length > 0) {
    const tech = remember(db, {
      kind: "fact",
      text: `Detected tech stack — ${techParts.join(" ")}`,
      projectId,
      source: "memh:seed",
      confidence: 0.85,
      metadata: { specificity: "bootstrap" },
    });
    seeds.push(tech);
  }

  // ─── 3. Code graph structure ──────────────────────────────────────

  if (scanResult.topLevelDirs.length > 0) {
    const structure = remember(db, {
      kind: "code_context",
      text: `Project directory structure: ${scanResult.topLevelDirs.join("/")}. Code entities (functions, classes, modules) are indexed in the code graph — use memory_code_search(path="<file>") to find memories linked to specific files. Re-scan with: trimemh scan`,
      projectId,
      source: "memh:seed",
      confidence: 0.8,
    });
    seeds.push(structure);
  }

  return seeds;
}
