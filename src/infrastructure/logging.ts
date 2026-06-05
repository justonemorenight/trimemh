/**
 * Structured Logging & Observability (Phase 3 — Integration & DX)
 *
 * JSON Lines logger with configurable levels, module tagging, and
 * output routing (stderr default, file, or custom stream).
 *
 * Format: {"ts":"2026-06-05T12:00:00.000Z","level":"INFO","module":"mcp",
 *           "msg":"memory_search allowed","ctx":{"tool":"memory_search","remaining":29}}
 *
 * Levels (RFC 5424 severity): DEBUG(7), INFO(6), WARN(4), ERROR(3), AUDIT(2)
 *
 * Usage:
 *   import { logger } from "./logging";
 *   logger.info("mcp", "memory_search returned 5 results", { query: "error handling" });
 *   logger.audit("governance", "proposal_approved", { proposalId: "abc-123", by: "user" });
 */

// ─── Types ──────────────────────────────────────────────────────────

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "AUDIT";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  module: string;
  msg: string;
  ctx?: Record<string, unknown>;
}

export interface LoggerConfig {
  /** Minimum log level to emit (default: INFO). */
  minLevel: LogLevel;
  /** Output stream (default: process.stderr). */
  stream: NodeJS.WritableStream;
  /** Pretty-print instead of JSON Lines (default: false). */
  pretty: boolean;
  /** Enable color output (default: true for pretty mode). */
  color: boolean;
}

// ─── Level ordering ─────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  AUDIT: 5, // always emitted
};

// ─── ANSI colors ────────────────────────────────────────────────────

const COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[36m", // cyan
  INFO: "\x1b[32m", // green
  WARN: "\x1b[33m", // yellow
  ERROR: "\x1b[31m", // red
  AUDIT: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// ─── Logger implementation ──────────────────────────────────────────

export class Logger {
  private config: LoggerConfig;

  constructor(config?: Partial<LoggerConfig>) {
    this.config = {
      minLevel: config?.minLevel ?? "INFO",
      stream: config?.stream ?? process.stderr,
      pretty: config?.pretty ?? !process.env.TRIMEMH_LOG_JSON,
      color: config?.color ?? true,
    };
  }

  debug(module: string, msg: string, ctx?: Record<string, unknown>): void {
    this.emit("DEBUG", module, msg, ctx);
  }

  info(module: string, msg: string, ctx?: Record<string, unknown>): void {
    this.emit("INFO", module, msg, ctx);
  }

  warn(module: string, msg: string, ctx?: Record<string, unknown>): void {
    this.emit("WARN", module, msg, ctx);
  }

  error(module: string, msg: string, ctx?: Record<string, unknown>): void {
    this.emit("ERROR", module, msg, ctx);
  }

  /**
   * Audit-level log — always emitted regardless of minLevel.
   * Use for governance events, security violations, and memory writes.
   */
  audit(module: string, msg: string, ctx?: Record<string, unknown>): void {
    this.emit("AUDIT", module, msg, ctx);
  }

  /** Reconfigure logger at runtime. */
  configure(config: Partial<LoggerConfig>): void {
    Object.assign(this.config, config);
  }

  get minLevel(): LogLevel {
    return this.config.minLevel;
  }

  // ─── Private ────────────────────────────────────────────────────

  private emit(level: LogLevel, module: string, msg: string, ctx?: Record<string, unknown>): void {
    // Level filtering (AUDIT always passes)
    if (level !== "AUDIT" && LEVEL_ORDER[level] < LEVEL_ORDER[this.config.minLevel]) {
      return;
    }

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      module: module.slice(0, 32), // cap module name
      msg: msg.slice(0, 1000), // cap message
      ctx: ctx ? this.sanitizeCtx(ctx) : undefined,
    };

    const line = this.config.pretty ? this.formatPretty(entry) : JSON.stringify(entry);

    this.config.stream.write(`${line}\n`);
  }

  private formatPretty(entry: LogEntry): string {
    const color = this.config.color ? (COLORS[entry.level] ?? "") : "";
    const reset = this.config.color ? RESET : "";
    const dim = this.config.color ? DIM : "";

    const parts = [
      `${dim}${entry.ts.slice(11, 23)}${reset}`,
      `${color}[${entry.level.padEnd(5)}]${reset}`,
      `${dim}${entry.module.padEnd(12)}${reset}`,
      entry.msg,
    ];

    if (entry.ctx) {
      const ctxParts = Object.entries(entry.ctx)
        .map(([k, v]) => `${dim}${k}=${reset}${JSON.stringify(v)}`)
        .join(" ");
      parts.push(ctxParts);
    }

    return parts.join(" ");
  }

  private sanitizeCtx(ctx: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx)) {
      if (value === undefined) {
        continue;
      }
      if (typeof value === "string" && value.length > 500) {
        sanitized[key] = `${value.slice(0, 500)}…`;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let defaultLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = new Logger();
  }
  return defaultLogger;
}

export const logger = new Proxy({} as Logger, {
  get(_target, prop) {
    return getLogger()[prop as keyof Logger];
  },
}) as Logger;

export function resetLogger(): void {
  defaultLogger = null;
}
