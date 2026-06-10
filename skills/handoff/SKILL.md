---
name: handoff
description: >-
  Create a session handoff summary before ending work.
  Use near the end of a work session, before compaction,
  or when handing off to another agent or future session.
---

# triMemh Handoff

Use this skill near the end of a work session or before compaction.

1. Summarize only durable context: goal, completed work, files touched, decisions, blockers, and next checks.
2. Propose the summary with `memory_propose` as `session_summary`.
3. Do not include raw secrets, logs, or full tool output.
4. If uncertain, set `require_review: true`.

## Verification

Before submitting the handoff, confirm:

- [ ] Summary includes the list of files touched during the session.
- [ ] Decisions made during the session are captured as separate `decision` memories (not buried in the summary).
- [ ] No secrets, tokens, passwords, or API keys appear anywhere in the summary.
- [ ] Blockers and next steps are explicitly listed.
- [ ] Summary is concise — no raw logs or full tool output included.

## Anti-Rationalization

| Excuse | Reality |
|---|---|
| "The session was short, no handoff needed." | Even short sessions produce decisions or context that will be lost without a summary. |
| "I'll include the API key so the next session can use it." | Never store secrets in memory. Reference the secret's location (e.g., env var name) instead. |
| "I'll put all the decisions in the summary to save time." | Decisions deserve their own `decision` memories for searchability and governance. |
| "The next agent can just look at the repo." | Repo state doesn't capture *why* changes were made or what's blocked. Handoff fills that gap. |
