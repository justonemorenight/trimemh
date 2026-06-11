<p align="center">
  <img src="https://img.shields.io/badge/bun-%3E%3D1.0.0-f9f1e4?logo=bun&logoColor=white" alt="Bun">
  <img src="https://img.shields.io/badge/tests-446%20pass-success" alt="Tests">
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

AI coding agents need trustworthy project memory. Forgetting context is costly, but stale memory is worse: an agent can confidently follow old project knowledge after the code has changed.

**triMemh** keeps AI coding agents' project memory durable, reviewable, and up to date. It stores local memory, links it to code, and detects context rot such as missing files, removed symbols, changed fingerprints, and conflicting decisions.

- **93% fewer tokens** in the context window — proven across real-world scenarios
- **Zero cloud dependencies** — everything runs locally on SQLite + Bun
- **Governance-first** — every memory change goes through approval flows
- **Context-rot detection** — flag stale memories when linked files, symbols, or fingerprints change
- **Cross-agent** — share knowledge between Claude Code, Cursor, Codex, Copilot CLI, and Aider
- **Self-improving** — agents rate memory usefulness; the system learns what matters

## Trustworthy Memory, Not Just More Memory

Forgetting project context is annoying. **Stale memory is dangerous**: an AI coding agent can confidently follow old project knowledge after the code has changed.

```bash
bun scripts/demo-stale-memory.ts
```

```text
1/1 flagged (high=1, medium=0, low=0)

[high] code_context action=update_link
- missing_symbol: Linked code entity no longer exists: /tmp/trimemh-stale-memory-demo/src/auth.ts#validateSession
```

triMemh treats stale memory as a correctness bug. It links memories to code and flags context rot before agents rely on it: missing files, removed symbols, changed fingerprints, and conflicting decisions.

Learn more in [Stale Memory Detection](docs/stale-memory.md). The VS Code extension also includes an Atlas view for interactive memory-code graph navigation. A visual workflow is available in the [VS Code extension](editors/code/README.md).

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
trimemh install --target claude-code     # Claude Code
trimemh install --target codex           # OpenAI Codex
trimemh install --target cursor          # Cursor IDE
trimemh install --target continue        # Continue.dev
trimemh install --target windsurf        # Windsurf IDE
trimemh install --target copilot-cli     # GitHub Copilot CLI
trimemh install --target aider           # Aider AI
trimemh install --target claude-code --with-hooks
trimemh install --target codex --with-hooks
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
  │   Code → TypeScript compiler API AST: signatures only, bodies deferred
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

### Accuracy-First Context Assembly

When the runtime assembles prompt context, it uses task-aware budgets, evidence-first ordering, and query-aware chunking for long prose memories. The goal is to keep the highest-signal spans visible under tight budgets while preserving full originals behind `memory_retrieve`.

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

## Prevent Context Rot

Stale memory is a correctness bug: if project knowledge points at a deleted file, removed symbol, changed implementation, or conflicting decision, an agent can confidently make the wrong change.

triMemh can detect obvious context-rot signals dynamically from the current working tree and memory graph:

```bash
bun scripts/demo-stale-memory.ts
trimemh lifecycle stale --path src/auth.ts
trimemh lifecycle stale --path src/auth.ts --json
```

Agents can also use `/memh-stale` or the MCP tool `memory_stale_detect` before relying on project memory after code changes. The detector flags broken code links, missing symbols, fingerprint mismatches, memory conflicts, and optional low-confidence memories. It reports suggested actions such as `review`, `update_link`, or `supersede`, but does not auto-delete or archive memories.

## Performance

Measured with realistic local workloads that exercise the compression pipeline, context assembly, retrieval, and local HTTP transport.

### Token Compression

| Scenario | Raw Tokens | Compressed Tokens | Reduction | What triMemh Keeps |
|---|---:|---:|---:|---|
| **Code Search** (100 results) | 7.1K | 85 | **99%** | File paths, symbols, signatures |
| **SRE Incident** (800 log lines) | 31.8K | 1.8K | **94%** | Error patterns, stack frames, timing signals |
| **Issue Triage** (bug report + code + logs) | 1.5K | 435 | **72%** | Repro steps, code hints, failure markers |
| **Codebase Exploration** (config + source + diff) | 1.5K | 479 | **68%** | Changed files, config keys, API surfaces |
| **Architecture Discussion** (prose-heavy) | 1.4K | 113 | **92%** | Decisions, constraints, retrieval handles |
| **TOTAL** | 43.3K | 2.9K | **93%** | Dense context with originals retrievable |

```bash
# Run the compression benchmark yourself
bun run scripts/benchmark.ts
```

### Local Latency

Measured on a MacBook Pro M3, Bun 1.3.14, sqlite-vec 0.1.9:

| Context Assembly | 50 memories | 200 | 500 | 1,000 |
|---|---|---|---|---|
| **p50** | 348μs | 796μs | 1.4ms | 1.6ms |

| Search Mode | p50 | p95 | avg |
|---|---|---|---|
| **FTS-only** | 12.8ms | 15.1ms | 13.4ms |
| **Hybrid (FTS5 + Vector RRF)** | 13.1ms | 14.2ms | 13.2ms |

| Write Workload | Total | Throughput | Avg latency |
|---|---:|---:|---:|
| **Empty DB** (50 sequential writes) | 17.1ms | 2,919 writes/s | 342μs |
| **Populated DB** (~1,000 records, 50 sequential writes) | 97.5ms | 513 writes/s | 1.9ms |
| **Populated DB batched** (~1,050 records, 50 writes) | 20.4ms | 2,455 writes/s | 407μs |

| Session Simulation | Total | Avg turn | Search p50 |
|---|---:|---:|---:|
| **50 turns** | 100ms | 2.0ms | 2.4ms |

```bash
# Run the latency benchmark yourself
bun run scripts/bench-realworld.ts
```

### Local HTTP Transport Hardening

The Streamable HTTP transport is hardened for browser-origin CSRF with strict `Content-Type: application/json` validation and origin-aware CORS behavior.

| Scenario | Requests | Average | p95 | Expected Status |
|---|---:|---:|---:|---|
| Unknown-origin JSON preflight | 300 | 0.10ms | 0.11ms | 204 without CORS allow headers |
| Trusted-origin form-urlencoded POST | 300 | 0.07ms | 0.10ms | 415 |
| Trusted-origin text/plain POST | 300 | 0.05ms | 0.07ms | 415 |
| Trusted-origin JSON POST burst | 25 | 0.10ms | 0.09ms | 200 |

```bash
# Run the HTTP hardening benchmark yourself
bun run scripts/bench-mcp-transport-csrf.ts
```

### Content Type Detection Accuracy

The ContentRouter detects six common memory payload shapes and applies the matching compression strategy automatically:

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
trimemh install --with-hooks      # Add lifecycle hooks for Claude Code/Codex
trimemh install --all             # Install for all detected agents
trimemh install --dry-run         # Preview without writing files

# ── MCP Server ────────────────────────────
trimemh mcp serve                 # Start stdio MCP server
trimemh mcp config                # Generate MCP client config JSON

# ── Hook Ingestion ─────────────────────────
trimemh hooks capture --event stop --agent codex < hook.json

# ── Memory v2 Workflows ────────────────────
trimemh eval retrieval --dataset example/retrieval-eval.dataset.json --format markdown
trimemh eval context --dataset example/context-accuracy.dataset.json --budgets 4000,8000,32000
trimemh session summarize --agent codex --session-id abc --summary "Finished adapter work"
trimemh session history --agent claude-code
trimemh session registry --agent codex
trimemh lifecycle list --entity-type memory_proposal --entity-id <proposal-id>
trimemh lifecycle conflicts --kind decision --text "Use Codex hooks only for summaries"
trimemh lifecycle stale --path src/auth.ts --json
trimemh lifecycle expire --before 2026-06-07T00:00:00.000Z --dry-run
trimemh lifecycle supersede <old-memory-id> <new-memory-id>
trimemh review plan --input plan.md --dry-run
trimemh review patch --with-claude

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

# ── Code Intelligence ────────────────────
trimemh scan                           # Scan project codebase & index code entities
trimemh scan --seed                    # Scan + auto-generate project overview memories
trimemh scan --dry-run                 # Parse and report without persisting
trimemh scan --path <subdir>           # Scan a specific subdirectory
trimemh scan --max-files <number>      # Limit files scanned (default 200)

# ── Diagnostics ──────────────────────────
trimemh dedup --scan --threshold=0.85  # Scan for semantic duplicates
trimemh related <id>                   # Find related memories via graph
trimemh benchmark                      # Run token compression benchmark
```

## MCP Tools

triMemh exposes 16 MCP tools that agents use automatically:

| Tool | Description | Example |
|---|---|---|
| `memory_search` | FTS5 / vector / hybrid RRF search | `memory_search("auth bug fix", mode="hybrid")` |
| `memory_context` | Get compressed context XML | Called automatically each turn |
| `memory_propose` | Propose new memory (governance-gated) | `memory_propose("JWT tokens expire...", kind="mistake")` |
| `memory_list_proposals` | List pending proposals for review | `memory_list_proposals(status="pending")` |
| `memory_approve` | Approve a pending memory proposal | `memory_approve("prop_abc123")` |
| `memory_reject` | Reject a pending memory proposal | `memory_reject("prop_abc123", note="duplicate")` |
| `memory_get` | Get full memory detail | `memory_get("mem_abc123")` |
| `memory_retrieve` | **CCR**: fetch original of compressed memory | `memory_retrieve("trimemh:mem_abc123")` |
| `memory_feedback` | Rate memory usefulness (improves scoring) | `memory_feedback("mem_abc123", useful=true)` |
| `memory_related` | Find related memories via graph edges | `memory_related("mem_abc123")` |
| `memory_stats` | Memory usage statistics | `memory_stats()` |
| `memory_code_search` | Search by file path or symbol | `memory_code_search(path="src/auth.ts")` |
| `memory_code_impact` | Memory-backed impact radius for a code path | `memory_code_impact(path="src/auth.ts", depth=2)` |
| `memory_stale_detect` | Detect context rot: broken links, missing symbols, changed fingerprints, conflicts | `memory_stale_detect(path="src/auth.ts")` |
| `memory_link_propose` | Propose link between memories | `memory_link_propose(source, target, relation="related_to")` |
| `memory_code_link_propose` | Propose memory ↔ code entity link | `memory_code_link_propose("mem_abc", "src/auth.ts")` |

## REST API

triMemh ships with a built-in Hono HTTP server exposing 15 REST endpoints. The API uses strict JSON validation, Zod schemas, rate limiting, and guardrail enforcement.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/status` | Memory system statistics |
| `GET` | `/api/memories` | List all active memories (optional `?kind=&status=`) |
| `GET` | `/api/memories/:id` | Get a single memory by ID |
| `POST` | `/api/memories/remember` | Direct-write a memory (governance-gated) |
| `DELETE` | `/api/memories/:id` | Archive a memory |
| `POST` | `/api/memories/recall` | Full-text / vector / hybrid search |
| `POST` | `/api/context/assemble` | Compressed context XML assembly |
| `GET` | `/api/code/impact` | Memory impact radius for a code path |
| `GET` | `/api/proposals` | List proposals (optional `?status=`) |
| `POST` | `/api/proposals` | Create a new memory proposal |
| `POST` | `/api/proposals/:id/approve` | Approve a proposal |
| `POST` | `/api/proposals/:id/reject` | Reject a proposal |
| `POST` | `/api/links/propose` | Propose memory edge or code link |
| `POST` | `/api/links/:id/approve` | Approve a link proposal |
| `POST` | `/api/links/:id/reject` | Reject a link proposal |
| `GET` | `/viewer` | Built-in memory viewer HTML page |

```bash
# Start the API server
bun run --watch src/api.ts
# → http://localhost:2024
# → Viewer at http://localhost:2024/viewer
```

## Memory Viewer

A built-in browser-based memory viewer is available at `/viewer` when the API server is running. It provides a clean dashboard for browsing memories, inspecting graph relationships, and reviewing pending proposals — no external tools required.

## Architecture

```
src/
├── api.ts                 Hono HTTP REST API (15 endpoints)
├── cli.ts                 CLI entry point (commander)
├── config.ts              Global constants & limits
├── service.ts             Service barrel — re-exports from sub-modules
├── viewer.ts              Built-in memory viewer HTML page
│
├── application/         Use-case orchestrations
│   ├── dedup-use-cases.ts  Dedup scan + merge logic
│   ├── index-use-cases.ts  Project scanning & code indexing
│   ├── project-seed.ts     Auto-generate project overview memories
│   ├── recall-use-cases.ts Hybrid recall + code-path memory lookup
│   └── service-helpers.ts  Shared helpers for service layer
│
├── cli/                 CLI commands
│   ├── install-command.ts  Auto-detect 5 AI agents + MCP config
│   ├── learn-command.ts    Session mining entry point
│   ├── context-command.ts  Context assembly CLI
│   ├── dedup-command.ts    Semantic dedup scan CLI
│   ├── graph-commands.ts   Memory graph explore CLI
│   ├── mcp-commands.ts     MCP serve & config CLI
│   ├── memory-commands.ts  Remember, search, list, forget
│   ├── proposal-commands.ts Propose, approve, reject
│   └── tui.ts              Terminal UI (WIP)
│
├── service/             Service sub-modules
│   ├── memory-service.ts   CRUD operations (remember, forget, list)
│   ├── proposal-service.ts Proposal lifecycle (propose, approve, reject)
│   ├── mcp-service.ts      MCP-facing search & retrieval wrappers
│   ├── graph-service.ts    Memory graph + code-link CRUD & traversal
│   ├── auto-approval.ts    Risk-based auto-approval rules
│   └── helpers.ts          Shared service utilities
│
├── context/             Compression pipeline (ContentRouter → CCR → CacheAligner)
│   ├── ccr.ts              Reversible Context Compression (3-level)
│   ├── code-compressor.ts  TypeScript AST compressor (compiler API)
│   ├── compiler.ts         CacheAligner stable prefix + smart rendering
│   ├── content-router.ts   6-type content detection orchestrator
│   ├── content-sniffers.ts Per-type content detectors
│   ├── content-renderers.ts Per-type compressed renderers
│   ├── context-runtime.ts  Turn-based context assembly
│   └── chunking.ts         Query-aware text chunking
│
├── retrieval/           Search, scoring & embeddings
│   ├── embedding-provider.ts LocalHash (zero-dep) + ONNX MiniLM
│   ├── embedding.ts         Embedding generation helpers
│   ├── hybrid.ts            RRF fusion (FTS5 + sqlite-vec ANN)
│   ├── vector.ts            sqlite-vec vector store operations
│   ├── query-expansion.ts   60+ domain synonym pairs + negation handling
│   ├── reranker.ts          Cross-encoder fallback (keyword × phrase × entity)
│   ├── scoring.ts           9-factor Engram-inspired retrieval scoring
│   ├── feedback.ts          EMA-based agent feedback loop (α=0.15)
│   ├── dedup.ts             Per-kind semantic dedup thresholds
│   └── cross-agent.ts       Cross-agent provenance + dedup
│
├── mcp/                 MCP server implementation
│   ├── server.ts            StdioServerTransport bootstrap
│   ├── tools.ts             15 tool registrations + rate limiting
│   ├── schemas.ts           Zod input schemas for all tools
│   ├── config-gen.ts        5-target MCP config generator
│   ├── transport.ts         Streamable HTTP transport
│   └── runtime.ts           Rate limit enforcement + stdin payload limits
│
├── persistence/         Storage layer
│   ├── db.ts                SQLite bootstrap + migrations + sqlite-vec
│   ├── migrations.ts        Schema migration definitions
│   ├── memory-repo.ts       Memory row CRUD + FTS5
│   ├── proposal-repo.ts     Proposal row CRUD
│   ├── graph-repo.ts        Memory graph edges CRUD
│   ├── code-link-repo.ts    Memory ↔ code link CRUD
│   ├── repository.ts        Unified repository (backward-compat)
│   └── repository-mappers.ts Row ↔ domain mapping utilities
│
├── governance/          Safety & compliance
│   └── index.ts             RBAC + approval policies + override detection
│
├── learning/            Self-improvement
│   └── learn.ts             Failure pattern detection (4 types) + correction
│
├── infrastructure/      Cross-cutting
│   ├── config.ts            Global config (paths, env, defaults)
│   ├── guardrail.ts         Input/output sanitization + API key redaction
│   ├── sanitize.ts          Text normalization utilities
│   ├── rate-limit.ts        Token-bucket rate limiter
│   ├── logging.ts           Structured JSON logger
│   └── cache.ts             LRU result cache
│
├── sdk/                 Framework integrations
│   ├── index.ts             SDK barrel exports
│   ├── anthropic.ts         Anthropic SDK middleware
│   ├── claude-agent.ts      Claude Agent SDK integration
│   ├── vercel.ts            Vercel AI SDK middleware
│   ├── client.ts            HTTP client for remote servers
│   ├── context.ts           SDK context helpers
│   └── prompt.ts            Prompt prefix injection
│
├── code-intel/          Code intelligence
│   ├── code-parser.ts       Tree-sitter multi-language parser
│   ├── file-watcher.ts      FS watcher with debounce + auto-index
│   └── git-integration.ts   Git history context provider
│
└── domain/              Shared types
    └── schema.ts            TypeScript interfaces, enums, constants
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

## What triMemh Optimizes For

| Capability | What It Does | Current Result |
|---|---|---|
| **Local-first memory** | SQLite + sqlite-vec on your machine | No API keys, no cloud dependency |
| **Context compression** | ContentRouter + CCR + CacheAligner | 93% token reduction across benchmark scenarios |
| **Context accuracy under budget** | Evidence-first XML + adaptive retrieval + query-aware chunking | Better recall when the window is tight |
| **Fast context assembly** | Builds memory context before each LLM turn | 348μs–1.6ms p50 across 50–1,000 memories |
| **Hybrid retrieval** | FTS5 + vector search with RRF fusion | 13.1ms p50 in 500-memory real-world benchmark |
| **Governance** | RBAC, risk checks, proposal approval, audit trail | High/critical writes require explicit approval |
| **Reversible detail** | Compressed context includes retrieval handles | Original memory text stays locally retrievable |
| **Agent feedback loop** | EMA usefulness scoring | Useful memories rise; stale memories decay |
| **Cross-agent memory** | Shared project memory across installed agents | Provenance and dedup keep context coherent |
| **MCP integration** | Agent-facing tool surface | 15 MCP tools |
| **HTTP hardening** | Origin validation + strict JSON content type | Browser-simple CSRF POSTs rejected with 415 |
| **Write throughput** | WAL + batched local persistence path | 2,455 writes/s on populated DB; 513 writes/s sequential |

## From Source

```bash
git clone https://github.com/justonemorenight/trimemh.git
cd tri-memory
bun install
bun test                  # 446 tests, 0 failures
bun run scripts/benchmark.ts        # Token compression benchmark
bun run scripts/bench-realworld.ts  # Latency & throughput benchmark
bun run scripts/bench-retrieval.ts  # Retrieval quality benchmark
bun run scripts/tune-context-policy.ts --dataset example/context-accuracy.dataset.json --budgets 4000,8000,32000
```

## Roadmap

- [x] ContentRouter — 6-type content detection
- [x] CCR — 3-level reversible compression
- [x] CacheAligner — stable KV-cache prefix
- [x] AST code compressor — TypeScript compiler API
- [x] Log pattern dedup — variable normalization
- [x] Query expansion — 60+ synonym pairs
- [x] Reranker — cross-encoder fallback
- [x] Agent feedback loop — EMA scoring
- [x] Session mining — `trimemh learn`
- [x] Cross-agent shared context
- [x] Governance — RBAC + approval flow + proposal review tools
- [x] MCP server — 15 tools (search, context, propose, approve, reject, feedback, graph, code impact…)
- [x] CLI install — auto-detect 5 AI agents
- [x] CLI scan — codebase scanning + code entity indexing
- [x] REST API — 15 HTTP endpoints via Hono
- [x] Streamable HTTP transport — MCP over HTTP with CSRF hardening
- [x] Memory viewer — built-in browser dashboard
- [ ] TUI — terminal dashboard
- [ ] Multi-language AST — Python, Go, Rust
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
