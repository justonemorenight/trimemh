import * as vscode from "vscode";

import { TriMemhClient, showCliError } from "./cli-client";
import { getConfig, hasTriMemhSupport, relativeWorkspacePath } from "./config";
import { StaleDiagnostics } from "./stale-diagnostics";
import type { MemoryItem, MemoryProposal, StaleMemoryReport } from "./types";
import {
  showCommandLog,
  showContextOutput,
  showLog,
  showMemoryDetail,
  showStaleReport,
} from "./ui/output";
import { DashboardViewProvider } from "./views/dashboard-webview";
import { AtlasWebviewProvider } from "./views/atlas-webview";
import { MemoriesTreeProvider, MemoryTreeItem } from "./views/memories-tree";
import { ProposalTreeItem, ProposalsTreeProvider } from "./views/proposals-tree";
import { StaleTreeItem, StaleTreeProvider } from "./views/stale-tree";
import { TriMemhStatusBar } from "./views/status-bar";

const MEMORY_KINDS = [
  "preference",
  "fact",
  "decision",
  "session_summary",
  "tooling",
  "code_context",
  "procedure",
  "mistake",
  "trade_rule",
  "security_rule",
];

function activePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  return relativeWorkspacePath(editor.document.uri);
}

function selectedText(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection).trim();
  return text || undefined;
}

function memoryFromArg(arg: unknown): MemoryItem | undefined {
  if (arg instanceof MemoryTreeItem) {
    return arg.memory;
  }
  if (arg instanceof StaleTreeItem) {
    return arg.finding.memory;
  }
  if (arg && typeof arg === "object" && "id" in arg && "text" in arg) {
    return arg as MemoryItem;
  }
  return undefined;
}

function proposalFromArg(arg: unknown): MemoryProposal | undefined {
  if (arg instanceof ProposalTreeItem) {
    return arg.proposal;
  }
  if (arg && typeof arg === "object" && "id" in arg && "proposed_text" in arg) {
    return arg as MemoryProposal;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const client = new TriMemhClient();
  const statusBar = new TriMemhStatusBar();
  const dashboard = new DashboardViewProvider();
  const atlas = new AtlasWebviewProvider();
  const proposalsTree = new ProposalsTreeProvider();
  const memoriesTree = new MemoriesTreeProvider();
  const staleTree = new StaleTreeProvider();
  const staleDiagnostics = new StaleDiagnostics();

  let lastStaleReport: StaleMemoryReport | undefined;

  function ensureSupported(showMessage = true): boolean {
    if (hasTriMemhSupport()) {
      return true;
    }
    statusBar.unsupported();
    dashboard.showUnsupported();
    staleTree.setReport(undefined);
    staleDiagnostics.clear();
    if (showMessage) {
      vscode.window.showInformationMessage(
        "triMemh is not initialized for this workspace. Open a triMemh-enabled codebase or set trimemh.dbPath.",
      );
    }
    return false;
  }

  async function refresh(): Promise<void> {
    if (!ensureSupported(false)) {
      return;
    }
    statusBar.loading();
    try {
      const [status, memories] = await Promise.all([
        client.status(),
        client.listMemories({ status: "active" }),
      ]);
      proposalsTree.setProposals(status.pendingProposals ?? []);
      memoriesTree.setMemories(memories);
      dashboard.update(status, lastStaleReport);
      statusBar.connected(status);
    } catch (error) {
      statusBar.error();
      showCliError(error);
    }
  }

  async function refreshAtlas(path?: string): Promise<void> {
    if (!ensureSupported()) {
      return;
    }
    try {
      const graph = await client.atlas({ path: path ?? activePath(), depth: 2 });
      atlas.setGraph(graph);
      await vscode.commands.executeCommand("workbench.view.extension.trimemh");
    } catch (error) {
      showCliError(error);
    }
  }

  async function checkStale(path?: string, workspaceWide = false): Promise<void> {
    if (!ensureSupported()) {
      return;
    }
    try {
      const targetPath = workspaceWide ? undefined : (path ?? activePath());
      const report = await client.stale({ path: targetPath, limit: 50 });
      lastStaleReport = report;
      staleTree.setReport(report);
      dashboard.update(undefined, report);
      showStaleReport(report);
      const editor = vscode.window.activeTextEditor;
      if (editor && targetPath) {
        staleDiagnostics.updateForDocument(editor.document.uri, report);
      }
      const flagged = report.summary.flagged_memory_count;
      const message = `${flagged}/${report.summary.checked_memory_count} stale memory finding(s)`;
      if (flagged > 0) {
        vscode.window.showWarningMessage(`triMemh: ${message}`);
      } else {
        vscode.window.showInformationMessage(`triMemh: ${message}`);
      }
    } catch (error) {
      showCliError(error);
    }
  }

  async function writeSelection(mode: "remember" | "propose"): Promise<void> {
    if (!ensureSupported()) {
      return;
    }
    const text = selectedText();
    if (!text) {
      vscode.window.showInformationMessage("Select text to store in triMemh first.");
      return;
    }
    const kind = await vscode.window.showQuickPick(MEMORY_KINDS, {
      title: mode === "remember" ? "Remember selection as" : "Propose selection as",
    });
    if (!kind) {
      return;
    }
    try {
      if (mode === "remember") {
        await client.remember({ kind, text, confidence: 0.7 });
        vscode.window.showInformationMessage("triMemh memory saved.");
      } else {
        const rationale = await vscode.window.showInputBox({
          title: "Rationale for memory proposal",
          prompt: "Why should this memory be kept?",
        });
        await client.propose({ kind, text, rationale });
        vscode.window.showInformationMessage("triMemh memory proposal created.");
      }
      await refresh();
    } catch (error) {
      showCliError(error);
    }
  }

  context.subscriptions.push(
    statusBar,
    staleDiagnostics,
    vscode.window.registerWebviewViewProvider("trimemh.dashboard", dashboard),
    vscode.window.registerWebviewViewProvider("trimemh.atlas", atlas),
    vscode.window.registerTreeDataProvider("trimemh.proposals", proposalsTree),
    vscode.window.registerTreeDataProvider("trimemh.memories", memoriesTree),
    vscode.window.registerTreeDataProvider("trimemh.stale", staleTree),
    vscode.commands.registerCommand("trimemh.refresh", refresh),
    vscode.commands.registerCommand("trimemh.openAtlas", () => refreshAtlas()),
    vscode.commands.registerCommand("trimemh.focusAtlasOnCurrentFile", () => refreshAtlas(activePath())),
    vscode.commands.registerCommand("trimemh.atlas.refresh", () => refreshAtlas(activePath())),
    vscode.commands.registerCommand("trimemh.atlas.fit", () => atlas.reveal()),
    vscode.commands.registerCommand(
      "trimemh.atlas.openFile",
      async (payload?: { path?: string; line?: number | null }) => {
        if (!payload?.path) {
          return;
        }
        const uri = vscode.Uri.file(
          vscode.workspace.workspaceFolders?.[0]
            ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, payload.path).fsPath
            : payload.path,
        );
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        if (payload.line && payload.line > 0) {
          const position = new vscode.Position(payload.line - 1, 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position));
        }
      },
    ),
    vscode.commands.registerCommand("trimemh.showLog", showLog),
    vscode.commands.registerCommand("trimemh.checkStale", () => checkStale()),
    vscode.commands.registerCommand("trimemh.checkStaleWorkspace", () => checkStale(undefined, true)),
    vscode.commands.registerCommand("trimemh.refreshContext", async () => {
      if (!ensureSupported()) {
        return;
      }
      try {
        const path = activePath();
        const result = await client.assembleContext({
          query: path ? `Current file: ${path}` : "VS Code context refresh",
          openPaths: path ? [path] : [],
        });
        showContextOutput(result.xml, result.diagnostics);
      } catch (error) {
        showCliError(error);
      }
    }),
    vscode.commands.registerCommand("trimemh.showCurrentContext", async () => {
      await vscode.commands.executeCommand("trimemh.refreshContext");
    }),
    vscode.commands.registerCommand("trimemh.searchMemories", async () => {
      if (!ensureSupported()) {
        return;
      }
      const query = await vscode.window.showInputBox({ title: "Search triMemh memories" });
      if (!query) {
        return;
      }
      try {
        const results = await client.recall({ query, limit: 12 });
        const selected = await vscode.window.showQuickPick(
          results.map((result) => ({
            label: result.item.text.slice(0, 80),
            description: result.item.kind,
            detail: result.snippet ?? result.item.id,
            item: result.item,
          })),
          { title: "triMemh search results" },
        );
        if (selected) {
          showMemoryDetail(selected.item);
        }
      } catch (error) {
        showCliError(error);
      }
    }),
    vscode.commands.registerCommand("trimemh.rememberSelection", () => writeSelection("remember")),
    vscode.commands.registerCommand("trimemh.proposeSelection", () => writeSelection("propose")),
    vscode.commands.registerCommand("trimemh.proposal.approve", async (arg?: unknown) => {
      if (!ensureSupported()) {
        return;
      }
      const proposal = proposalFromArg(arg);
      if (!proposal) {
        return;
      }
      try {
        await client.approveProposal(proposal.id);
        vscode.window.showInformationMessage("triMemh proposal approved.");
        await refresh();
      } catch (error) {
        showCliError(error);
      }
    }),
    vscode.commands.registerCommand("trimemh.proposal.reject", async (arg?: unknown) => {
      if (!ensureSupported()) {
        return;
      }
      const proposal = proposalFromArg(arg);
      if (!proposal) {
        return;
      }
      const note = await vscode.window.showInputBox({ title: "Reject proposal note" });
      try {
        await client.rejectProposal(proposal.id, note);
        vscode.window.showInformationMessage("triMemh proposal rejected.");
        await refresh();
      } catch (error) {
        showCliError(error);
      }
    }),
    vscode.commands.registerCommand("trimemh.copyId", async (arg?: unknown) => {
      const memory = memoryFromArg(arg);
      const proposal = proposalFromArg(arg);
      const id = memory?.id ?? proposal?.id;
      if (id) {
        await vscode.env.clipboard.writeText(id);
        vscode.window.showInformationMessage("triMemh ID copied.");
      }
    }),
    vscode.commands.registerCommand("trimemh.memory.showDetail", (arg?: unknown) => {
      const memory = memoryFromArg(arg);
      if (memory) {
        showMemoryDetail(memory);
      }
    }),
    vscode.commands.registerCommand("trimemh.memory.forget", async (arg?: unknown) => {
      if (!ensureSupported()) {
        return;
      }
      const memory = memoryFromArg(arg);
      if (!memory) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Archive memory ${memory.id}?`,
        { modal: true },
        "Archive",
      );
      if (confirmed !== "Archive") {
        return;
      }
      try {
        await client.forgetMemory(memory.id);
        vscode.window.showInformationMessage("triMemh memory archived.");
        await refresh();
      } catch (error) {
        showCliError(error);
      }
    }),
    vscode.commands.registerCommand("trimemh.scanCodebase", async () => {
      if (!ensureSupported()) {
        return;
      }
      try {
        const output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "triMemh scanning codebase" },
          () => client.scanCodebase(),
        );
        showCommandLog("triMemh scan", output);
        await refresh();
      } catch (error) {
        showCliError(error);
      }
    }),
  );

  if (getConfig().autoRefreshOnActiveEditorChange) {
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          void checkStale(relativeWorkspacePath(editor.document.uri));
        }
      }),
    );
  }

  void refresh();
}

export function deactivate(): void {}
