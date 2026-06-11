import * as vscode from "vscode";

import type { StaleMemoryReport, StaleMemoryResult } from "./types";

function diagnosticSeverity(severity: StaleMemoryResult["severity"]): vscode.DiagnosticSeverity {
  switch (severity) {
    case "high":
      return vscode.DiagnosticSeverity.Error;
    case "medium":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

export class StaleDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("triMemh stale memory");

  updateForDocument(uri: vscode.Uri, report: StaleMemoryReport): void {
    const diagnostics = report.results.flatMap((finding) =>
      finding.reasons.map((reason) => {
        const line = Math.max((reason.entity?.line_start ?? 1) - 1, 0);
        const range = new vscode.Range(line, 0, line, 1);
        const diagnostic = new vscode.Diagnostic(
          range,
          `triMemh stale memory: ${reason.reason} — ${reason.description}`,
          diagnosticSeverity(finding.severity),
        );
        diagnostic.source = "triMemh";
        diagnostic.code = finding.suggested_action;
        return diagnostic;
      }),
    );
    this.collection.set(uri, diagnostics);
  }

  clear(uri?: vscode.Uri): void {
    if (uri) {
      this.collection.delete(uri);
      return;
    }
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
