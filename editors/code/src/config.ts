import * as vscode from "vscode";

export interface TriMemhExtensionConfig {
  command: string;
  args: string[];
  dbPath?: string;
  defaultRecallMode: "fts" | "vector" | "hybrid";
  defaultEvidenceMode: "auto" | "off" | "force";
  autoRefreshOnActiveEditorChange: boolean;
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
