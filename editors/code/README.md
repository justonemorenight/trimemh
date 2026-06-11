# triMemh VS Code Extension

A visual VS Code UI for triMemh local-first project memory. It only enables full workflows for workspaces that are triMemh-enabled (`.trimemh`, memh commands, or an explicit `trimemh.dbPath`).

## Features

- Activity Bar container: **triMemh**
- Atlas webview with an interactive memory-code graph, stale overlay, and clickable nodes
- Dashboard webview with memory/proposal/stale summary
- Active memories tree grouped by kind
- Pending proposals tree with approve/reject actions
- Stale memory tree grouped by severity
- Diagnostics for stale memories in the current file
- Command Palette actions for search, context, scan, stale checks, remember/propose selection
- Status bar summary for memory and proposal counts

## Local development

From this folder:

```bash
bun install
bun run compile
```

For local repo development, configure VS Code settings:

```json
{
  "trimemh.command": "bun",
  "trimemh.args": ["run", "src/cli.ts"],
  "trimemh.defaultMemoryWriteMode": "propose"
}
```

Then launch the Extension Development Host with VS Code's **Run Extension** configuration or open this folder as an extension project and press `F5`.

## Key commands

- `triMemh: Refresh`
- `triMemh: Open Atlas`
- `triMemh: Focus Atlas on Current File`
- `triMemh: Search Memories`
- `triMemh: Remember Selection`
- `triMemh: Propose Selection`
- `triMemh: Show Current Context`
- `triMemh: Check Stale Memory for Current File`
- `triMemh: Check Stale Memory for Workspace`
- `triMemh: Scan Codebase`
- `triMemh: Show Log`

## Atlas workflow

Open a project file and run:

```text
triMemh: Focus Atlas on Current File
```

The extension calls:

```bash
trimemh atlas --path <current-file> --json
```

The Atlas view shows:

- code file/symbol nodes
- linked memory nodes
- memory-memory relationship edges
- affected code paths
- stale severity overlay
- a focused details panel when you click a node

Click code nodes to open files. Click memory nodes to open memory detail.

## Stale memory workflow

Open a project file and run:

```text
triMemh: Check Stale Memory for Current File
```

The extension calls:

```bash
trimemh lifecycle stale --path <current-file> --json
```

Findings appear in:

- the **Stale Memory** tree view
- VS Code diagnostics for the active file
- the **triMemh Details** output channel
- the Dashboard summary

The extension is report-first. It never archives, expires, or supersedes a memory without explicit user action.
