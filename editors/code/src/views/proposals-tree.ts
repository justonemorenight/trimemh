import * as vscode from "vscode";

import type { MemoryProposal } from "../types";

export class ProposalTreeItem extends vscode.TreeItem {
  constructor(readonly proposal: MemoryProposal) {
    super(
      `${proposal.proposed_kind ?? "memory"}: ${proposal.proposed_text.slice(0, 60)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    this.id = proposal.id;
    this.description = `${proposal.risk_level ?? "risk?"} · ${proposal.proposed_by ?? "unknown"}`;
    this.tooltip = [
      `ID: ${proposal.id}`,
      `Action: ${proposal.action ?? "create"}`,
      `Kind: ${proposal.proposed_kind ?? "unknown"}`,
      `Risk: ${proposal.risk_level ?? "unknown"}`,
      `Rationale: ${proposal.rationale ?? "none"}`,
      "",
      proposal.proposed_text,
    ].join("\n");
    this.contextValue = "pendingProposal";
    this.iconPath = new vscode.ThemeIcon("git-pull-request");
  }
}

export class ProposalsTreeProvider implements vscode.TreeDataProvider<ProposalTreeItem> {
  private readonly emitter = new vscode.EventEmitter<ProposalTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private proposals: MemoryProposal[] = [];

  setProposals(proposals: MemoryProposal[]): void {
    this.proposals = proposals;
    this.emitter.fire(undefined);
  }

  getProposal(id: string): MemoryProposal | undefined {
    return this.proposals.find((proposal) => proposal.id === id);
  }

  getTreeItem(element: ProposalTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ProposalTreeItem[] {
    return this.proposals.map((proposal) => new ProposalTreeItem(proposal));
  }
}
