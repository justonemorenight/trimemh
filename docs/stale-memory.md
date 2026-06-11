# Stale Memory Detection

AI coding agents need memory, but memory without lifecycle becomes misinformation. A missing memory makes an agent slower; a stale memory can make it confidently wrong.

triMemh's stale-memory workflow keeps project memory trustworthy by checking whether active memories still match the current code and the rest of the memory graph.

## Why stale memory matters

Common failure mode:

1. A memory says `auth.ts#validateSession` validates cookie sessions.
2. The code is refactored to bearer tokens and `validateSession` is removed.
3. A future agent reads the old memory and edits auth middleware as if cookie sessions still exist.

The result is not forgetfulness. It is stale context causing a correctness bug.

## Try the demo

Run the end-to-end demo:

```bash
bun scripts/demo-stale-memory.ts
```

What it does:

1. Creates a temporary `auth.ts` with `validateSession`.
2. Stores a `code_context` memory about that symbol.
3. Links the memory to the code entity and fingerprint.
4. Refactors the code to `validateBearerToken`.
5. Runs stale-memory detection.

Expected output shape:

```text
Created a memory linked to auth.ts#validateSession.
Now simulating a refactor from cookie sessions to bearer tokens...

Stale memory report
───────────────────
1/1 flagged (high=1, medium=0, low=0)

[high] code_context action=update_link
memory: auth.ts#validateSession validates cookie-based sessions; use it before touching auth middleware.
- missing_symbol: Linked code entity no longer exists: /tmp/trimemh-stale-memory-demo/src/auth.ts#validateSession

Takeaway: stale memory is a correctness bug. triMemh flags it before an agent trusts it.
```

## CLI usage

Run a targeted stale check for a file:

```bash
trimemh lifecycle stale --path src/auth.ts
```

Return machine-readable output:

```bash
trimemh lifecycle stale --path src/auth.ts --json
```

Include low-confidence memory findings:

```bash
trimemh lifecycle stale --include-low-confidence
```

Skip conflict checks when you only want code-link rot detection:

```bash
trimemh lifecycle stale --path src/auth.ts --no-conflicts
```

## MCP usage

Agents can call:

```text
memory_stale_detect(path="src/auth.ts")
```

Useful moments to call it:

- Before trusting code-linked memories for a file currently being edited.
- After a refactor that renamed files, functions, classes, or modules.
- During `/memh-impact` to understand memory-backed impact radius and stale context.
- During `/memh-start` when open file paths are available.

## Slash command workflow

Use:

```text
/memh-stale
```

The slash command should:

1. Identify relevant file paths from the task or open editors.
2. Call `memory_stale_detect` for those paths.
3. Present findings by severity.
4. Recommend review, link update, or superseding action.
5. Avoid destructive changes unless the user explicitly approves them.

## What counts as stale today

The MVP detector is deterministic and local-first. It checks:

| Reason | Meaning | Typical action |
|---|---|---|
| `missing_file` | A linked code file no longer exists | `update_link` or `supersede` |
| `missing_symbol` | A linked function/class/module symbol no longer exists | `update_link` or `supersede` |
| `fingerprint_mismatch` | The linked code entity still exists but changed | `review` |
| `memory_conflict` | Active memories may contradict each other | `supersede` after review |
| `low_confidence` | Optional: active memory confidence is below threshold | `review` |

## Safety model

triMemh is governance-first:

- Stale detection is report-first.
- It does not auto-delete memories.
- It does not auto-expire memories.
- It does not silently ignore stale findings.
- Suggested actions still require user or review workflow approval.

This is intentional. Stale detection should create trust, not surprising destructive behavior.

## Current limitations

- Symbol extraction uses the existing regex parser fallback, not full Tree-sitter parsing.
- Semantic contradictions are detected with existing retrieval/lexical heuristics, not an LLM judge.
- Stale state is computed dynamically and not persisted as a separate DB table.
- CI integration is not enabled by default.

## Roadmap

Possible next phases:

1. **Guided repair proposals**: suggest replacement code links or superseding memories.
2. **CI warn-only mode**: report high-severity stale memory in pull requests without blocking.
3. **Semantic verification**: optional LLM or embedding-based checks for deeper contradictions.
4. **Tree-sitter-backed symbols**: more accurate function/class/module tracking.
5. **VS Code extension UX**: show stale memory warnings inline for open files.

## Core thesis

> Stale memory is a correctness bug.

triMemh's job is not just to help agents remember more. It helps them remember what is still true.
