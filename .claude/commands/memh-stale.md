# Detect Stale Project Memory

Find potentially stale memories before trusting project context, then guide safe repair.

## Steps

1. Identify the file(s) or symbol the user is working on from open editors, user input, or the current task.
2. Call `memory_stale_detect` with `path` (and `symbol` if known) for targeted checks. If the user asks for a broad audit, call it without a path.
3. Present findings grouped by severity: `high`, `medium`, then `low`.
4. For each finding, explain why it matters for the current task and recommend the next safe action.
5. If repair is appropriate, follow the guided repair workflow below.
6. Stop before destructive or truth-changing actions unless the user explicitly approves them.

## Guided Repair Workflow

### `missing_file`

A memory points to a file that no longer exists.

1. Search for likely moved/renamed files if the current task needs this memory.
2. If a replacement file is found, propose a new memory-code link with `memory_code_link_propose`.
3. If the memory text itself is obsolete, propose a replacement memory and explain that it should supersede the old one.
4. Do not archive or expire the old memory automatically.

### `missing_symbol`

A memory points to a function/class/module symbol that no longer exists.

1. Inspect the current file for likely replacement symbols.
2. If the behavior moved to a new symbol, propose a new code link.
3. If the behavior changed, summarize the difference and ask whether to create a superseding memory.
4. If unsure, mark it as requiring human review.

### `fingerprint_mismatch`

The linked code entity still exists but its fingerprint changed.

1. Read the current code entity before judging the memory.
2. Compare the current behavior to the memory text.
3. If still accurate, say no memory change is needed.
4. If partially stale, propose an updated memory.
5. If contradicted, propose a superseding memory.

### `memory_conflict`

Two or more active memories may contradict each other.

1. Retrieve or show the conflicting memories side by side.
2. Explain the contradiction in plain language.
3. Ask the user which one is still true, unless the code clearly resolves it.
4. Propose a superseding memory only after the user confirms the truth.

### `low_confidence`

A memory has weak confidence or usefulness signals.

1. Treat it as review-needed, not automatically stale.
2. Use current code/docs/tests to confirm whether it is still useful.
3. If useful, leave it active.
4. If obsolete, propose an update or superseding memory.

## Reason → Action Matrix

| Reason | Default severity | Suggested action | Auto-destructive? |
|---|---|---|---|
| `missing_file` | high | `update_link` or `supersede` | no |
| `missing_symbol` | high | `update_link` or `supersede` | no |
| `fingerprint_mismatch` | medium | `review` | no |
| `memory_conflict` | medium | `supersede` after confirmation | no |
| `low_confidence` | low | `review` | no |

## Key Rules

- Stale memory is a correctness risk; call it out clearly.
- Do not expire, archive, supersede, or delete memories without explicit user approval.
- Prefer targeted checks for files in the current task to avoid noisy reports.
- If no stale memories are found, say that the checked memory set has no obvious context-rot signals.
- If proposing a repair, make it reviewable: explain the old memory, the current code reality, and the proposed replacement.
