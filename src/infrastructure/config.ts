import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { TriMemhConfig } from "../domain/schema";

const CONFIG_FILE_NAME = ".memh.toml";
const TRIMEMH_DIR = ".trimemh";
const DB_FILE = "memory.db";

// ─── Resolve project id from CWD or config file ──────────────────

function hashString(s: string): string {
  // Simple djb2 hash — stable across sessions, no crypto needed
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function resolveProjectId(cwd: string): string {
  // 1. Check .memh.toml for explicit project_id
  const configPath = join(cwd, CONFIG_FILE_NAME);
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      // biome-ignore lint/performance/useTopLevelRegex: warning suppression
      const match = content.match(/project_id\s*=\s*"([^"]+)"/);
      if (match) {
        const pid = match[1];
        if (pid) {
          return pid;
        }
      }
    } catch {
      // fall through
    }
  }

  // 2. Use CWD hash as default project id (stable, portable)
  return hashString(resolve(cwd));
}

// ─── Resolve database path ────────────────────────────────────────

export function resolveDbPath(cwd: string, explicitPath?: string): string {
  if (explicitPath) {
    return explicitPath;
  }

  // Default: .trimemh/memory.db in CWD
  const memhDir = join(cwd, TRIMEMH_DIR);
  if (!existsSync(memhDir)) {
    mkdirSync(memhDir, { recursive: true });
  }
  return join(memhDir, DB_FILE);
}

// ─── Load full config ─────────────────────────────────────────────

export function loadConfig(cwd?: string): TriMemhConfig {
  const workDir = cwd ?? process.cwd();
  return {
    projectId: resolveProjectId(workDir),
    dbPath: resolveDbPath(workDir),
  };
}

// ─── Global data directory (for non-project-scoped operations) ───

export function globalDataDir(): string {
  const dir = join(homedir(), ".trimemh");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
