---
name: recall
description: >-
  Load triMemh project memory before starting work.
  Use when starting a task, switching context, debugging
  repeated mistakes, or needing prior decisions, code context,
  procedures, or session summaries.
---

# triMemh Recall

Use this skill when a task may depend on prior project decisions, mistakes, preferences, procedures, or code context.

1. Call `memory_context` with the current task and open file paths.
2. Call `memory_search` with `mode: "hybrid"` for focused follow-up queries.
3. Use `memory_retrieve` only when compressed context says the full text is needed.
4. Treat repository state and explicit user instructions as higher priority than memory.

## Verification

Before proceeding with the task, confirm:

- [ ] Memory IDs that informed the task are noted (for traceability).
- [ ] Feedback provided via `memory_feedback` for useful or irrelevant memories.
- [ ] Compressed details were retrieved with `memory_retrieve` when the task depends on exact wording.
- [ ] Conflicts between memory and repository state are resolved in favor of repo state.

## Anti-Rationalization

| Excuse | Reality |
|---|---|
| "I already know this codebase, no need to recall." | Your context resets every session. Always call `memory_context` first. |
| "Searching is slow, I'll just start coding." | Skipping recall risks repeating mistakes or contradicting prior decisions. |
| "The compressed summary is good enough." | If exact wording matters (procedures, rules), use `memory_retrieve` for the full text. |
| "I'll give feedback later." | There is no later — call `memory_feedback` in this session or the signal is lost. |
