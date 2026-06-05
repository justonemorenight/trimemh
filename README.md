<p align="center">
  <img src="https://img.shields.io/badge/bun-%3E%3D1.0.0-f9f1e4?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/tests-299%20pass-success" alt="Tests">
  <img src="https://img.shields.io/badge/compression-93%25-brightgreen" alt="Compression">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/local--first-100%25-orange" alt="Local-first">
</p>

<p align="center">
  <h1 align="center">🧠 triMemh</h1>
  <h3 align="center">Local-First Governance-First Agent Memory System</h3>
</p>

---

## Why triMemh?

AI coding agents generate enormous amounts of context. Every tool call, every file read, every search result — it all competes for limited context window space. As your project grows, your agent forgets. It repeats mistakes. It loses track of decisions made last session.

**triMemh** solves this by giving agents a persistent, compressed, self-improving memory that lives on your machine.

- **93% fewer tokens** in the context window — proven across real-world scenarios
- **Zero cloud dependencies** — everything runs locally on SQLite + Bun
- **Governance-first** — every memory change goes through approval flows
- **Cross-agent** — share knowledge between Claude Code, Cursor, Codex, Copilot CLI, and Aider
- **Self-improving** — agents rate memory usefulness; the system learns what matters

## Quick Start

```bash
# Install globally (requires Bun >= 1.0.0)
bun install -g trimemh

# Auto-detect your AI agents and install
trimemh install
```

Restart your agent and ask: *"search memories about authentication"*

### Choose your agent

```bash
trimemh install --target claude      # Claude Code
trimemh install --target cursor      # Cursor IDE
trimemh install --target codex       # OpenAI Codex CLI
trimemh install --target copilot     # GitHub Copilot CLI
trimemh install --target aider       # Aider AI
trimemh install --all                # All detected agents
```

## How It Works

Every time your agent requests context, triMemh runs a compression pipeline before the data reaches the LLM:

```
Agent query
  │
  ├─ 1. ContentRouter
  │   Detects what kind of content this is:
  │   code · log · json · config · diff · prose
  │
  ├─ 2. Type-specific compression
  │   Code → TypeScript AST (tree-sitter): signatures only, bodies deferred
  │   Logs → Variable normalization + pattern grouping + dedup
  │   JSON → Schema-only: keys & types, values stripped
  │   Config → Key names only
  │   Diff → File names + change counts
  │   Prose → CCR: 3-level sentence-based reversible compression
  │
  ├─ 3. CacheAligner
  │   Fixed XML skeleton ensures KV-cache hits across turns.
  │   Stable prefix → provider caches stay warm.
  │
  └─ 4. CCR (Context Compression with Retrieval)
      Compressed content goes to the LLM.
      Originals stored locally. Agent can fetch full text on demand
      via memory_retrieve("trimemh:<id>").
```

### Memory Lifecycle

```
                  ┌─────────────┐
                  │   Propose   │  Agent suggests a memory
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │  Governance  │  RBAC + risk check + dedup
                  └──────┬──────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         auto-approve  pending   rejected
              │          │
              ▼          ▼
         ┌────────┐ ┌────────┐
         │ Active │ │ Review │  User approves via CLI
         └────┬───┘ └────┬───┘
              │          │
              └──────────┘
                     │
              ┌──────▼──────┐
              │  Feedback   │  Agent rates usefulness
              └──────┬──────┘
                     │
              ┌──────▼──────┐
              │  Scoring    │  9-factor Engram model
              │  improves   │  weights future retrieval
              └─────────────┘
```

## Performance

Benchmarked against [headroom](https://github.com/chopratejas/headroom) (the leading context compression system) using realistic simulated workloads:

| Scenario | Raw Tokens | Compressed | **triMemh** | headroom | vs headroom |
|---|---|---|---|---|---|
| **Code Search** (100 results) | 7.1K | 85 | **99%** | 92% | 🟢 +7% |
| **SRE Incident** (800 log lines) | 31.8K | 1.8K | **94%** | 92% | 🟢 +2% |
| **Issue Triage** (bug report + code + logs) | 1.5K | 435 | **72%** | 73% | ≈ parity |
| **Codebase Exploration** (config + source + diff) | 1.5K | 479 | **68%** | 47% | 🟢 +21% |
| **Architecture Discussion** (prose-heavy) | 1.4K | 113 | **92%** | — | — |
| **TOTAL** | 43.3K | 2.9K | **93%** | — | — |

```bash
# Run the benchmark yourself
bun run scripts/benchmark.ts
```

### Content Type Detection Accuracy

All 6 content types achieve optimal auto-detection:

| Type | Auto | Optimal | Status |
|---|---|---|---|
| Structured Data (JSON) | 99% | 99% | ✓ |
| Application Logs | 94% | 94% | ✓ |
| Code Diffs | 95% | 95% | ✓ |
| Natural Language | 87% | 87% | ✓ |
| Source Code | 65% | 65% | ✓ |
| Configuration | 42% | 42% | ✓ |

## CLI Reference

```bash
# ── Installation ──────────────────────────
trimemh install                   # Auto-detect agents & install MCP config
trimemh install --target <name>   # Install for specific agent
trimemh install --all             # Install for all detected agents
trimemh install --dry-run         # Preview without writing files

# ── MCP Server ────────────────────────────
trimemh mcp serve                 # Start stdio MCP server
trimemh mcp config                # Generate MCP client config JSON

# ── Memory Management ─────────────────────
trimemh remember "text" --kind <kind>  # Store a new memory
trimemh search "query" --mode hybrid   # Search memories (fts|vector|hybrid)
trimemh list                           # List all active memories
trimemh stats                          # Memory statistics
trimemh forget <id>                    # Archive a memory

# ── Governance ───────────────────────────
trimemh propose "text" --kind <kind>   # Propose (requires approval)
trimemh approve <proposal_id>          # Approve a proposal
trimemh reject <proposal_id>           # Reject a proposal

# ── Learning ─────────────────────────────
trimemh learn <session-log>            # Mine failures & suggest fixes
trimemh learn --auto-approve           # Auto-apply low-risk corrections
trimemh learn --dry-run                # Preview without applying

# ── Diagnostics ──────────────────────────
trimemh dedup --scan --threshold=0.85  # Scan for semantic duplicates
trimemh related <id>                   # Find related memories via graph
trimemh benchmark                      # Run token compression benchmark
```

## MCP Tools

triMemh exposes 11 MCP tools that agents use automatically:

| Tool | Description | Example |
|---|---|---|
| `memory_search` | FTS5 / vector / hybrid RRF search | `memory_search("auth bug fix", mode="hybrid")` |
| `memory_context` | Get compressed context XML | Called automatically each turn |
| `memory_propose` | Propose new memory (governance-gated) | `memory_propose("JWT tokens expire...", kind="mistake")` |
| `memory_get` | Get full memory detail | `memory_get("mem_abc123")` |
| `memory_retrieve` | **CCR**: fetch original of compressed memory | `memory_retrieve("trimemh:mem_abc123")` |
| `memory_feedback` | Rate memory usefulness (improves scoring) | `memory_feedback("mem_abc123", useful=true)` |
| `memory_related` | Find related memories via graph edges | `memory_related("mem_abc123")` |
| `memory_stats` | Memory usage statistics | `memory_stats()` |
| `memory_code_search` | Search by file path or symbol | `memory_code_search(path="src/auth.ts")` |
| `memory_link_propose` | Propose link between memories | `memory_link_propose(source, target, relation="related_to")` |
| `memory_code_link_propose` | Propose memory ↔ code entity link | `memory_code_link_propose("mem_abc", "src/auth.ts")` |

## Architecture

```
src/
├── cli/                CLI interface
│   ├── install-command   Auto-detect 5 AI agents + MCP config
│   ├── learn-command     Session mining entry point
│   └── tui.ts            Terminal UI (WIP)
│
├── context/            Compression pipeline (ContentRouter → CCR → CacheAligner)
│   ├── ccr.ts             Reversible Context Compression (3-level)
│   ├── code-compressor.ts TypeScript AST compressor (tree-sitter)
│   ├── compiler.ts        CacheAligner stable prefix + smart rendering
│   ├── content-router.ts  6-type content detection + per-type renderers
│   ├── context-runtime.ts Turn-based context assembly
│   └── chunking.ts        AST-aware text chunking
│
├── retrieval/          Search, scoring & embeddings
│   ├── embedding-provider  LocalHash (zero-dep) + ONNX MiniLM
│   ├── hybrid.ts          RRF fusion (FTS5 + sqlite-vec ANN)
│   ├── query-expansion.ts 60+ domain synonym pairs + negation handling
│   ├── reranker.ts        Cross-encoder fallback (keyword × phrase × entity)
│   ├── scoring.ts         9-factor Engram-inspired retrieval scoring
│   ├── feedback.ts        EMA-based agent feedback loop (α=0.15)
│   ├── dedup.ts           Per-kind semantic dedup thresholds
│   └── cross-agent.ts     Cross-agent provenance + dedup
│
├── mcp/                MCP server implementation
│   ├── server.ts          StdioServerTransport bootstrap
│   ├── tools.ts           11 tool registrations + rate limiting
│   ├── schemas.ts         Zod input schemas for all tools
│   ├── config-gen.ts      5-target MCP config generator
│   ├── transport.ts       Streamable HTTP transport
│   └── runtime.ts         Rate limit enforcement
│
├── persistence/        Storage layer
│   ├── db.ts              SQLite bootstrap + migrations + sqlite-vec
│   └── repository.ts      Full CRUD + FTS5 + vector operations
│
├── governance/         Safety & compliance
│   └── index.ts           RBAC + approval policies + override detection
│
├── learning/           Self-improvement
│   └── learn.ts           Failure pattern detection (4 types) + correction
│
├── infrastructure/     Cross-cutting
│   ├── config.ts          Global config (paths, env, defaults)
│   ├── guardrail.ts       Input/output sanitization + API key redaction
│   ├── sanitize.ts        Text normalization utilities
│   ├── rate-limit.ts      Token-bucket rate limiter
│   ├── logging.ts         Structured JSON logger
│   └── cache.ts           LRU result cache
│
├── sdk/                Framework integrations
│   ├── anthropic.ts       Anthropic SDK middleware
│   ├── claude-agent.ts    Claude Agent SDK integration
│   ├── vercel.ts          Vercel AI SDK middleware
│   ├── client.ts          HTTP client for remote servers
│   ├── context.ts         SDK context helpers
│   └── prompt.ts          Prompt prefix injection
│
├── code-intel/         Code intelligence
│   ├── code-parser.ts     Tree-sitter multi-language parser
│   ├── file-watcher.ts    FS watcher with debounce + auto-index
│   └── git-integration.ts Git history context provider
│
└── domain/             Shared types
    └── schema.ts          TypeScript interfaces, enums, constants
```

## Design Principles

### 1. Local-First
Everything runs on your machine. SQLite via `bun:sqlite`. Vector search via `sqlite-vec`. Embeddings via LocalHash (SHA-256 feature hashing) with optional ONNX upgrade. No API keys needed. No data leaves your disk.

### 2. Governance-First
Memories aren't written directly — they go through a proposal → approval flow. Critical kinds (security rules, trade rules) cannot be auto-approved. Every change leaves an audit trail. Adversarial override detection prevents unauthorized modifications.

### 3. Progressive Disclosure
Context is delivered in 3 layers:
- **Layer 1** (Index): Kind + risk level + one-line summary. Always visible.
- **Layer 2** (Details): Full text, compressed by ContentRouter + CCR.
- **Layer 3** (Lineage): Audit history + provenance. On-demand only.

### 4. Token-Aware Compression
Every byte counts. ContentRouter detects what you're looking at and applies the best compression strategy. CCR makes it reversible — the original is always retrievable. CacheAligner stabilizes the XML skeleton so providers reuse KV-cache entries across turns.

### 5. Self-Improving
The feedback loop learns from agent behavior. Useful memories rise in ranking. Stale or unhelpful ones decay. `trimemh learn` mines failed sessions and generates corrections.

## Configuration

triMemh stores its database at `.trimemh/memory.db` in your project root. Configure via environment variables:

| Variable | Default | Description |
|---|---|---|
| `TRIMEMH_PROJECT_ID` | auto-generated | Project identifier |
| `TRIMEMH_DB_PATH` | `.trimemh/memory.db` | Database file path |
| `TRIMEMH_ONNX_MODEL` | (none) | Path to ONNX model for better embeddings |
| `TRIMEMH_BUN_PATH` | `bun` | Custom Bun binary path |
| `TRIMEMH_SCRIPT_PATH` | `src/cli.ts` | Custom CLI entry point |
| `TRIMEMH_AGENT_ID` | auto-detected | Override agent identity |

## Requirements

- **[Bun](https://bun.sh)** >= 1.0.0
- SQLite (bundled with Bun)
- TypeScript (for AST code compression)
- **Zero cloud dependencies.** No API keys. No network calls.

## Comparison

| Feature | triMemh | headroom | mem0 | MemGPT |
|---|---|---|---|---|
| **Local-first** | ✅ | ✅ | ❌ (cloud) | ❌ (cloud) |
| **Governance (RBAC)** | ✅ | ❌ | ❌ | ❌ |
| **AST code compression** | ✅ (TS) | ✅ (multi-lang) | ❌ | ❌ |
| **Reversible compression** | ✅ (CCR) | ✅ (CCR) | ❌ | ❌ |
| **Agent feedback loop** | ✅ (EMA) | ❌ | ❌ | ✅ |
| **Cross-agent dedup** | ✅ | ✅ | ❌ | ❌ |
| **Vector search** | ✅ (sqlite-vec) | ❌ | ✅ | ✅ |
| **Hybrid search (FTS5+vec)** | ✅ (RRF) | ❌ | ❌ | ❌ |
| **MCP server** | ✅ (11 tools) | ✅ (3 tools) | ❌ | ❌ |
| **Deployment** | CLI + MCP | Library + Proxy + MCP | API | API |
| **Language** | TypeScript (Bun) | Python + Rust | Python | Python |
| **License** | MIT | Apache 2.0 | — | Apache 2.0 |

## From Source

```bash
git clone https://github.com/justonemorenight/trimemh.git
cd tri-memory
bun install
bun test                  # 299 tests, 0 failures
bun run scripts/benchmark.ts  # Token compression benchmark
```

## Roadmap

- [x] ContentRouter — 6-type content detection
- [x] CCR — 3-level reversible compression
- [x] CacheAligner — stable KV-cache prefix
- [x] AST code compressor — TypeScript tree-sitter
- [x] Log pattern dedup — variable normalization
- [x] Query expansion — 60+ synonym pairs
- [x] Reranker — cross-encoder fallback
- [x] Agent feedback loop — EMA scoring
- [x] Session mining — `trimemh learn`
- [x] Cross-agent shared context
- [x] Governance — RBAC + approval flow
- [x] MCP server — 11 tools
- [x] CLI install — auto-detect 5 AI agents
- [ ] TUI — terminal dashboard
- [ ] Multi-language AST — Python, Go, Rust
- [ ] Streamable HTTP transport
- [ ] Team-level shared memory server

## Contributing

```bash
bun install
bun test          # Must pass
bun run scripts/benchmark.ts  # Verify compression metrics
```

Open an issue before submitting a PR. Keep it local-first. No cloud dependencies.

## License

MIT © [Just One More Night](https://github.com/justonemorenight)
