import { existsSync } from "node:fs";
import { join } from "node:path";

import * as vscode from "vscode";

export interface TriMemhExtensionConfig {
  command: string;
  args: string[];
  dbPath?: string;
  defaultRecallMode: "fts" | "vector" | "hybrid";
  defaultEvidenceMode: "auto" | "off" | "force";
  autoRefreshOnActiveEditorChange: boolean;
  defaultMemoryWriteMode: "propose" | "remember";
}

export function getConfig(): TriMemhExtensionConfig {
  const config = vscode.workspace.getConfiguration("trimemh");
  const args = config.get<unknown[]>("args", []);
  return {
    command: config.get("command", "trimemh"),
    args: args.filter((item): item is string => typeof item === "string"),
    dbPath: config.get("dbPath", "") || undefined,
    defaultRecallMode: config.get("defaultRecallMode", "fts"),
    defaultEvidenceMode: config.get("defaultEvidenceMode", "auto"),
    autoRefreshOnActiveEditorChange: config.get("autoRefreshOnActiveEditorChange", false),
    defaultMemoryWriteMode: config.get("defaultMemoryWriteMode", "propose"),
  };
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function relativeWorkspacePath(uri: vscode.Uri): string {
  const root = workspaceRoot();
  if (!root) {
    return uri.fsPath;
  }
  return vscode.workspace.asRelativePath(uri, false);
}

export function hasTriMemhSupport(): boolean {
  const config = getConfig();
  if (config.dbPath) {
    return true;
  }
  const root = workspaceRoot();
  if (!root) {
    return false;
  }
  return (
    existsSync(join(root, ".trimemh")) ||
    existsSync(join(root, ".claude", "commands", "memh-start.md")) ||
    existsSync(join(root, ".claude", "commands", "memh-stale.md"))
  );
}
