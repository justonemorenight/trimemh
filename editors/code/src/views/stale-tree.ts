import * as vscode from "vscode";

import type { StaleMemoryReport, StaleMemoryResult } from "../types";

export type StaleTreeNode = StaleGroupItem | StaleTreeItem;

const SEVERITIES: Array<StaleMemoryResult["severity"]> = ["high", "medium", "low"];

export class StaleGroupItem extends vscode.TreeItem {
  constructor(
    readonly severity: StaleMemoryResult["severity"],
    readonly children: StaleMemoryResult[],
  ) {
    super(`${severity} (${children.length})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "staleGroup";
    this.iconPath = new vscode.ThemeIcon(
      severity === "high" ? "error" : severity === "medium" ? "warning" : "info",
    );
  }
}

export class StaleTreeItem extends vscode.TreeItem {
  constructor(readonly finding: StaleMemoryResult) {
    const firstReason = finding.reasons[0];
    super(
      `${firstReason?.reason ?? "stale"}: ${finding.memory.text.slice(0, 70)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.id = `${finding.memory.id}:${firstReason?.reason ?? "stale"}`;
    this.description = `action=${finding.suggested_action}`;
    this.tooltip = [
      `Memory: ${finding.memory.id}`,
      `Severity: ${finding.severity}`,
      `Action: ${finding.suggested_action}`,
      "",
      ...finding.reasons.map((reason) => `${reason.reason}: ${reason.description}`),
      "",
      finding.memory.text,
    ].join("\n");
    this.contextValue = "staleFinding";
    this.iconPath = new vscode.ThemeIcon(
      finding.severity === "high" ? "error" : finding.severity === "medium" ? "warning" : "info",
    );
    this.command = {
      command: "trimemh.memory.showDetail",
      title: "Show Memory Detail",
      arguments: [this],
    };
  }
}

export class StaleTreeProvider implements vscode.TreeDataProvider<StaleTreeNode> {
  private readonly emitter = new vscode.EventEmitter<StaleTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private report?: StaleMemoryReport;

  setReport(report?: StaleMemoryReport): void {
    this.report = report;
    this.emitter.fire(undefined);
  }

  getReport(): StaleMemoryReport | undefined {
    return this.report;
  }

  getTreeItem(element: StaleTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StaleTreeNode): StaleTreeNode[] {
    if (element instanceof StaleGroupItem) {
      return element.children.map((finding) => new StaleTreeItem(finding));
    }
    const results = this.report?.results ?? [];
    return SEVERITIES.map((severity) => {
      const children = results.filter((finding) => finding.severity === severity);
      return children.length > 0 ? new StaleGroupItem(severity, children) : undefined;
    }).filter((item): item is StaleGroupItem => Boolean(item));
  }
}
