# Start Task with Memory Context

Load relevant memories before beginning work.

## Steps

1. Call `memory_context` with the current task description and any open file paths as context.
2. If open file paths are available, call `memory_stale_detect` for those paths before relying on code-linked memories.
3. Review returned memories — note IDs of relevant ones for reference during the task, and flag any stale findings.
4. Call `memory_stats` to check for pending proposals needing attention.
5. If pending proposals exist, briefly list them and ask: "Want to review these first?"
6. Summarize loaded memories and how they inform the current task.

## Key Rules

- Always pass file paths when available — they improve context relevance.
- Run targeted stale checks for open paths; stale memory should be surfaced before it influences the task.
- Don't skip `memory_stats` — stale proposals cause governance drift.
- If no memories return, that's fine — proceed with the task normally.
- Never fabricate memory IDs; only reference what `memory_context` actually returned.
