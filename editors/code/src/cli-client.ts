import { spawn } from "node:child_process";
import * as vscode from "vscode";

import { getConfig, workspaceRoot } from "./config";
import type { ContextResult, MemoryItem, MemoryProposal, RecallResult, TriMemhJson, TriMemhStatus } from "./types";

export class TriMemhCliError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

export class TriMemhClient {
  async status(): Promise<TriMemhStatus> {
    const response = await this.runJson<TriMemhStatus>(["status"]);
    return response.data;
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
    const response = await this.runJson<ContextResult>(args);
    return response.data;
  }

  async recall(input: { query: string; limit?: number }): Promise<RecallResult[]> {
    const response = await this.runJson<RecallResult[]>([
      "recall",
      input.query,
      "--limit",
      String(input.limit ?? 10),
    ]);
    return response.data;
  }

  async listMemories(input: { kind?: string; status?: string } = {}): Promise<MemoryItem[]> {
    const args = ["list"];
    if (input.kind) {
      args.push("--kind", input.kind);
    }
    if (input.status) {
      args.push("--status", input.status);
    }
    const response = await this.runJson<MemoryItem[]>(args);
    return response.data;
  }

  async remember(input: { kind: string; text: string; confidence?: number }): Promise<MemoryItem> {
    const args = [
      "remember",
      "--kind",
      input.kind,
      "--text",
      input.text,
      "--confidence",
      String(input.confidence ?? 0.5),
    ];
    const response = await this.runJson<MemoryItem>(args);
    return response.data;
  }

  async propose(input: { kind: string; text: string; rationale?: string }): Promise<MemoryProposal> {
    const args = ["propose", "--kind", input.kind, "--text", input.text, "--by", "vscode"];
    if (input.rationale) {
      args.push("--rationale", input.rationale);
    }
    const response = await this.runJson<MemoryProposal>(args);
    return response.data;
  }

  async approveProposal(id: string): Promise<unknown> {
    const response = await this.runJson<unknown>(["approve", id]);
    return response.data;
  }

  async rejectProposal(id: string, note?: string): Promise<MemoryProposal> {
    const args = ["reject", id];
    if (note) {
      args.push("--note", note);
    }
    const response = await this.runJson<MemoryProposal>(args);
    return response.data;
  }

  private async runJson<T>(args: string[]): Promise<TriMemhJson<T>> {
    return this.run([...args, "--json"]);
  }

  private async run<T>(args: string[]): Promise<TriMemhJson<T>> {
    const config = getConfig();
    const fullArgs = [...config.args, ...args];
    if (config.dbPath) {
      fullArgs.push("--db", config.dbPath);
    }

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
        resolve(out);
      });
    });

    try {
      return JSON.parse(stdout) as TriMemhJson<T>;
    } catch (error) {
      throw new TriMemhCliError(
        `triMemh returned invalid JSON. Raw output:\n${stdout.slice(0, 1000)}`,
        error instanceof Error ? error.message : String(error),
        null,
      );
    }
  }
}

export function showCliError(error: unknown): void {
  if (error instanceof TriMemhCliError) {
    vscode.window.showErrorMessage(error.message);
    return;
  }
  vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}
