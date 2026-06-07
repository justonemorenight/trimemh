# triMemh Handoff

Use this skill near the end of a work session or before compaction.

1. Summarize only durable context: goal, completed work, files touched, decisions, blockers, and next checks.
2. Propose the summary with `memory_propose` as `session_summary`.
3. Do not include raw secrets, logs, or full tool output.
4. If uncertain, set `require_review: true`.
