# Close Session with Handoff Summary

Wrap up the current session and create a handoff for the next one.

## Steps

1. Summarize the session: **goal**, what was **accomplished**, what's **remaining**.
2. List all files created or modified during the session.
3. Capture any decisions made (with brief rationale for each).
4. Note blockers, open questions, or things to check next.
5. Call `memory_session_close` with: summary, files_touched, decisions, and handoff notes.
6. Report what was captured and the proposal status.

## Key Rules

- Do NOT include secrets, tokens, passwords, or full tool output in the summary.
- Keep the summary scannable — bullet points over paragraphs.
- Decisions should be phrased as statements: "Chose X because Y."
- Files list should use absolute paths.
- If the session had no meaningful work, it's OK to close with a brief note.
