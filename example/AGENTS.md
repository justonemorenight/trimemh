# triMemh Memory Protocol

This project uses **triMemh** for persistent agent memory (SQLite, local-first).
Your MCP tools (`memory_*`) are pre-configured — just use them.

## Every task

1. `memory_context` — call FIRST with task description + open file paths
2. `memory_search mode:"hybrid"` — find relevant past decisions/context
3. `memory_list_proposals` — review pending governance items
4. If context shows `[compressed — retrieve with memory_retrieve("id")]`, fetch full text before relying on it

## End of task

- `memory_session_close` — compact summary + files + decisions + tooling in one call
- `memory_feedback` — rate memories that helped or misled

## Memory kinds

- `tooling` — Biome/Tailwind/ky/setup config (not session narrative)
- `decision` — product/engineering choices with rationale
- `session_summary` — turn/session narrative only
- `require_review: true` — force pending; low/medium auto-approve by default

## Storage

- DB: `<project-root>/.trimemh/memory.db`
- Config: `<project-root>/.memh.toml`

## Proposing memories

Search before proposing (avoid duplicates). Only propose **durable** knowledge:
- Decisions with rationale, procedures, mistakes + fixes, code context (WHY)
- Use `memory_propose` → `memory_list_proposals` → `memory_approve`/`memory_reject`
- Set `require_review: true` for security, financial, or uncertain claims

**Never store**: secrets, credentials, tokens, transient debug output, raw logs, speculation.

## After finishing

- `memory_feedback` — rate memories that helped or misled (trains scoring)
- Review any pending proposals before ending

## Rules

- Memory ≠ truth. Current code + user instructions always override memory.
- If a memory is stale, propose a replacement linked with `supersedes`.
- High/critical risk proposals (`procedure`, `mistake`, `trade_rule`, `security_rule`) are never auto-approved.
- Reject proposals with a note explaining why — future agents need context.

MCP namespace: `mcp__trimemh__*`. CLI fallback: `trimemh recall "query"`.
