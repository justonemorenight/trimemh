/**
 * Git Integration (Phase 4 — Team & Scale)
 *
 * Integrates with git to:
 * 1. Detect changed files between commits / working tree
 * 2. Extract changed symbols (functions, classes) from diffs
 * 3. Suggest memory-code links based on git history
 * 4. Track memory provenance via commit references
 *
 * Usage:
 *   import { getChangedFiles, suggestMemoryLinks } from "./git-integration";
 *   const files = await getChangedFiles("HEAD~1", "HEAD");
 *   const suggestions = await suggestMemoryLinks(db, projectId, "HEAD~1", "HEAD");
 */

import type { Database } from "bun:sqlite";
import { $ } from "bun";

import type { CodeEntityType, CodeLinkRelation } from "../domain/schema";
import { getLogger } from "../infrastructure/logging";
import { diffEntities, parseFile } from "./code-parser";

// ─── Types ──────────────────────────────────────────────────────────

export interface GitChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
}

export interface CodeChange {
  file: string;
  added: Array<{ symbol: string; entityType: CodeEntityType }>;
  removed: Array<{ symbol: string; entityType: CodeEntityType }>;
  modified: Array<{ symbol: string; entityType: CodeEntityType }>;
}

export interface LinkSuggestion {
  memoryId: string;
  entityPath: string;
  entitySymbol: string;
  entityType: CodeEntityType;
  relation: CodeLinkRelation;
  reason: string;
  confidence: number;
}

// ─── Git operations ─────────────────────────────────────────────────

/**
 * Get list of changed files between two git refs.
 *
 * @param fromRef — Starting git ref (commit hash, branch, tag, or "HEAD~N")
 * @param toRef   — Ending git ref (default: current working tree)
 */
export async function getChangedFiles(
  fromRef = "HEAD~1",
  toRef = "HEAD",
): Promise<GitChangedFile[]> {
  const log = getLogger();

  try {
    const output = await $`git diff --name-status ${fromRef} ${toRef}`.quiet();
    const lines = output.stdout.toString().trim().split("\n").filter(Boolean);

    return lines.map((line) => {
      const parts = line.split("\t");
      const statusCode = parts[0] ?? "";
      const path = parts[1] ?? "";

      let status: GitChangedFile["status"] = "modified";
      if (statusCode.startsWith("A")) {
        status = "added";
      } else if (statusCode.startsWith("D")) {
        status = "deleted";
      } else if (statusCode.startsWith("R")) {
        status = "renamed";
      }

      return {
        path,
        status,
        oldPath: status === "renamed" ? parts[2] : undefined,
      };
    });
  } catch (err) {
    log.warn("git", "diff_failed", { error: (err as Error).message });
    return [];
  }
}

/**
 * Get changed files in the working tree (unstaged + staged).
 */
export async function getWorkingTreeChanges(): Promise<GitChangedFile[]> {
  const log = getLogger();

  try {
    // Staged changes
    const stagedOutput = await $`git diff --name-status --cached`.quiet();
    // Unstaged changes
    const unstagedOutput = await $`git diff --name-status`.quiet();

    const allLines = [
      ...stagedOutput.stdout.toString().trim().split("\n"),
      ...unstagedOutput.stdout.toString().trim().split("\n"),
    ].filter(Boolean);

    const seen = new Set<string>();
    const results: GitChangedFile[] = [];

    for (const line of allLines) {
      const parts = line.split("\t");
      const path = parts[1] ?? "";
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);

      results.push({
        path,
        status: parts[0]?.startsWith("D") ? "deleted" : "modified",
      });
    }

    return results;
  } catch (err) {
    log.warn("git", "working_tree_diff_failed", { error: (err as Error).message });
    return [];
  }
}

/**
 * Get the content of a file at a specific git ref.
 */
export async function getFileAtRef(filePath: string, ref = "HEAD"): Promise<string | null> {
  try {
    const output = await $`git show ${ref}:${filePath}`.quiet();
    return output.stdout.toString();
  } catch {
    return null;
  }
}

/**
 * Get the current commit hash.
 */
export async function getCurrentCommit(): Promise<string | null> {
  try {
    const output = await $`git rev-parse HEAD`.quiet();
    return output.stdout.toString().trim();
  } catch {
    return null;
  }
}

// ─── Code change analysis ───────────────────────────────────────────

/**
 * Analyze code changes between two git refs.
 * Returns added, removed, and modified entities per file.
 */
export async function analyzeCodeChanges(
  fromRef = "HEAD~1",
  toRef = "HEAD",
): Promise<CodeChange[]> {
  const log = getLogger();
  const changedFiles = await getChangedFiles(fromRef, toRef);
  const results: CodeChange[] = [];

  for (const file of changedFiles) {
    if (file.status === "deleted") {
      results.push({
        file: file.path,
        added: [],
        removed: [],
        modified: [],
      });
      continue;
    }

    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential git operations are intentional
      const oldSource = await getFileAtRef(file.path, fromRef);
      const newSource = await getFileAtRef(file.path, toRef);

      if (!newSource) {
        continue;
      }

      const newResult = parseFile(file.path, newSource);
      const newEntities = newResult.entities.filter((e) => e.entityType !== "file");

      if (oldSource) {
        const oldResult = parseFile(file.path, oldSource);
        const oldEntities = oldResult.entities.filter((e) => e.entityType !== "file");
        const diff = diffEntities(oldEntities, newEntities);

        results.push({
          file: file.path,
          added: diff.added.map((e) => ({ symbol: e.symbol, entityType: e.entityType })),
          removed: diff.removed.map((e) => ({ symbol: e.symbol, entityType: e.entityType })),
          modified: diff.modified.map((e) => ({ symbol: e.symbol, entityType: e.entityType })),
        });
      } else {
        // New file — all entities are added
        results.push({
          file: file.path,
          added: newEntities.map((e) => ({ symbol: e.symbol, entityType: e.entityType })),
          removed: [],
          modified: [],
        });
      }
    } catch (err) {
      log.debug("git", "change_analysis_error", {
        file: file.path,
        error: (err as Error).message,
      });
    }
  }

  return results;
}

// ─── Memory-code link suggestions ───────────────────────────────────

/**
 * Suggest memory-code links based on code changes.
 *
 * Searches for memories that mention changed symbols and suggests
 * linking them when a strong match is found.
 *
 * Heuristics:
 * - Symbol name appears in memory text → "documents" relation
 * - File path appears in memory text → "relates_to" relation
 * - Function renamed (removed old + added new) → "implements" for procedures
 */
export function suggestLinksFromChanges(
  db: Database,
  projectId: string,
  changes: CodeChange[],
): LinkSuggestion[] {
  const suggestions: LinkSuggestion[] = [];

  for (const change of changes) {
    // Get memories that reference this file path
    const pathMemories = db
      .query(
        `SELECT id, text, kind FROM memory_items
       WHERE project_id = ? AND status = 'active'
         AND (text LIKE ? OR text LIKE ?)`,
      )
      .all(projectId, `%${change.file}%`, `%${change.file.split("/").pop()}%`) as Array<{
      id: string;
      text: string;
      kind: string;
    }>;

    for (const memory of pathMemories) {
      // Check for symbol references in memory text
      for (const added of change.added) {
        if (memory.text.includes(added.symbol)) {
          const relation: CodeLinkRelation =
            memory.kind === "procedure" ? "implements" : "documents";
          suggestions.push({
            memoryId: memory.id,
            entityPath: change.file,
            entitySymbol: added.symbol,
            entityType: added.entityType,
            relation,
            reason: `Memory "${memory.id.slice(0, 8)}" mentions newly added symbol "${added.symbol}"`,
            confidence: 0.65,
          });
        }
      }

      for (const modified of change.modified) {
        if (memory.text.includes(modified.symbol)) {
          suggestions.push({
            memoryId: memory.id,
            entityPath: change.file,
            entitySymbol: modified.symbol,
            entityType: modified.entityType,
            relation: "relates_to",
            reason: `Memory "${memory.id.slice(0, 8)}" mentions modified symbol "${modified.symbol}"`,
            confidence: 0.45,
          });
        }
      }
    }
  }

  return suggestions;
}

/**
 * Full pipeline: analyze git changes and suggest memory links.
 */
export async function suggestMemoryLinks(
  db: Database,
  projectId: string,
  fromRef = "HEAD~1",
  toRef = "HEAD",
): Promise<{ changes: CodeChange[]; suggestions: LinkSuggestion[] }> {
  const log = getLogger();
  log.info("git", "analyzing_changes", { fromRef, toRef });

  const changes = await analyzeCodeChanges(fromRef, toRef);
  const suggestions = suggestLinksFromChanges(db, projectId, changes);

  log.info("git", "suggestions_ready", {
    filesChanged: changes.length,
    suggestions: suggestions.length,
  });

  return { changes, suggestions };
}

/**
 * Link a memory to the current git commit for provenance tracking.
 */
export async function tagMemoryWithCommit(
  db: Database,
  memoryId: string,
  commitHash?: string,
): Promise<void> {
  const commit = commitHash ?? (await getCurrentCommit());
  if (!commit) {
    return;
  }

  db.run(
    `UPDATE memory_items
     SET metadata_json = json_set(
       COALESCE(metadata_json, '{}'),
       '$.git_commit', ?,
       '$.git_tagged_at', ?
     )
     WHERE id = ?`,
    [commit, new Date().toISOString(), memoryId],
  );
}
