import * as vscode from "vscode";

import type { AtlasGraph } from "../types";

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

export class AtlasWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private graph?: AtlasGraph;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: { command?: string; payload?: unknown }) => {
      switch (message.command) {
        case "refreshAtlas":
          void vscode.commands.executeCommand("trimemh.atlas.refresh");
          break;
        case "focusCurrentFile":
          void vscode.commands.executeCommand("trimemh.focusAtlasOnCurrentFile");
          break;
        case "checkStale":
          void vscode.commands.executeCommand("trimemh.checkStale");
          break;
        case "showMemory":
          void vscode.commands.executeCommand("trimemh.memory.showDetail", message.payload);
          break;
        case "openFile":
          void vscode.commands.executeCommand("trimemh.atlas.openFile", message.payload);
          break;
      }
    });
    this.render();
  }

  setGraph(graph?: AtlasGraph): void {
    this.graph = graph;
    this.render();
  }

  reveal(): void {
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    const scriptNonce = nonce();
    const graphJson = JSON.stringify(this.graph ?? null).replace(/</g, "\\u003c");
    const summary = this.graph
      ? `${this.graph.summary.node_count} nodes · ${this.graph.summary.edge_count} edges · ${this.graph.summary.stale_count} stale`
      : "No atlas graph loaded";
    this.view.webview.html = `<!doctype html>
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
  .app {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 100vh;
  }
  .toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    align-items: center;
    padding: 8px;
    border-bottom: 1px solid var(--line);
    background: var(--surface);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  button {
    min-height: 30px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    padding: 5px 8px;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
  }
  button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button:focus-visible,
  input:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }
  button:active {
    transform: translateY(1px);
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .summary {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wrap {
    display: grid;
    grid-template-columns: minmax(280px, 1fr) minmax(220px, 300px);
    min-height: 0;
  }
  .canvas {
    position: relative;
    min-height: 360px;
    background:
      radial-gradient(circle at 50% 48%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 44%),
      var(--bg);
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 360px;
  }
  .panel {
    min-width: 0;
    overflow: auto;
    border-left: 1px solid var(--line);
    background: var(--surface);
  }
  .panel-inner {
    padding: 12px;
  }
  h2,
  h3,
  p,
  pre {
    margin: 0;
  }
  h2 {
    font-size: 11px;
    font-weight: 650;
    letter-spacing: .04em;
    text-transform: uppercase;
  }
  h3 {
    overflow-wrap: anywhere;
    font-size: 14px;
    line-height: 1.25;
  }
  .muted {
    color: var(--muted);
  }
  .detail-block {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }
  .kv {
    display: grid;
    grid-template-columns: 64px minmax(0, 1fr);
    gap: 6px;
    margin-top: 7px;
    font-size: 12px;
  }
  .kv span:first-child {
    color: var(--muted);
  }
  .kv span:last-child {
    overflow-wrap: anywhere;
  }
  pre {
    max-height: 220px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 9px;
    background: var(--surface-soft);
    color: var(--text);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .detail-actions {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
    gap: 6px;
    margin-top: 10px;
  }
  .edge {
    stroke: var(--muted);
    stroke-opacity: .44;
    fill: none;
  }
  .edge.memory_memory {
    stroke-dasharray: 5 4;
  }
  .edge.affected_path {
    stroke-opacity: .28;
  }
  .node {
    cursor: pointer;
  }
  .node-shape {
    transition: stroke-width .12s ease, fill-opacity .12s ease;
  }
  .node:hover .node-shape,
  .node.selected .node-shape {
    fill-opacity: .28;
    stroke-width: 4;
  }
  .label {
    fill: var(--text);
    font-size: 11px;
    pointer-events: none;
  }
  .badge {
    fill: var(--danger);
    font-size: 13px;
    font-weight: 700;
    pointer-events: none;
  }
  .empty {
    display: grid;
    place-items: center;
    min-height: 360px;
    padding: 20px;
    color: var(--muted);
    text-align: center;
  }
  .empty strong {
    display: block;
    margin-bottom: 4px;
    color: var(--text);
    font-size: 14px;
  }
  @media (max-width: 620px) {
    .toolbar {
      grid-template-columns: 1fr;
    }
    .summary {
      text-align: left;
    }
    .wrap {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(320px, 56vh) auto;
    }
    .panel {
      border-left: 0;
      border-top: 1px solid var(--line);
    }
    .canvas,
    svg,
    .empty {
      min-height: 320px;
    }
  }
</style>
</head>
<body>
  <main class="app">
    <header class="toolbar">
      <div class="actions">
        <button class="primary" type="button" data-command="focusCurrentFile">Focus file</button>
        <button type="button" data-command="refreshAtlas">Refresh</button>
        <button type="button" data-command="checkStale">Check stale</button>
        <label class="toggle"><input id="staleOnly" type="checkbox" /> Stale only</label>
      </div>
      <div class="summary">${escapeHtml(summary)}</div>
    </header>
    <section class="wrap">
      <div class="canvas">
        <svg id="graph" viewBox="0 0 1000 700" role="img" aria-label="triMemh memory atlas"></svg>
      </div>
      <aside class="panel">
        <div class="panel-inner">
          <h2>Focus</h2>
          <div id="details" class="detail-block muted">Select a node</div>
        </div>
      </aside>
    </section>
  </main>
<script nonce="${scriptNonce}">
const vscode = acquireVsCodeApi();
const graph = ${graphJson};
const svg = document.getElementById('graph');
const details = document.getElementById('details');
const staleOnly = document.getElementById('staleOnly');
let selectedId = null;

document.querySelectorAll('button[data-command]').forEach((button) => {
  button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
});
staleOnly.addEventListener('change', render);

function color(node) {
  if (node.severity === 'high') return '#f85149';
  if (node.severity === 'medium') return '#d29922';
  if (node.severity === 'low') return '#58a6ff';
  if (node.kind === 'memory') return '#4ec97f';
  if (node.kind === 'file') return '#58a6ff';
  return '#9fb7ff';
}

function layout(nodes) {
  const code = nodes.filter((node) => node.kind !== 'memory');
  const memories = nodes.filter((node) => node.kind === 'memory');
  const positioned = new Map();
  const center = { x: 500, y: 330 };
  code.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(code.length, 1) - Math.PI / 2;
    const radius = code.length <= 1 ? 0 : Math.min(210, 110 + code.length * 16);
    positioned.set(node.id, { ...node, x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  });
  memories.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(memories.length, 1) + Math.PI / 2;
    const radius = memories.length <= 2 ? 265 : 310;
    positioned.set(node.id, { ...node, x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  });
  return positioned;
}

function showDetails(node) {
  selectedId = node.id;
  const lines = [];
  lines.push('<h3>' + escapeValue(node.label) + '</h3>');
  lines.push('<div class="kv"><span>Kind</span><span>' + escapeValue(node.kind) + '</span></div>');
  if (node.path) lines.push('<div class="kv"><span>Path</span><span>' + escapeValue(node.path) + '</span></div>');
  if (node.symbol) lines.push('<div class="kv"><span>Symbol</span><span>' + escapeValue(node.symbol) + '</span></div>');
  if (node.severity) lines.push('<div class="kv"><span>Stale</span><span>' + escapeValue(node.severity) + ' · ' + escapeValue((node.staleReasons || []).join(', ')) + '</span></div>');
  if (node.memory) lines.push('<div class="detail-block"><h2>Memory</h2><pre>' + escapeValue(node.memory.text) + '</pre></div>');
  const actions = [];
  if (node.memory) actions.push('<button class="primary" id="showMemory" type="button">Memory detail</button>');
  if (node.path) actions.push('<button id="openFile" type="button">Open file</button>');
  if (actions.length) lines.push('<div class="detail-actions">' + actions.join('') + '</div>');
  details.classList.remove('muted');
  details.innerHTML = lines.join('');
  document.getElementById('showMemory')?.addEventListener('click', () => vscode.postMessage({ command: 'showMemory', payload: node.memory }));
  document.getElementById('openFile')?.addEventListener('click', () => vscode.postMessage({ command: 'openFile', payload: { path: node.path, line: node.entity?.line_start } }));
  render();
}

function escapeValue(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderEmpty() {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
  group.setAttribute('x', '250');
  group.setAttribute('y', '245');
  group.setAttribute('width', '500');
  group.setAttribute('height', '170');
  const container = document.createElement('div');
  container.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  container.setAttribute('class', 'empty');
  container.innerHTML = '<div><strong>Atlas is empty</strong><span>Focus the current file to map linked memories.</span></div>';
  group.appendChild(container);
  svg.appendChild(group);
}

function render() {
  svg.innerHTML = '';
  if (!graph || !graph.nodes?.length) {
    renderEmpty();
    return;
  }
  const baseNodes = staleOnly.checked ? graph.nodes.filter((node) => node.severity) : graph.nodes;
  if (!baseNodes.length) {
    renderEmpty();
    return;
  }
  const nodeIds = new Set(baseNodes.map((node) => node.id));
  const positioned = layout(baseNodes);
  for (const edge of graph.edges.filter((item) => nodeIds.has(item.source) && nodeIds.has(item.target))) {
    const source = positioned.get(edge.source);
    const target = positioned.get(edge.target);
    if (!source || !target) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', source.x);
    line.setAttribute('y1', source.y);
    line.setAttribute('x2', target.x);
    line.setAttribute('y2', target.y);
    line.setAttribute('class', 'edge ' + edge.kind);
    svg.appendChild(line);
  }
  for (const node of positioned.values()) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', 'node' + (node.id === selectedId ? ' selected' : ''));
    group.addEventListener('click', () => showDetails(node));
    const isMemory = node.kind === 'memory';
    const shape = document.createElementNS('http://www.w3.org/2000/svg', isMemory ? 'circle' : 'rect');
    shape.setAttribute('class', 'node-shape');
    if (isMemory) {
      shape.setAttribute('cx', node.x);
      shape.setAttribute('cy', node.y);
      shape.setAttribute('r', 35);
    } else {
      shape.setAttribute('x', node.x - 58);
      shape.setAttribute('y', node.y - 24);
      shape.setAttribute('width', 116);
      shape.setAttribute('height', 48);
      shape.setAttribute('rx', 8);
    }
    shape.setAttribute('fill', color(node));
    shape.setAttribute('fill-opacity', '.16');
    shape.setAttribute('stroke', color(node));
    shape.setAttribute('stroke-width', node.severity ? '3' : '2');
    group.appendChild(shape);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', node.x);
    label.setAttribute('y', node.y + (isMemory ? 51 : 39));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'label');
    label.textContent = node.label.length > 28 ? node.label.slice(0, 27) + '...' : node.label;
    group.appendChild(label);

    if (node.severity) {
      const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badge.setAttribute('x', node.x + 27);
      badge.setAttribute('y', node.y - 27);
      badge.setAttribute('class', 'badge');
      badge.textContent = '!';
      group.appendChild(badge);
    }
    svg.appendChild(group);
  }
}
render();
</script>
</body>
</html>`;
  }
}
