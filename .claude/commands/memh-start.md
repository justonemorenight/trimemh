# Start Task with Memory Context

Load relevant memories before beginning work.

## Steps

1. Call `memory_context` with the current task description and any open file paths as context.
2. Review returned memories — note IDs of relevant ones for reference during the task.
3. Call `memory_stats` to check for pending proposals needing attention.
4. If pending proposals exist, briefly list them and ask: "Want to review these first?"
5. Summarize loaded memories and how they inform the current task.

## Key Rules

- Always pass file paths when available — they improve context relevance.
- Don't skip `memory_stats` — stale proposals cause governance drift.
- If no memories return, that's fine — proceed with the task normally.
- Never fabricate memory IDs; only reference what `memory_context` actually returned.
