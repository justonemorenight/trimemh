import { spawn } from "node:child_process";
import * as vscode from "vscode";

import { getConfig, workspaceRoot } from "./config";
import type {
  AtlasGraph,
  ContextResult,
  MemoryItem,
  MemoryProposal,
  RecallResult,
  StaleMemoryReport,
  TriMemhJson,
  TriMemhStatus,
} from "./types";
import { log } from "./ui/output";

export class TriMemhCliError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

function unwrapJson<T>(value: unknown): T {
  if (
    value &&
    typeof value === "object" &&
    "success" in value &&
    "data" in value
  ) {
    return (value as TriMemhJson<T>).data;
  }
  return value as T;
}

function parseJsonFromCli<T>(stdout: string): T {
  const trimmed = stdout.trim();
  const directStart = trimmed.search(/[\[{]/);
  const candidates = [trimmed, directStart >= 0 ? trimmed.slice(directStart) : trimmed];

  for (const candidate of candidates) {
    try {
      return unwrapJson<T>(JSON.parse(candidate));
    } catch {}
  }

  const lines = trimmed.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!(candidate.startsWith("{") || candidate.startsWith("["))) {
      continue;
    }
    try {
      return unwrapJson<T>(JSON.parse(candidate));
    } catch {}
  }

  throw new TriMemhCliError(`triMemh returned invalid JSON. Raw output:\n${stdout.slice(0, 1000)}`, "", null);
}

export class TriMemhClient {
  private queue: Promise<unknown> = Promise.resolve();

  async status(): Promise<TriMemhStatus> {
    return this.runJson<TriMemhStatus>(["status"]);
  }

  async assembleContext(input: { query?: string; openPaths?: string[] }): Promise<ContextResult> {
    const config = getConfig();
    const args = ["context", "--tokens", "32000", "--evidence-mode", config.defaultEvidenceMode];
    if (input.query) {
      args.push("--query", input.query);
    }
    if (input.openPaths?.length) {
      args.push("--paths", input.openPaths.join(","));
    }
    return this.runJson<ContextResult>(args);
  }

  async recall(input: { query: string; limit?: number }): Promise<RecallResult[]> {
    return this.runJson<RecallResult[]>([
      "recall",
      input.query,
      "--limit",
      String(input.limit ?? 10),
    ]);
  }

  async listMemories(input: { kind?: string; status?: string } = {}): Promise<MemoryItem[]> {
    const args = ["list"];
    if (input.kind) {
      args.push("--kind", input.kind);
    }
    if (input.status) {
      args.push("--status", input.status);
    }
    return this.runJson<MemoryItem[]>(args);
  }

  async remember(input: { kind: string; text: string; confidence?: number }): Promise<MemoryItem> {
    return this.runJson<MemoryItem>([
      "remember",
      input.text,
      "--kind",
      input.kind,
      "--confidence",
      String(input.confidence ?? 0.5),
    ]);
  }

  async propose(input: { kind: string; text: string; rationale?: string }): Promise<MemoryProposal> {
    const args = ["propose", input.text, "--kind", input.kind, "--by", "vscode"];
    if (input.rationale) {
      args.push("--rationale", input.rationale);
    }
    return this.runJson<MemoryProposal>(args);
  }

  async approveProposal(id: string): Promise<unknown> {
    return this.runJson<unknown>(["approve", id]);
  }

  async rejectProposal(id: string, note?: string): Promise<MemoryProposal> {
    const args = ["reject", id];
    if (note) {
      args.push("--note", note);
    }
    return this.runJson<MemoryProposal>(args);
  }

  async forgetMemory(id: string): Promise<unknown> {
    return this.runJson<unknown>(["forget", id]);
  }

  async stale(input: {
    path?: string;
    symbol?: string;
    includeLowConfidence?: boolean;
    conflicts?: boolean;
    limit?: number;
  } = {}): Promise<StaleMemoryReport> {
    const args = ["lifecycle", "stale"];
    if (input.path) {
      args.push("--path", input.path);
    }
    if (input.symbol) {
      args.push("--symbol", input.symbol);
    }
    if (input.includeLowConfidence) {
      args.push("--include-low-confidence");
    }
    if (input.conflicts === false) {
      args.push("--no-conflicts");
    }
    if (input.limit) {
      args.push("--limit", String(input.limit));
    }
    return this.runJson<StaleMemoryReport>(args);
  }

  async scanCodebase(): Promise<string> {
    return this.runText(["scan"]);
  }

  async atlas(input: { path?: string; symbol?: string; depth?: number } = {}): Promise<AtlasGraph> {
    const args = ["atlas", "--depth", String(input.depth ?? 2)];
    if (input.path) {
      args.push("--path", input.path);
    }
    if (input.symbol) {
      args.push("--symbol", input.symbol);
    }
    return this.runJson<AtlasGraph>(args);
  }

  async runText(args: string[]): Promise<string> {
    return this.run(args);
  }

  private async runJson<T>(args: string[]): Promise<T> {
    const stdout = await this.run([...args, "--json"]);
    return parseJsonFromCli<T>(stdout);
  }

  private async run(args: string[]): Promise<string> {
    const task = this.queue.then(() => this.runNow(args));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async runNow(args: string[]): Promise<string> {
    const config = getConfig();
    const fullArgs = [...config.args, ...args];
    if (config.dbPath) {
      fullArgs.push("--db", config.dbPath);
    }

    log(`$ ${config.command} ${fullArgs.join(" ")}`);
    const root = workspaceRoot();
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.command, fullArgs, {
        cwd: root,
        env: process.env,
        shell: process.platform === "win32",
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on("error", (error) => {
        reject(new TriMemhCliError(error.message, err, null));
      });
      child.on("close", (code) => {
        if (code && code !== 0) {
          reject(new TriMemhCliError(err || `triMemh exited with code ${code}`, err, code));
          return;
        }
        if (err.trim()) {
          log(err.trim());
        }
        resolve(out);
      });
    });
    if (stdout.trim()) {
      log(stdout.trim());
    }
    return stdout;
  }
}

export function showCliError(error: unknown): void {
  if (error instanceof TriMemhCliError) {
    vscode.window.showErrorMessage(error.message);
    return;
  }
  vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}
