# Headroom Deep Dive

Snapshot date: 2026-06-10

Repo: https://github.com/chopratejas/headroom

Primary sources:
- README: https://github.com/chopratejas/headroom
- LLM docs index: https://raw.githubusercontent.com/chopratejas/headroom/main/llms.txt
- Architecture: https://headroom-docs.vercel.app/docs/architecture
- Benchmarks: https://headroom-docs.vercel.app/docs/benchmarks
- Failure learning: https://headroom-docs.vercel.app/docs/failure-learning

## Executive Fit

Headroom is the closest strategic comparison for triMemh. It is not just a
library for smaller prompts; it is a local-first context optimization layer with
library, proxy, wrapper, MCP, reversible retrieval, cross-agent memory, and
failure learning.

triMemh already overlaps with several Headroom concepts:
- Content-aware routing and compression.
- CCR-style reversible compression with retrieval.
- MCP tools for compressed context and retrieval.
- Cross-agent memory/provenance.
- Failure mining through `trimemh learn`.
- Benchmarks that explicitly compare against Headroom workloads.

The right posture is not "adopt Headroom". It is "study Headroom as a benchmark
and product-shape reference, then clone the specific ideas that make triMemh
more reliable, measurable, and easier to adopt."

## What Headroom Is

Headroom positions itself as a context compression layer for AI agents. The
public README describes support for:
- Library mode: Python and TypeScript `compress(...)`.
- Proxy mode: local HTTP proxy in front of model clients.
- Agent wrapper mode: wrap Claude, Codex, Cursor, Aider, Copilot, and others.
- MCP mode: compression, retrieval, and stats tools.
- Cross-agent memory and dedup.
- Failure learning that writes project-level corrections.
- Reversible compression where originals remain retrievable.

The documented pipeline is:
- CacheAligner: move dynamic prompt fragments away from the stable prefix.
- ContentRouter: detect content type.
- Compressors: JSON, code, logs, diffs, text, and image.
- Context manager: fit context to model window.
- CCR: store originals locally and expose retrieval.

Architecture docs also mention SmartCrusher for structured outputs, AST-aware
code compression, Kompress-base for text, provider cache hints, and TOIN-style
learning from tool output usage patterns.

## Direct Overlap With triMemh

| Area | Headroom | triMemh Today | Notes |
|---|---|---|---|
| Content routing | ContentRouter chooses compressor by payload type | `src/context/content-router.ts` and `content-sniffers.ts` | Same core pattern. |
| Reversible compression | CCR stores original and exposes retrieval | `src/context/ccr.ts`, `memory_retrieve` | triMemh already implements the right primitive. |
| Log compression | Pattern clustering and error preservation | `renderLog` in `src/context/content-renderers.ts` | triMemh is strong here. |
| Code compression | AST, multi-language via tree-sitter docs | TypeScript compiler API plus fallback signature extraction | Biggest technical gap: multi-language AST. |
| Cross-agent memory | Shared store and provenance | `src/retrieval/cross-agent.ts` | triMemh has governance and local memory advantages. |
| Failure learning | Success-correlation from failed sessions | `src/learning/learn.ts` pattern detectors | triMemh detects failure categories, but can improve correlation. |
| Benchmarks | Public docs include compression, accuracy, latency, telemetry | `scripts/benchmark.ts`, `bench-realworld.ts`, `bench-retrieval.ts` | triMemh already compares against Headroom. |
| Entry points | Library, proxy, wrapper, MCP | CLI, MCP, SDK adapters, install rules | Proxy/wrap is the main distribution gap. |

## Best Ideas To Clone

### 1. Success-Correlation Learning

Headroom's failure learning docs emphasize correlating failure with the later
action that fixed it, not merely detecting that a failure happened. That maps
well to triMemh because we already parse sessions and propose memories.

Clone target:
- Extend `trimemh learn` from pattern detection to event-sequence correlation.
- Detect "wrong path -> successful path", "failed command -> successful
  command", and "narrow search -> broad search" pairs.
- Store corrections as `procedure`, `mistake`, or `code_context` proposals with
  evidence.

Why this matters:
- It produces concrete project facts instead of generic "be careful" memories.
- It should reduce repeated path and command mistakes across agents.

Possible implementation path:
- Add normalized tool-call events to `src/service/memory-event-adapter.ts`.
- Add a `correlateFailuresWithRecoveries(...)` step in `src/learning/learn.ts`.
- Add tests with JSONL transcripts containing failed and later successful calls.

### 2. SmartCrusher-Style Structured Output Compression

Headroom's architecture docs describe structured JSON compression that preserves
schema, distribution boundaries, anomalies, and representative samples.

Clone target:
- Upgrade triMemh's JSON renderer from schema-only summaries to a compact,
  statistics-aware representation for arrays of objects.
- Preserve all rows/items with error-like fields, warnings, outliers, and high
  uniqueness.
- Factor out constants shared by every row.
- Keep a small sample from head, tail, and high-importance rows.

Why this matters:
- triMemh's schema-only JSON is very compact but may drop values needed for
  diagnosis.
- A SmartCrusher-like mode would be safer for database rows, API responses, and
  tool output arrays.

Possible implementation path:
- Add `renderJsonArraySummary` in `src/context/content-renderers.ts`.
- Add detection for arrays of records in `content-sniffers.ts`.
- Include a `forcedType: "json"` benchmark fixture with anomalies.

### 3. Multi-Language AST Compression

triMemh currently has a TypeScript compiler API path. Headroom claims
AST-aware compression across multiple languages.

Clone target:
- Add tree-sitter-based parsing for Python, Go, Rust, Java, and maybe SQL.
- Keep public signatures, imports, exports, type/interface declarations, class
  members, and doc comments.
- Defer function bodies behind `memory_retrieve`.

Why this matters:
- triMemh is an agent memory system, so it will be used across polyglot repos.
- TypeScript-only AST compression makes benchmark parity harder outside JS/TS.

Possible implementation path:
- Do not add all languages at once.
- Start with Python because many agent and ML repos use it.
- Add `src/context/code-compressor-python.ts` or a parser registry.
- Add fixtures to `tests/code-compressor.test.ts`.

### 4. Proxy And Agent Wrapper As Adoption Surface

Headroom's proxy and `wrap` commands are a strong product idea: users can get
value without changing their app or agent setup deeply.

Clone target:
- Add a local proxy mode later, but only after MCP/CLI are polished.
- Add wrapper commands for agents if they can be implemented without brittle
  provider-specific auth hacks.

Why this matters:
- triMemh currently installs MCP configs and rules. That is good for memory, but
  a proxy could capture tool output or model traffic in systems that do not use
  triMemh MCP tools.

Guardrail:
- This is high blast radius and can easily expand scope.
- Start with "dry-run proxy metrics" or "local MCP transport compression proxy",
  not full provider traffic interception.

### 5. Benchmark Methodology And Public Proof

Headroom publishes compression, accuracy, latency, production telemetry, and
reproduction commands.

Clone target:
- Make triMemh benchmarks first-class docs.
- Split benchmark claims into:
  - synthetic local fixtures,
  - real-world anonymized fixtures,
  - retrieval quality,
  - latency,
  - failure-learning accuracy.
- Add "when compression intentionally does nothing" notes.

Why this matters:
- triMemh already claims strong compression. Public trust needs methodology,
  fixtures, and reproducible commands.

### 6. `llms.txt` And Docs Blob

Headroom exposes an LLM-oriented docs index and full docs blob. This is a good
fit for agent-facing tooling.

Clone target:
- Add `llms.txt` to triMemh with install, API, MCP tools, memory workflow,
  governance, examples, and source links.
- Optionally generate `llms-full.txt` from README plus docs once docs exist.

Why this matters:
- triMemh is designed for agents. Agent-readable docs should be a first-class
  artifact.

## Ideas Not To Clone Directly

### Anonymous Telemetry By Default

Headroom docs mention anonymous telemetry for production stats. triMemh's
positioning is local-first and governance-first. If telemetry ever exists, it
should be explicit opt-in, easy to inspect, and never include memory content.

### ML Text Compression As A First Move

Kompress-style model compression is interesting, but triMemh should first close
deterministic gaps: multi-item routing, structured JSON, failure correlation,
and benchmark quality.

### Direct Writes To Agent Rule Files From Learning

Headroom writes learnings into files like `CLAUDE.md` or `AGENTS.md`. triMemh
should route this through governance proposals by default. This is one of our
core differentiators.

### Full Proxy Traffic Interception Too Early

Proxy mode is powerful, but it touches auth, privacy, transport semantics, and
provider edge cases. For triMemh, this belongs after the memory substrate and
skill/adoption layer are solid.

## triMemh Gap List

1. Structured JSON compression should retain useful values, not only schema.
2. Code compression should support at least Python in addition to TS/JS.
3. `learn` should correlate failures with later successful actions.
4. Benchmarks should separate synthetic vs real-world evidence.
5. Docs should include an agent-readable `llms.txt`.
6. We need a clearer "why triMemh vs Headroom" story:
   - governance-first memory,
   - explicit approval lifecycle,
   - memory graph and code links,
   - local-first SQLite,
   - agent memory continuity rather than generic traffic compression.

## Suggested Roadmap

P0:
- Add public benchmark methodology docs.
- Add `llms.txt`.
- Add failure recovery correlation to `trimemh learn`.

P1:
- Add SmartCrusher-like JSON array summarization.
- Add Python AST compression.
- Add tests for mixed-content payload splitting.

P2:
- Explore proxy/wrap mode as an opt-in experiment.
- Explore local ML text compression only after deterministic wins are exhausted.
- Add SharedContext-style handoff docs and examples.

## Open Questions

1. Should triMemh be positioned as a Headroom competitor, complement, or memory
   layer that can sit beside context compression tools?
2. Should compressed values be retrievable at the memory item level only, or at
   finer chunk/key ranges?
3. Should `trimemh learn` write only proposals, or optionally patch rules files
   behind an explicit `--apply-rules` flag?
4. How much of the benchmark suite should run in CI vs manually?

