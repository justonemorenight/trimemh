---
name: remember
description: >-
  Propose durable project knowledge to triMemh memory.
  Use when the user explicitly asks to remember something,
  or when a decision, procedure, mistake, or code context
  should be captured for future sessions.
---

# triMemh Remember

Use this skill when the user explicitly asks you to remember something, or when a durable project decision should be proposed.

1. Use `memory_propose`, never direct storage.
2. Pick the narrowest memory kind that fits: `preference`, `fact`, `decision`, `session_summary`, `code_context`, `procedure`, `mistake`, `trade_rule`, or `security_rule`.
3. Include concise rationale and evidence.
4. High-risk memories must remain pending for review.

## Verification

Before considering the proposal complete, confirm:

- [ ] Proposal was created via `memory_propose` (never written directly).
- [ ] Rationale field is populated and explains *why* this matters.
- [ ] Evidence is attached (code snippet, user quote, or link).
- [ ] Risk level matches the memory kind (`procedure`, `mistake`, `trade_rule`, `security_rule` → high-risk).
- [ ] High-risk proposals remain **pending** for human review — do not auto-approve.

## Anti-Rationalization

| Excuse | Reality |
|---|---|
| "I'll just write it directly — proposing is slower." | Direct writes bypass governance. Always use `memory_propose`. |
| "This is low-risk, no review needed." | If the kind is `procedure`, `mistake`, `trade_rule`, or `security_rule`, it is high-risk regardless of your assessment. |
| "The rationale is obvious, I can skip it." | Future sessions lack your current context. Always include rationale. |
| "I'll remember this myself across sessions." | You have no persistent memory outside triMemh. Propose it or lose it. |
