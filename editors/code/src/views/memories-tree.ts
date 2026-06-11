import * as vscode from "vscode";

import type { MemoryItem } from "../types";

export type MemoryTreeNode = MemoryGroupItem | MemoryTreeItem;

export class MemoryGroupItem extends vscode.TreeItem {
  constructor(
    readonly kind: string,
    readonly children: MemoryItem[],
  ) {
    super(`${kind} (${children.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "memoryGroup";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class MemoryTreeItem extends vscode.TreeItem {
  constructor(readonly memory: MemoryItem) {
    super(memory.text.slice(0, 80), vscode.TreeItemCollapsibleState.None);
    this.id = memory.id;
    this.description = `${memory.confidence ?? "?"} · ${memory.status ?? "active"}`;
    this.tooltip = [
      `ID: ${memory.id}`,
      `Kind: ${memory.kind}`,
      `Confidence: ${memory.confidence ?? "unknown"}`,
      `Source: ${memory.source ?? "unknown"}`,
      "",
      memory.text,
    ].join("\n");
    this.contextValue = "memoryItem";
    this.iconPath = new vscode.ThemeIcon("symbol-string");
    this.command = {
      command: "trimemh.memory.showDetail",
      title: "Show Memory Detail",
      arguments: [this],
    };
  }
}

export class MemoriesTreeProvider implements vscode.TreeDataProvider<MemoryTreeNode> {
  private readonly emitter = new vscode.EventEmitter<MemoryTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private memories: MemoryItem[] = [];

  setMemories(memories: MemoryItem[]): void {
    this.memories = memories;
    this.emitter.fire(undefined);
  }

  getMemory(id: string): MemoryItem | undefined {
    return this.memories.find((memory) => memory.id === id);
  }

  getTreeItem(element: MemoryTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: MemoryTreeNode): MemoryTreeNode[] {
    if (element instanceof MemoryGroupItem) {
      return element.children.map((memory) => new MemoryTreeItem(memory));
    }
    const byKind = new Map<string, MemoryItem[]>();
    for (const memory of this.memories) {
      const bucket = byKind.get(memory.kind) ?? [];
      bucket.push(memory);
      byKind.set(memory.kind, bucket);
    }
    return [...byKind.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, children]) => new MemoryGroupItem(kind, children));
  }
}
