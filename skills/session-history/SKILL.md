---
name: session-history
description: >-
  Browse prior session summaries for continuity.
  Use when the user asks what happened in prior sessions
  or when needing cross-agent context continuity.
---

# triMemh Session History

Use this skill when the user asks what happened in prior sessions or wants continuity across agents.

1. Search with terms from the current task plus `session_summary`.
2. Prefer memories whose source includes `hook`, `session`, or the current agent name.
3. Fetch related memories when a session summary references decisions or code context.
4. Report uncertainty when memories conflict with current repository state.

## Verification

Before reporting session history to the user, confirm:

- [ ] Conflicts with current repository state are explicitly called out.
- [ ] Session IDs are referenced for traceability.
- [ ] Related decisions and code context are fetched when a summary references them.
- [ ] Gaps in history (missing sessions, unreviewed proposals) are disclosed.

## Anti-Rationalization

| Excuse | Reality |
|---|---|
| "The summary is enough, I don't need to fetch referenced decisions." | Summaries are compressed — referenced decisions and code context hold the real detail. |
| "The memory says X, so that's still true." | Repository state is the source of truth. Always cross-check before trusting memory. |
| "I'll skip the session IDs, the user doesn't care." | Session IDs enable the user to audit and trace history. Always include them. |
| "There are no conflicts, so I won't mention the repo check." | State explicitly that you checked and found no conflicts — silence looks like you skipped it. |
