/**
 * Interactive TUI Dashboard (Phase 4 — Team & Scale)
 *
 * Terminal-based dashboard for managing tri-memory.
 * Features:
 * - Live memory stats (count by kind, status)
 * - Pending proposals with quick approve/reject
 * - Interactive search
 * - Recent audit events stream
 * - Memory graph ASCII visualization
 *
 * Navigation:
 *   ↑ ↓ — Navigate
 *   ← → — Switch panels
 *   Enter — Select/Confirm
 *   a/r — Approve/Reject selected proposal
 *   s — Search mode
 *   q — Quit
 *
 * Usage:
 *   bun run src/tui.ts
 *   trimemh tui
 */

import type { Database } from "bun:sqlite";

import { getMemoryCache } from "../infrastructure/cache";
import { getRateLimiter } from "../infrastructure/rate-limit";
import { approve, recall, reject, status } from "../service";

// ─── Types ──────────────────────────────────────────────────────────

interface TUIState {
  db: Database;
  projectId: string;
  screen: Screen;
  selectedIndex: number;
  searchQuery: string;
  searchResults: string[];
  message: string | null;
  running: boolean;
}

type Screen = "dashboard" | "proposals" | "search" | "audit";

// ─── Rendering ──────────────────────────────────────────────────────

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

function clear(): void {
  // biome-ignore lint/security/noSecrets: ANSI escape sequence to clear screen
  process.stdout.write("\x1b[2J\x1b[H");
}

function moveTo(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

function color(text: string, c: keyof typeof COLORS): string {
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

function drawBox(top: number, left: number, width: number, height: number, title: string): void {
  const hLine = "─".repeat(width - 2);
  moveTo(top, left);
  process.stdout.write(`┌${hLine}┐`);
  moveTo(top, left + 2);
  process.stdout.write(` ${color(title, "bold")} `);

  for (let i = 1; i < height - 1; i++) {
    moveTo(top + i, left);
    process.stdout.write("│");
    moveTo(top + i, left + width - 1);
    process.stdout.write("│");
  }

  moveTo(top + height - 1, left);
  process.stdout.write(`└${hLine}┘`);
}

function drawRow(row: number, col: number, text: string, selected = false): void {
  moveTo(row, col + 1);
  const display = text.slice(0, process.stdout.columns - col - 4);
  if (selected) {
    process.stdout.write(color(`▸ ${display}`, "cyan"));
  } else {
    process.stdout.write(`  ${color(display, "dim")}`);
  }
}

// ─── Dashboard screen ───────────────────────────────────────────────

function renderDashboard(state: TUIState): void {
  clear();
  const data = status(state.db, state.projectId);
  const cacheStats = getMemoryCache().stats();
  const _rateSnapshot = getRateLimiter().snapshot();
  const termWidth = Math.min(process.stdout.columns || 80, 120);

  // Header
  moveTo(1, 1);
  process.stdout.write(
    color(`  triMemh TUI — ${state.projectId.slice(0, 8)}`, "bold") +
      color(`  [${state.screen}]`, "dim") +
      color("  q:quit  ←→:panels  ↑↓:navigate", "dim"),
  );

  // Stats box (top-left)
  const statsBoxWidth = 35;
  drawBox(3, 1, statsBoxWidth, 12, "Memory Stats");
  let row = 4;
  drawRow(row++, 1, `${color("Total active:", "bold")} ${data.stats.total}`);
  drawRow(row++, 1, `${color("Pending proposals:", "bold")} ${data.stats.pendingProposals}`);
  drawRow(row++, 1, "");
  drawRow(row++, 1, color("By Kind:", "dim"));
  for (const [kind, count] of Object.entries(data.stats.byKind).slice(0, 5)) {
    drawRow(row++, 1, `  ${kind.padEnd(18)} ${count}`);
  }

  // Cache stats box (top-right)
  const cacheBoxWidth = 30;
  drawBox(3, statsBoxWidth + 2, cacheBoxWidth, 12, "Cache");
  row = 4;
  const hitRatePct = Math.round(cacheStats.hitRate * 100);
  drawRow(row++, statsBoxWidth + 2, `  Memory cache:  ${cacheStats.size}/${cacheStats.maxSize}`);
  drawRow(row++, statsBoxWidth + 2, `  Hit rate:      ${hitRatePct}%`);
  drawRow(row++, statsBoxWidth + 2, `  Hits: ${cacheStats.hits} | Misses: ${cacheStats.misses}`);

  // Pending proposals (middle)
  const proposalBoxWidth = termWidth - 2;
  drawBox(16, 1, proposalBoxWidth, 10, "Pending Proposals");
  row = 17;
  if (data.pendingProposals.length === 0) {
    drawRow(row, 1, color("  No pending proposals.", "dim"));
  } else {
    for (let i = 0; i < Math.min(data.pendingProposals.length, 7); i++) {
      const p = data.pendingProposals[i];
      if (!p) {
        continue;
      }
      const riskColor =
        p.risk_level === "critical" ? "red" : p.risk_level === "high" ? "yellow" : "green";
      const line = `${p.id.slice(0, 8)}  ${color(`[${p.risk_level}]`, riskColor)}  ${p.proposed_kind.padEnd(16)}  ${p.proposed_text.slice(0, 50)}`;
      drawRow(row + i, 1, line, state.screen === "proposals" && i === state.selectedIndex);
    }
  }

  // Recent audit events (bottom)
  drawBox(27, 1, proposalBoxWidth, 8, "Recent Audit Events");
  row = 28;
  const recentAudit = data.recentAudit.slice(0, 5);
  for (let i = 0; i < recentAudit.length; i++) {
    const e = recentAudit[i];
    if (!e) {
      continue;
    }
    const line = `${e.created_at.slice(11, 19)}  ${e.event_type.padEnd(24)}  ${e.actor.slice(0, 16)}`;
    drawRow(row + i, 1, line);
  }

  // Message bar
  if (state.message) {
    moveTo(process.stdout.rows || 24, 1);
    process.stdout.write(color(`  ${state.message}`, "yellow"));
  }
}

// ─── Proposals screen ───────────────────────────────────────────────

function renderProposals(state: TUIState): void {
  clear();
  const data = status(state.db, state.projectId);
  const termWidth = Math.min(process.stdout.columns || 80, 120);

  moveTo(1, 1);
  process.stdout.write(
    color("  Pending Proposals", "bold") + color("  a:approve  r:reject  q:back", "dim"),
  );

  let row = 3;
  for (let i = 0; i < data.pendingProposals.length; i++) {
    const p = data.pendingProposals[i];
    if (!p) {
      continue;
    }
    const selected = i === state.selectedIndex;
    const riskColor =
      p.risk_level === "critical" ? "red" : p.risk_level === "high" ? "yellow" : "green";

    moveTo(row++, 1);
    process.stdout.write(
      (selected ? color("▸ ", "cyan") : "  ") +
        `${p.id.slice(0, 8)}  ${color(`[${p.risk_level.padEnd(8)}]`, riskColor)}  ` +
        `${color(p.proposed_kind.padEnd(16), "bold")}  ${color(p.proposed_by.slice(0, 12), "dim")}`,
    );
    moveTo(row++, 3);
    process.stdout.write(
      color(p.proposed_text.slice(0, termWidth - 6), selected ? "white" : "dim"),
    );
    if (p.rationale) {
      moveTo(row++, 3);
      process.stdout.write(color(`Reason: ${p.rationale.slice(0, termWidth - 12)}`, "dim"));
    }
    row++; // blank line
  }

  if (data.pendingProposals.length === 0) {
    moveTo(3, 1);
    process.stdout.write(color("  No pending proposals.", "dim"));
  }

  if (state.message) {
    moveTo((process.stdout.rows || 24) - 1, 1);
    process.stdout.write(color(`  ${state.message}`, "yellow"));
  }
}

// ─── Search screen ──────────────────────────────────────────────────

function renderSearch(state: TUIState): void {
  clear();
  moveTo(1, 1);
  process.stdout.write(color("  Search Memories", "bold") + color("  Enter:search  q:back", "dim"));

  moveTo(3, 1);
  process.stdout.write(color(`  Query: `, "bold"));
  process.stdout.write(state.searchQuery || color("(type to search)", "dim"));
  process.stdout.write(" ");

  if (state.searchResults.length === 0 && state.searchQuery) {
    moveTo(5, 1);
    process.stdout.write(color(`  Searching "${state.searchQuery}"...`, "dim"));

    // Perform search
    const results = recall(state.db, state.projectId, state.searchQuery, 10);
    state.searchResults = results.map(
      (r) =>
        `[${r.item.id.slice(0, 8)}] ${color(r.item.kind, "green")} ${r.item.text.slice(0, 80)}`,
    );
  }

  let row = 5;
  for (let i = 0; i < state.searchResults.length; i++) {
    const selected = i === state.selectedIndex;
    const res = state.searchResults[i];
    if (res !== undefined) {
      drawRow(row++, 1, res, selected);
    }
  }

  if (state.message) {
    moveTo((process.stdout.rows || 24) - 1, 1);
    process.stdout.write(color(`  ${state.message}`, "yellow"));
  }
}

// ─── Main TUI loop ──────────────────────────────────────────────────

export async function startTUI(db: Database, projectId: string): Promise<void> {
  const state: TUIState = {
    db,
    projectId,
    screen: "dashboard",
    selectedIndex: 0,
    searchQuery: "",
    searchResults: [],
    message: null,
    running: true,
  };

  // Disable stdin buffering
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");

  // Hide cursor
  process.stdout.write("\x1b[?25l");

  const render = () => {
    switch (state.screen) {
      case "dashboard":
        renderDashboard(state);
        break;
      case "proposals":
        renderProposals(state);
        break;
      case "search":
        renderSearch(state);
        break;
    }
  };

  const handleKey = (key: string) => {
    // Clear message on any key
    state.message = null;

    switch (key) {
      case "\x03": // Ctrl+C
      case "q":
        if (state.screen === "search") {
          state.screen = "dashboard";
          state.searchQuery = "";
          state.searchResults = [];
        } else {
          state.running = false;
        }
        break;

      case "\x1b[A": // Up
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
        break;

      case "\x1b[B": // Down
        state.selectedIndex = Math.min(
          state.screen === "proposals"
            ? status(state.db, state.projectId).pendingProposals.length - 1
            : state.searchResults.length - 1,
          state.selectedIndex + 1,
        );
        break;

      case "\x1b[C": // Right arrow
        state.selectedIndex = 0;
        if (state.screen === "dashboard") {
          state.screen = "proposals";
        } else if (state.screen === "proposals") {
          state.screen = "search";
        }
        break;

      case "\x1b[D": // Left arrow
        state.selectedIndex = 0;
        if (state.screen === "search") {
          state.screen = "proposals";
        } else if (state.screen === "proposals") {
          state.screen = "dashboard";
        }
        break;

      case "a": // Approve selected proposal
        if (state.screen === "proposals") {
          try {
            const data = status(state.db, state.projectId);
            const proposal = data.pendingProposals[state.selectedIndex];
            if (proposal) {
              approve(state.db, state.projectId, proposal.id, "tui:user");
              state.message = `Approved proposal ${proposal.id.slice(0, 8)}`;
            }
          } catch (err) {
            state.message = `Error: ${(err as Error).message}`;
          }
        }
        break;

      case "r": // Reject selected proposal
        if (state.screen === "proposals") {
          try {
            const data = status(state.db, state.projectId);
            const proposal = data.pendingProposals[state.selectedIndex];
            if (proposal) {
              reject(state.db, state.projectId, proposal.id, "Rejected via TUI", "tui:user");
              state.message = `Rejected proposal ${proposal.id.slice(0, 8)}`;
            }
          } catch (err) {
            state.message = `Error: ${(err as Error).message}`;
          }
        }
        break;

      case "s": // Switch to search
        if (state.screen !== "search") {
          state.screen = "search";
          state.selectedIndex = 0;
          state.searchQuery = "";
          state.searchResults = [];
        }
        break;

      case "\x7f": // Backspace
        if (state.screen === "search") {
          state.searchQuery = state.searchQuery.slice(0, -1);
          state.searchResults = [];
        }
        break;

      case "\r": // Enter — confirm in search
        if (state.screen === "search" && state.searchQuery) {
          state.searchResults = [];
        }
        break;

      default:
        // Text input for search
        if (state.screen === "search" && key.length === 1 && key >= " ") {
          state.searchQuery += key;
          state.searchResults = [];
        }
        break;
    }
  };

  // Main loop
  render();

  for await (const chunk of process.stdin) {
    if (!state.running) {
      break;
    }
    const key = typeof chunk === "string" ? chunk : chunk.toString();
    handleKey(key);
    if (state.running) {
      render();
    }
  }

  // Cleanup
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h"); // Show cursor
  clear();
  process.stdout.write(color("\n  triMemh TUI closed.\n\n", "dim"));
}
