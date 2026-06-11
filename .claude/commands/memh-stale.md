# Detect Stale Project Memory

Find potentially stale memories before trusting project context.

## Steps

1. Identify the file(s) or symbol the user is working on from open editors, user input, or the current task.
2. Call `memory_stale_detect` with `path` (and `symbol` if known) for targeted checks. If the user asks for a broad audit, call it without a path.
3. Present findings grouped by severity: `high`, `medium`, then `low`.
4. For `missing_file` or `missing_symbol`, recommend reviewing the memory and either updating the code link or creating a replacement memory that supersedes it.
5. For `fingerprint_mismatch`, inspect the linked code before deciding whether the memory is stale.
6. For `memory_conflict`, retrieve both memories and ask the user before superseding either one.

## Key Rules

- Stale memory is a correctness risk; call it out clearly.
- Do not expire, archive, supersede, or delete memories without explicit user approval.
- Prefer targeted checks for files in the current task to avoid noisy reports.
- If no stale memories are found, say that the checked memory set has no obvious context-rot signals.
