import * as vscode from "vscode";

import type { TriMemhStatus } from "../types";

export class TriMemhStatusBar {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor() {
    this.item.command = "trimemh.refresh";
    this.item.text = "triMemh: idle";
    this.item.tooltip = "Refresh triMemh status";
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  loading(): void {
    this.item.text = "$(sync~spin) triMemh";
  }

  connected(status: TriMemhStatus): void {
    const memories = status.stats?.total ?? 0;
    const proposals = status.pendingProposals?.length ?? status.stats?.pendingProposals ?? 0;
    this.item.text = `triMemh: ${memories} memories · ${proposals} proposals`;
    this.item.tooltip = status.project_id ? `Project: ${status.project_id}` : "triMemh connected";
  }

  error(): void {
    this.item.text = "$(warning) triMemh: error";
  }
}
