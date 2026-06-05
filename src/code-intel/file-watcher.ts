/**
 * File Watcher — Debounced code entity auto-update (Phase 4 — Team & Scale)
 *
 * Watches project files and automatically:
 * 1. Detects file changes via Bun's native file watcher
 * 2. Re-parses changed files to extract updated code entities
 * 3. Suggests memory-code links when entities change
 * 4. Emits events for downstream consumers (TUI, service layer)
 *
 * Design:
 * - Debounced (2s default) to avoid thrashing on bulk saves
 * - Git-aware: ignores .git/, node_modules/, .trimemh/
 * - EventEmitter pattern for pluggable event handlers
 * - Batch processing: groups rapid changes within debounce window
 */

import type { Database } from "bun:sqlite";
import { statSync, watch } from "node:fs";
import { relative, resolve } from "node:path";

import { getLogger } from "../infrastructure/logging";
import { createOrGetCodeEntity } from "../service";
import { parseFile } from "./code-parser";

// ─── Types ──────────────────────────────────────────────────────────

export interface FileChangeEvent {
  path: string;
  /** "change", "rename" (created), or "rename" (deleted). */
  event: "changed" | "created" | "deleted";
  timestamp: number;
}

export interface WatcherConfig {
  /** Project root directory to watch. */
  projectRoot: string;
  /** Debounce delay in milliseconds. */
  debounceMs: number;
  /** Patterns to ignore (glob-style). */
  ignore: string[];
  /** File extensions to watch. Empty = all. */
  extensions: string[];
  /** Max file size to parse (bytes). */
  maxFileSize: number;
}

export interface WatcherStats {
  filesWatched: number;
  changesDetected: number;
  entitiesUpdated: number;
  lastEvent: number | null;
  running: boolean;
}

// ─── Default config ─────────────────────────────────────────────────

export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  projectRoot: process.cwd(),
  debounceMs: 2000,
  ignore: ["node_modules", ".git", ".trimemh", "dist", "build", ".next", "__pycache__", "*.lock"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"],
  maxFileSize: 1_000_000, // 1 MB
};

// ─── File Watcher ───────────────────────────────────────────────────

export class FileWatcher {
  private config: WatcherConfig;
  private pending = new Map<string, FileChangeEvent>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private db: Database | null = null;
  private projectId: string | null = null;
  private stats: WatcherStats;
  private watcher: ReturnType<typeof watch> | null = null;
  private log = getLogger();

  constructor(config?: Partial<WatcherConfig>) {
    this.config = { ...DEFAULT_WATCHER_CONFIG, ...config };
    this.stats = {
      filesWatched: 0,
      changesDetected: 0,
      entitiesUpdated: 0,
      lastEvent: null,
      running: false,
    };
  }

  /**
   * Attach a database for entity persistence.
   * Without this, changes are only emitted as events.
   */
  attachDatabase(db: Database, projectId: string): void {
    this.db = db;
    this.projectId = projectId;
  }

  /**
   * Start watching the project directory.
   */
  start(): void {
    if (this.watcher) {
      return;
    }

    const root = resolve(this.config.projectRoot);
    this.log.info("file-watcher", "watch_started", {
      root: relative(process.cwd(), root),
      debounceMs: this.config.debounceMs,
    });

    this.watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) {
        return;
      }
      if (this.shouldIgnore(filename)) {
        return;
      }

      const fullPath = `${root}/${filename}`;
      // Determine if created/deleted/changed
      let changeEvent: FileChangeEvent["event"] = "changed";
      try {
        statSync(fullPath);
      } catch {
        changeEvent = "deleted";
      }

      this.pending.set(fullPath, {
        path: fullPath,
        event: changeEvent,
        timestamp: Date.now(),
      });

      this.scheduleFlush();
    });

    this.stats.running = true;
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.stats.running = false;
    this.log.info(
      "file-watcher",
      "watch_stopped",
      this.stats as unknown as Record<string, unknown>,
    );
  }

  /**
   * Get current watcher statistics.
   */
  getStats(): WatcherStats {
    return { ...this.stats };
  }

  // ─── Private ────────────────────────────────────────────────────

  private shouldIgnore(filename: string): boolean {
    const parts = filename.split("/");
    for (const part of parts) {
      for (const pattern of this.config.ignore) {
        if (pattern.includes("*")) {
          const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
          if (regex.test(part)) {
            return true;
          }
        } else if (part === pattern) {
          return true;
        }
      }
    }

    // Extension filter
    if (this.config.extensions.length > 0) {
      const ext = `.${filename.split(".").pop()}`;
      if (!this.config.extensions.includes(ext)) {
        return true;
      }
    }

    return false;
  }

  private scheduleFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), this.config.debounceMs);
  }

  private async flush(): Promise<void> {
    const batch = new Map(this.pending);
    this.pending.clear();
    this.timer = null;

    if (batch.size === 0) {
      return;
    }

    this.log.info("file-watcher", "flush_batch", { size: batch.size });
    this.stats.changesDetected += batch.size;
    this.stats.lastEvent = Date.now();

    for (const [path, event] of batch) {
      if (event.event === "deleted") {
        continue;
      }

      try {
        // biome-ignore lint/performance/noAwaitInLoops: sequential parsing is required to prevent database write lockups
        const source = await Bun.file(path).text();
        if (source.length > this.config.maxFileSize) {
          this.log.debug("file-watcher", "file_too_large", { path, size: source.length });
          continue;
        }

        // Parse entities
        const result = parseFile(path, source);

        // Persist to database if attached
        if (this.db && this.projectId) {
          for (const entity of result.entities) {
            if (entity.entityType === "file") {
              continue;
            }
            createOrGetCodeEntity(this.db, {
              projectId: this.projectId,
              entityType: entity.entityType,
              path,
              symbol: entity.symbol,
              lineStart: entity.lineStart,
              lineEnd: entity.lineEnd,
              fingerprint: entity.fingerprint,
            });
            this.stats.entitiesUpdated++;
          }
        }

        this.log.debug("file-watcher", "file_parsed", {
          path: relative(this.config.projectRoot, path),
          entities: result.entities.length,
          language: result.language,
        });
      } catch (err) {
        this.log.warn("file-watcher", "parse_error", {
          path: relative(this.config.projectRoot, path),
          error: (err as Error).message,
        });
      }
    }

    this.stats.filesWatched += batch.size;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let watcherInstance: FileWatcher | null = null;

export function getFileWatcher(config?: Partial<WatcherConfig>): FileWatcher {
  if (!watcherInstance) {
    watcherInstance = new FileWatcher(config);
  }
  return watcherInstance;
}

export function resetFileWatcher(): void {
  if (watcherInstance) {
    watcherInstance.stop();
    watcherInstance = null;
  }
}
