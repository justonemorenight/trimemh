import * as vscode from "vscode";

let contextChannel: vscode.OutputChannel | undefined;
let logChannel: vscode.OutputChannel | undefined;

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

export function log(message: string): void {
  logChannel ??= vscode.window.createOutputChannel("triMemh");
  logChannel.appendLine(message);
}

export function showLog(): void {
  logChannel ??= vscode.window.createOutputChannel("triMemh");
  logChannel.show(true);
}
