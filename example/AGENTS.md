---
name: trimemh-memory-protocol
description: |
  Protocol for AI coding agents using triMemh — a local-first, governance-first
  memory system. Covers 14 MCP tools, proposal workflow, auto-approve rules,
  memory kinds, and cross-agent conventions. Copy this file into any project
  root as `AGENTS.md` when agents should share a triMemh memory space.
---

# triMemh Memory Protocol

You are an AI coding agent working in a project that uses **triMemh** — a
local-first, governance-first memory system. triMemh gives you persistent memory
across sessions and across agents. Every memory lives on this machine (SQLite +
sqlite-vec), with zero cloud dependencies.

Your memory tools are already configured. You do NOT need to install or configure
anything. Just use them.

## Your Tools

You have 14 MCP tools available. They may appear as bare names (`memory_search`)
or with a prefix (`mcp__trimemh__memory_search`) — treat both as the same tool.

### Core retrieval (use every task)

| Tool | When to call |
|---|---|
| `memory_context` | Call at the START of every task with the current task description and open file paths. Returns compressed context XML. |
| `memory_search` | Call when you need prior decisions, mistakes, procedures, preferences, or facts. Use `mode: "hybrid"` for best results (FTS5 + vector RRF fusion). |
| `memory_code_search` | Call when working in a known file or symbol. Finds memories linked to that code. |
| `memory_retrieve` | Call when context says a memory was compressed/deferred and you need the FULL original text before relying on it. |
| `memory_related` | Call when a memory points to a broader decision chain. Traversal depth is capped at 2. |
| `memory_get` | Call to fetch a specific memory's full detail by ID. |
| `memory_stats` | Call for a quick overview of active memories and pending proposal counts. |

### Writing & governance (propose → review → decide)

| Tool | When to call |
|---|---|
| `memory_propose` | Call to suggest a NEW memory. May be auto-approved (if enabled + low/medium risk + confidence ≥ 0.3) or go to `pending` for your review. Set `require_review: true` to force manual review. |
| `memory_link_propose` | Call to link two memories. Auto-approved by default, except `supersedes` and `contradicts` which always need review. |
| `memory_code_link_propose` | Call to link a memory to a code entity (file, function, class, module, section). Auto-approved by default when enabled. |
| `memory_list_proposals` | Call AFTER proposing to review pending proposals in your next turn. |
| `memory_approve` | Call to approve a proposal you have reviewed and found correct. |
| `memory_reject` | Call to reject a proposal that is incorrect, redundant, or low-quality. Always include a note explaining why. |

### Feedback (improves future retrieval)

| Tool | When to call |
|---|---|
| `memory_feedback` | Call after using memories to rate whether each was truly useful. This trains the scoring system — useful memories rise, stale ones decay. |

## Protocol

### At the start of every task

1. Call `memory_context` with the current task description and open file paths.
2. Call `memory_search` with `mode: "hybrid"` for knowledge relevant to this task.
3. Call `memory_code_search` if you are working in a specific file or symbol.
4. Scan the returned context for compressed/deferred markers — note which memory
   IDs you may need to `memory_retrieve` later.

### While working

- If a memory detail was compressed, call `memory_retrieve` before depending on
  it. Do NOT guess the missing content.
- When you encounter a memory that relates to others, use `memory_related` to
  traverse the decision chain.
- **Memory is NOT more authoritative than the repository or explicit user
  instructions.** Current code and user direction always take precedence.
- If you find a memory is stale or wrong, propose a correction or supersede it.

### Before finishing a task

1. Call `memory_feedback` for every memory that materially helped or misled you.
   Include a short reason.
2. Propose new memories ONLY for durable knowledge that future agents (or your
   future self) should not rediscover.
3. Call `memory_list_proposals` to review any pending proposals and decide:
   - `memory_approve` — true, durable, useful, not sensitive
   - `memory_reject` — stale, duplicate, speculative, vague, secret-bearing

## What to remember

**Good candidates:**
- Stable project decisions with rationale.
- Repeated procedures, workflows, local setup quirks.
- Mistakes you made, failed approaches, and the fix that worked.
- Code context that explains WHY a file, symbol, or API behaves a certain way.
- User preferences that should shape future work.
- Security or trading rules — only when explicit and well evidenced.

**NEVER store:**
- Secrets, credentials, private keys, tokens, or session cookies.
- Temporary task chatter, one-off commands, or transient debug output.
- Large raw logs or pasted files when a short summary suffices.
- Speculation unchecked against code, tests, docs, or the user.
- Personal or sensitive information unless explicitly requested.

## Memory kinds and risk levels

Use the narrowest accurate kind. High and critical risk proposals are never
auto-approved — they will always show up in `memory_list_proposals` for you to
review carefully before deciding.

| Kind | Risk | Use for |
|---|---|---|
| `preference` | low | User/team preferences |
| `fact` | low | Stable project facts |
| `decision` | medium | Architecture/product decisions |
| `session_summary` | medium | End-of-session summaries |
| `code_context` | medium | Explanations tied to code |
| `procedure` | high | Repeatable workflows |
| `mistake` | high | Known failures and their fixes |
| `trade_rule` | critical | Trading/business execution rules |
| `security_rule` | critical | Security requirements or constraints |

When in doubt, set `require_review: true`.

## Proposal quality bar

Before calling `memory_propose`:

1. **Search first** with `memory_search` — a memory may already cover this.
2. **Prefer updating** stale knowledge over creating duplicates. If an existing
   memory is close but wrong, propose a replacement and link it via
   `memory_link_propose` with `supersedes`.
3. **Write concisely** — a durable statement, not a chat message.
4. **Include evidence** in the text when the claim needs backing.
5. **Link to code** with `memory_code_link_propose` when a specific file or
   symbol is relevant.

Examples:

```
✗ Bad:  "We changed the memory stuff today." (kind: fact)
✓ Good: "This project gates MCP memory writes as governance proposals;
         agents must approve or reject pending proposals before they become
         active." (kind: decision)
```

## Auto-Approve & Agent Review

triMemh has a built-in auto-approval system that decides whether a proposal
becomes active immediately or waits in `pending` for your review.

### Default behavior (auto-approve OFF)

By default, `autoApprove.enabled` is **false**. This means **every proposal you
make goes to `pending`** — you MUST review it yourself in your next turn with
`memory_list_proposals` → `memory_approve` / `memory_reject`.

This is the governance-first model: no memory enters the system without explicit
review, even low-risk ones.

### When auto-approve IS enabled

The project may enable auto-approve via `TRIMEMH_AUTO_APPROVE` env var or
config. When enabled, the decision works as follows:

| Condition | Result |
|---|---|
| `require_review: true` | Always goes to `pending` — you explicitly asked for review |
| `confidence < 0.3` | Goes to `pending` — confidence too low for auto-approve |
| Risk ≤ `maxRiskLevel` (default: `medium`) | **Auto-approved** — active immediately, no review needed |
| Risk = `high` or `critical` | Goes to `pending` — must be reviewed |

In practice, when auto-approve is on:
- `preference`, `fact` (low) → auto-approved
- `decision`, `session_summary`, `code_context` (medium) → auto-approved
- `procedure`, `mistake` (high) → **pending, you must review**
- `trade_rule`, `security_rule` (critical) → **pending, you must review**

### Link proposal auto-approve

Link proposals (`memory_link_propose`, `memory_code_link_propose`) are
auto-approved by default when the feature is enabled, with two exceptions that
ALWAYS require review:

- `supersedes` — replacing another memory is high-impact
- `contradicts` — recording a conflict requires verification

### How to force review

Set `require_review: true` on ANY proposal to bypass auto-approve entirely:

```
memory_propose(kind="decision", text="...", require_review=true)
```

Use this when:
- You are uncertain about the memory's accuracy
- The memory involves security, money, or irreversible decisions
- You want a second opinion (another agent or human should weigh in)
- The confidence score is borderline

### Your review responsibility

Even when auto-approve is ON, you remain responsible for:

1. **After proposing** — check `memory_list_proposals` in your next turn.
   Auto-approved proposals won't appear (they're already active), but any that
   landed in `pending` need your decision.

2. **Reviewing high/critical proposals** — these are NEVER auto-approved. Read
   them carefully. They affect security policy or business rules.

3. **Rejecting with a note** — always explain WHY you rejected. Future agents
   (or your future self) will see the note and learn.

4. **Verifying auto-approved memories** — if you later find an auto-approved
   memory is wrong, propose a correction with `supersedes` and set
   `require_review: true`.

### Quick decision guide

| Situation | Action |
|---|---|
| Proposal is true, durable, useful | `memory_approve` |
| Proposal is stale, duplicate, vague | `memory_reject` + note |
| Proposal contains secrets | `memory_reject` + note immediately |
| Proposal is close but needs refinement | `memory_reject` + note, then re-propose |
| Unsure — want human input | Leave it `pending`, tell the user |
| Memory supersedes an existing one | Propose link with `supersedes` + `require_review: true` |

## Cross-agent awareness

- Other agents (Claude Code, Cursor, Codex, Copilot, Aider) may share this
  project's memory. They read what you write.
- Prefer `team` visibility for project knowledge other agents should see.
- If you see two similar proposals from different agents, approve the clearer
  one and reject the duplicate with a note.
- Provenance metadata (`proposed_by`) tracks which agent proposed what —
  consider the source when weighing a claim.

## Critical Constraints

These rules are non-negotiable. Violating them corrupts the memory system for
every agent sharing this project.

### ALWAYS

- **ALWAYS** call `memory_context` at the start of every task — context is
  compressed to save tokens, but you need it to ground your work.
- **ALWAYS** call `memory_search` before proposing a new memory — duplicates
  waste review effort and dilute retrieval quality.
- **ALWAYS** call `memory_list_proposals` after proposing — proposals may have
  landed in `pending` and need your review.
- **ALWAYS** include a rejection note when calling `memory_reject` — future
  agents (including your future self) need to understand why.
- **ALWAYS** call `memory_retrieve` before depending on a compressed/deferred
  memory detail — never guess the missing content.
- **ALWAYS** call `memory_feedback` for memories that materially helped or
  misled the task — the scoring system depends on your signal.
- **ALWAYS** prefer updating or superseding stale memories over creating
  near-duplicates.
- **ALWAYS** set `require_review: true` when the memory involves security
  policy, financial rules, or anything you are uncertain about.

### NEVER

- **NEVER** store secrets, credentials, API keys, tokens, private keys, or
  session cookies in memory. Reject any proposal that contains them.
- **NEVER** approve a proposal you have not read and understood. High and
  critical risk proposals require especially careful review.
- **NEVER** treat a memory as more authoritative than the current codebase or
  an explicit user instruction. Memories document the past; they do not
  override the present.
- **NEVER** propose a memory based on speculation unchecked against code, tests,
  documentation, or the user.
- **NEVER** store large raw logs, stack traces, or pasted files when a short
  durable summary is enough.
- **NEVER** auto-approve a `supersedes` or `contradicts` link without verifying
  both endpoints — these are high-impact relationships.
- **NEVER** use `memory_propose` for transient task chatter or one-off
  debugging notes. Memory is for durable knowledge only.
