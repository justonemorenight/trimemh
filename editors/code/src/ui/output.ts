import * as vscode from "vscode";

import type { MemoryItem, StaleMemoryReport } from "../types";

let contextChannel: vscode.OutputChannel | undefined;
let logChannel: vscode.OutputChannel | undefined;
let detailChannel: vscode.OutputChannel | undefined;

export function showContextOutput(xml: string, diagnostics: unknown): void {
  contextChannel ??= vscode.window.createOutputChannel("triMemh Context");
  contextChannel.clear();
  contextChannel.appendLine(xml);
  contextChannel.appendLine("");
  contextChannel.appendLine("<!-- memh_runtime");
  contextChannel.appendLine(JSON.stringify(diagnostics, null, 2));
  contextChannel.appendLine("-->");
  contextChannel.show(true);
}

export function showMemoryDetail(memory: MemoryItem): void {
  detailChannel ??= vscode.window.createOutputChannel("triMemh Details");
  detailChannel.clear();
  detailChannel.appendLine(`Memory ${memory.id}`);
  detailChannel.appendLine("────────────────────────────────────────");
  detailChannel.appendLine(`Kind: ${memory.kind}`);
  detailChannel.appendLine(`Status: ${memory.status ?? "unknown"}`);
  detailChannel.appendLine(`Confidence: ${memory.confidence ?? "unknown"}`);
  detailChannel.appendLine(`Source: ${memory.source ?? "unknown"}`);
  detailChannel.appendLine(`Created: ${memory.created_at ?? "unknown"}`);
  detailChannel.appendLine("");
  detailChannel.appendLine(memory.text);
  detailChannel.show(true);
}

export function showStaleReport(report: StaleMemoryReport): void {
  detailChannel ??= vscode.window.createOutputChannel("triMemh Details");
  detailChannel.clear();
  detailChannel.appendLine("Stale Memory Report");
  detailChannel.appendLine("────────────────────────────────────────");
  detailChannel.appendLine(
    `${report.summary.flagged_memory_count}/${report.summary.checked_memory_count} flagged ` +
      `(high=${report.summary.high_count}, medium=${report.summary.medium_count}, low=${report.summary.low_count})`,
  );
  for (const finding of report.results) {
    detailChannel.appendLine("");
    detailChannel.appendLine(
      `[${finding.severity}] ${finding.memory.kind} ${finding.memory.id} action=${finding.suggested_action}`,
    );
    detailChannel.appendLine(finding.memory.text);
    for (const reason of finding.reasons) {
      detailChannel.appendLine(`- ${reason.reason}: ${reason.description}`);
    }
  }
  detailChannel.show(true);
}

export function showCommandLog(title: string, text: string): void {
  logChannel ??= vscode.window.createOutputChannel("triMemh");
  logChannel.appendLine("");
  logChannel.appendLine(title);
  logChannel.appendLine("────────────────────────────────────────");
  logChannel.appendLine(text);
  logChannel.show(true);
}

export function log(message: string): void {
  logChannel ??= vscode.window.createOutputChannel("triMemh");
  logChannel.appendLine(message);
}

export function showLog(): void {
  logChannel ??= vscode.window.createOutputChannel("triMemh");
  logChannel.show(true);
}
