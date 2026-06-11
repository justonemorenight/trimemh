import * as vscode from "vscode";

import type { MemoryProposal, StaleMemoryReport, TriMemhStatus } from "../types";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 24 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function compactId(value?: string): string {
  if (!value) {
    return "unknown";
  }
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function relativeTime(value?: string): string {
  if (!value) {
    return "not checked";
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  const delta = Date.now() - timestamp;
  if (delta < 60_000) {
    return "just now";
  }
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function renderAction(command: string, label: string, variant: "primary" | "secondary" = "secondary"): string {
  return `<button class="${variant}" type="button" data-command="${escapeHtml(command)}">${escapeHtml(label)}</button>`;
}

function renderKindRows(byKind: Record<string, number> | undefined): string {
  const entries = Object.entries(byKind ?? {}).sort(([, left], [, right]) => right - left);
  if (entries.length === 0) {
    return `<div class="empty">No memory kinds yet</div>`;
  }
  const max = Math.max(...entries.map(([, count]) => count), 1);
  return entries
    .map(([kind, count]) => {
      const width = Math.max(8, Math.round((count / max) * 100));
      return `<div class="kind-row">
        <div class="kind-meta">
          <span>${escapeHtml(kind)}</span>
          <strong>${count}</strong>
        </div>
        <div class="bar" aria-hidden="true"><span style="width:${width}%"></span></div>
      </div>`;
    })
    .join("");
}

function renderProposalList(proposals: MemoryProposal[] | undefined): string {
  const pending = proposals ?? [];
  if (pending.length === 0) {
    return `<div class="empty">No pending proposals</div>`;
  }
  return pending
    .slice(0, 4)
    .map((proposal) => {
      const kind = proposal.proposed_kind ?? "memory";
      const risk = proposal.risk_level ?? "risk unknown";
      const text = proposal.proposed_text.length > 96 ? `${proposal.proposed_text.slice(0, 93)}...` : proposal.proposed_text;
      return `<div class="proposal">
        <div>
          <span class="eyebrow">${escapeHtml(kind)} · ${escapeHtml(risk)}</span>
          <p>${escapeHtml(text)}</p>
        </div>
      </div>`;
    })
    .join("");
}

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private status?: TriMemhStatus;
  private staleReport?: StaleMemoryReport;
  private unsupported = false;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: { command?: string }) => {
      if (message.command) {
        void vscode.commands.executeCommand(message.command);
      }
    });
    this.render();
  }

  update(status?: TriMemhStatus, staleReport?: StaleMemoryReport): void {
    this.unsupported = false;
    this.status = status ?? this.status;
    this.staleReport = staleReport ?? this.staleReport;
    this.render();
  }

  showUnsupported(): void {
    this.unsupported = true;
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.unsupported ? this.renderUnsupported() : this.renderDashboard();
  }

  private renderUnsupported(): string {
    const scriptNonce = nonce();
    return this.renderShell(
      scriptNonce,
      `<main class="shell state-shell">
        <section class="hero">
          <div class="brand">
            <span class="mark"></span>
            <div>
              <h1>triMemh</h1>
              <p>Workspace not initialized</p>
            </div>
          </div>
        </section>
        <section class="panel">
          <h2>Setup</h2>
          <p class="copy">Open a triMemh-enabled workspace or configure a database path in VS Code settings.</p>
          <div class="command-grid">
            ${renderAction("trimemh.showLog", "Open logs")}
            ${renderAction("trimemh.refresh", "Retry", "primary")}
          </div>
        </section>
      </main>`,
    );
  }

  private renderDashboard(): string {
    const status = this.status;
    const stats = status?.stats;
    const stale = this.staleReport?.summary;
    const pending = status?.pendingProposals?.length ?? stats?.pendingProposals ?? 0;
    const staleCount = stale?.flagged_memory_count ?? 0;
    const highCount = stale?.high_count ?? 0;
    const health = highCount > 0 ? "attention" : staleCount > 0 ? "review" : "clean";
    const healthLabel = highCount > 0 ? "High stale risk" : staleCount > 0 ? "Review stale memory" : "Memory graph clean";
    const scriptNonce = nonce();

    return this.renderShell(
      scriptNonce,
      `<main class="shell">
        <section class="hero">
          <div class="brand">
            <span class="mark"></span>
            <div>
              <h1>triMemh</h1>
              <p>${escapeHtml(healthLabel)}</p>
            </div>
          </div>
          <span class="status-pill ${health}">${escapeHtml(health)}</span>
        </section>

        <section class="identity">
          <div>
            <span class="label">Project</span>
            <strong title="${escapeHtml(status?.project_id ?? "unknown")}">${escapeHtml(compactId(status?.project_id))}</strong>
          </div>
          <div>
            <span class="label">Database</span>
            <strong title="${escapeHtml(status?.db_path ?? "default")}">${escapeHtml(status?.db_path ? "configured" : "default")}</strong>
          </div>
        </section>

        <section class="metric-grid" aria-label="triMemh status">
          <article class="metric">
            <span>Memories</span>
            <strong>${stats?.total ?? 0}</strong>
          </article>
          <article class="metric ${pending > 0 ? "warn" : ""}">
            <span>Pending</span>
            <strong>${pending}</strong>
          </article>
          <article class="metric ${staleCount > 0 ? "warn" : ""}">
            <span>Stale</span>
            <strong>${staleCount}</strong>
          </article>
          <article class="metric ${highCount > 0 ? "danger" : ""}">
            <span>High</span>
            <strong>${highCount}</strong>
          </article>
        </section>

        <section class="panel command-panel">
          <div class="section-head">
            <h2>Actions</h2>
            <span>${escapeHtml(relativeTime(this.staleReport?.checked_at))}</span>
          </div>
          <div class="command-grid primary-actions">
            ${renderAction("trimemh.refresh", "Refresh", "primary")}
            ${renderAction("trimemh.searchMemories", "Search")}
            ${renderAction("trimemh.openAtlas", "Atlas")}
          </div>
          <div class="command-grid">
            ${renderAction("trimemh.proposeSelection", "Propose")}
            ${renderAction("trimemh.rememberSelection", "Remember")}
            ${renderAction("trimemh.checkStale", "Check file")}
            ${renderAction("trimemh.checkStaleWorkspace", "Check workspace")}
            ${renderAction("trimemh.scanCodebase", "Scan codebase")}
            ${renderAction("trimemh.showCurrentContext", "Context")}
            ${renderAction("trimemh.showLog", "Logs")}
          </div>
        </section>

        <section class="panel">
          <div class="section-head">
            <h2>Memory Kinds</h2>
            <span>${stats?.total ?? 0} total</span>
          </div>
          <div class="kind-list">${renderKindRows(stats?.byKind)}</div>
        </section>

        <section class="panel split-panel">
          <div>
            <div class="section-head">
              <h2>Stale</h2>
              <span>${stale?.checked_memory_count ?? 0} checked</span>
            </div>
            <div class="severity-row">
              <span class="severity high">${stale?.high_count ?? 0} high</span>
              <span class="severity medium">${stale?.medium_count ?? 0} medium</span>
              <span class="severity low">${stale?.low_count ?? 0} low</span>
            </div>
          </div>
          <div>
            <div class="section-head">
              <h2>Proposals</h2>
              <span>${pending} open</span>
            </div>
            <div class="proposal-list">${renderProposalList(status?.pendingProposals)}</div>
          </div>
        </section>
      </main>`,
    );
  }

  private renderShell(scriptNonce: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
<style>
  :root {
    --bg: var(--vscode-sideBar-background);
    --surface: var(--vscode-editor-background);
    --surface-soft: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background));
    --line: var(--vscode-panel-border);
    --text: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground);
    --accent: var(--vscode-focusBorder);
    --danger: var(--vscode-errorForeground);
    --warn: var(--vscode-editorWarning-foreground);
    --radius: 8px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    color: var(--text);
    background: var(--bg);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.4;
  }
  .shell {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    padding: 10px;
  }
  .hero,
  .identity,
  .panel,
  .metric {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .hero {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 11px;
  }
  .brand {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 9px;
  }
  .mark {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 7px;
    background:
      radial-gradient(circle at 50% 18%, color-mix(in srgb, var(--accent) 70%, transparent), transparent 28%),
      linear-gradient(145deg, color-mix(in srgb, var(--accent) 34%, var(--surface)), var(--surface));
    border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--line));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 8%, transparent);
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  h1 {
    font-size: 14px;
    font-weight: 650;
    letter-spacing: 0;
  }
  h2 {
    font-size: 11px;
    font-weight: 650;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .brand p,
  .section-head span,
  .label,
  .empty,
  .eyebrow,
  .copy {
    color: var(--muted);
  }
  .brand p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 32ch;
    font-size: 12px;
  }
  .status-pill {
    flex: 0 0 auto;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 7px;
    color: var(--muted);
    font-size: 11px;
    text-transform: capitalize;
  }
  .status-pill.clean { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .status-pill.review { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .status-pill.attention { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
  .identity {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    overflow: hidden;
  }
  .identity > div {
    min-width: 0;
    padding: 9px 10px;
  }
  .identity > div + div {
    border-left: 1px solid var(--line);
  }
  .label {
    display: block;
    margin-bottom: 3px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .identity strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    font-weight: 600;
  }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }
  .metric {
    min-width: 0;
    padding: 9px;
  }
  .metric span {
    display: block;
    color: var(--muted);
    font-size: 11px;
  }
  .metric strong {
    display: block;
    margin-top: 4px;
    font-size: 20px;
    line-height: 1;
    font-weight: 700;
  }
  .metric.warn strong { color: var(--warn); }
  .metric.danger strong { color: var(--danger); }
  .panel {
    padding: 10px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 9px;
  }
  .section-head span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .command-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(92px, 1fr));
    gap: 6px;
  }
  .primary-actions {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-bottom: 8px;
  }
  button {
    min-width: 0;
    min-height: 30px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    padding: 5px 8px;
    overflow: hidden;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    font: inherit;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }
  button:active {
    transform: translateY(1px);
  }
  button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .kind-list,
  .proposal-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .kind-meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 12px;
  }
  .kind-meta span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kind-meta strong {
    font-family: var(--vscode-editor-font-family);
  }
  .bar {
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-soft);
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
  }
  .split-panel {
    display: grid;
    grid-template-columns: minmax(0, .82fr) minmax(0, 1.18fr);
    gap: 12px;
  }
  .severity-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .severity {
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 3px 7px;
    font-size: 11px;
  }
  .severity.high { color: var(--danger); }
  .severity.medium { color: var(--warn); }
  .severity.low { color: var(--accent); }
  .proposal {
    border-top: 1px solid var(--line);
    padding-top: 8px;
  }
  .proposal:first-child {
    border-top: 0;
    padding-top: 0;
  }
  .proposal p {
    margin-top: 2px;
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-size: 12px;
  }
  .eyebrow {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  .empty,
  .copy {
    font-size: 12px;
  }
  .state-shell {
    min-height: 100vh;
    justify-content: center;
  }
  @media (max-width: 360px) {
    .metric-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .primary-actions,
    .split-panel,
    .identity {
      grid-template-columns: 1fr;
    }
    .identity > div + div {
      border-left: 0;
      border-top: 1px solid var(--line);
    }
    .hero {
      align-items: flex-start;
      flex-direction: column;
    }
    .status-pill {
      align-self: flex-start;
    }
  }
</style>
</head>
<body>
${body}
<script nonce="${scriptNonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('button[data-command]').forEach((button) => {
    button.addEventListener('click', () => {
      vscode.postMessage({ command: button.dataset.command });
    });
  });
</script>
</body>
</html>`;
  }
}
