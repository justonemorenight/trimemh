---
name: using-trimemh
description: >-
  Master routing skill for triMemh — the local-first,
  governance-first agent memory system. Use this skill
  to determine which triMemh skill or MCP tool to invoke
  for any memory-related task.
---

# Using triMemh

triMemh is a local-first, governance-first agent memory system. This skill routes you to the correct sub-skill or MCP tool based on the task at hand.

## Task Routing

| Intent | Skill / Tool |
|---|---|
| User says "remember this" or a durable decision emerges | **remember** skill → `memory_propose` |
| Starting a task, switching context, need prior knowledge | **recall** skill → `memory_context`, `memory_search`, `memory_retrieve` |
| End of session, before compaction, handing off | **handoff** skill → `memory_propose` (as `session_summary`) |
| "What happened last session?" or cross-agent continuity | **session-history** skill → `memory_search`; CLI fallback: `trimemh session history` |
| Check what files a memory touches | `memory_code_impact` tool directly |
| View memory system statistics | `memory_stats` tool directly |
| Rate a memory's usefulness | `memory_feedback` tool directly |
| Close a session explicitly | `memory_session_close` tool directly |

## Governance-First Principles

1. **Propose, never write.** All memories go through `memory_propose`. No direct writes.
2. **High-risk kinds require review.** `procedure`, `mistake`, `trade_rule`, and `security_rule` are high-risk — they must remain pending until a human approves.
3. **Repo state outranks memory.** When memory contradicts the repository, trust the repository and flag the conflict.
4. **No secrets in memory.** Never store tokens, passwords, API keys, or credentials. Reference their location (env var, vault path) instead.

## Anti-Rationalization

| Excuse | Reality |
|---|---|
| "I don't need memory for this task." | Call `memory_context` anyway — you don't know what you've forgotten. |
| "I'll skip the proposal and just note it in chat." | Chat is ephemeral. If it matters next session, it must be proposed to triMemh. |
| "This rule doesn't apply to my situation." | The governance rules are absolute. No exceptions, no workarounds. |
| "I'll store the secret so the next agent can use it." | Secrets in memory are a security incident. Store a *reference*, never the value. |
| "I already checked memory earlier in this session." | Context drifts. Re-check if the task has shifted or new files are open. |

## MCP Tools Quick Reference

| Tool | Purpose |
|---|---|
| `memory_context` | Load relevant memories for a task + file paths |
| `memory_search` | Hybrid or semantic search across memories |
| `memory_retrieve` | Fetch full text of a specific memory by ID |
| `memory_propose` | Propose a new memory (never write directly) |
| `memory_feedback` | Rate a memory as useful, irrelevant, or outdated |
| `memory_session_close` | Explicitly close the current session |
| `memory_code_impact` | Check which files a memory references |
| `memory_stats` | View memory system statistics |
