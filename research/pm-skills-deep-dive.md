# PM Skills Deep Dive

Snapshot date: 2026-06-10

Repo: https://github.com/phuryn/pm-skills

Primary sources:
- README: https://github.com/phuryn/pm-skills
- Marketplace manifest: https://raw.githubusercontent.com/phuryn/pm-skills/main/.claude-plugin/marketplace.json
- Product discovery plugin manifest: https://raw.githubusercontent.com/phuryn/pm-skills/main/pm-product-discovery/.claude-plugin/plugin.json
- Product discovery plugin README: https://raw.githubusercontent.com/phuryn/pm-skills/main/pm-product-discovery/README.md
- PM AI shipping section in README: https://github.com/phuryn/pm-skills

## Executive Fit

`phuryn/pm-skills` is not directly aligned with triMemh's memory engine. Its
strongest value is marketplace architecture: many domain workflows, grouped into
installable plugins, with commands that chain multiple skills.

This is useful for triMemh if we want a public "memory workflow marketplace" or
first-party packs:
- core memory workflows,
- governance workflows,
- code-intel workflows,
- research workflows,
- shipping/audit workflows.

The product-management domain is secondary. The distribution and taxonomy model
is the part to study.

## What PM Skills Is

PM Skills presents itself as a marketplace for structured product-management
workflows. The public README and manifest describe:
- 68 domain-specific skills.
- 42 chained workflows.
- 9 plugins.
- Claude Code/Cowork-oriented installation.
- Commands that chain skills end-to-end.

The marketplace manifest groups plugins such as:
- `pm-product-discovery`
- `pm-product-strategy`
- `pm-execution`
- `pm-market-research`
- `pm-data-analytics`
- `pm-go-to-market`
- `pm-marketing-growth`
- `pm-toolkit`
- `pm-ai-shipping`

The product discovery plugin is a good example of a self-contained pack:
- `.claude-plugin/plugin.json`
- `skills/`
- `commands/`
- `README.md`

## Strong Ideas To Clone

### 1. Multi-Plugin Marketplace Manifest

PM Skills uses a root marketplace manifest that points to many plugin folders.
Each plugin has a category, source path, and description.

Clone target for triMemh:
- Create a root manifest once we have more than one workflow pack.
- Keep each pack separately installable.

Potential triMemh packs:
- `trimemh-core`: recall, remember, handoff, session history.
- `trimemh-governance`: proposals, approvals, conflict review, risk gates.
- `trimemh-code-intel`: code links, impact radius, code-path memories.
- `trimemh-learning`: session mining, failure correction, feedback loops.
- `trimemh-research`: source-backed research capture and evidence extraction.
- `trimemh-shipping`: shipping packet, intended-vs-implemented memory review.

Why this matters:
- triMemh's tool count can feel abstract. Packs make workflows discoverable.
- Users can install only the workflows they need.

### 2. Commands That Chain Skills

PM Skills commands compose several skills into a full workflow. Example:
discovery combines ideation, assumption identification, prioritization, and
experiments.

Clone target:
- Build triMemh commands as "workflow chains" rather than single-tool aliases.

Potential commands:
- `/memh-start`: call memory_context, hybrid search, review pending proposals.
- `/memh-capture`: propose memory with kind/risk/evidence guidance.
- `/memh-close`: create session summary, decisions, tooling, code-link hints.
- `/memh-impact`: run code impact and related memory graph lookup.
- `/memh-learn`: run failure mining and review proposed corrections.
- `/memh-audit`: inspect memories relevant to changed files and stale decisions.

Why this matters:
- Commands can encode the right order of operations.
- They make governance-first behavior easier than ad hoc tool use.

### 3. Domain Taxonomy

PM Skills is easy to scan because it groups work by domain. triMemh can do the
same for memory work.

Clone target:
- Define a triMemh taxonomy:
  - Recall.
  - Capture.
  - Govern.
  - Link to code.
  - Learn from sessions.
  - Handoff.
  - Audit/review.
  - Research.

Why this matters:
- Taxonomy can drive docs, CLI help, skill organization, and marketplace packs.

### 4. Plugin-Level READMEs

Each PM plugin describes its skills and commands in a small README. triMemh
should mirror this when workflows grow.

Clone target:
- Add README files for each future triMemh pack.
- Keep them practical:
  - purpose,
  - skills,
  - commands,
  - examples,
  - when to install.

### 5. PM AI Shipping Kit Pattern

The `pm-ai-shipping` plugin is especially relevant. It focuses on making
AI-built apps reviewable by documenting intended behavior, then auditing gaps
between intent and implementation.

Clone target:
- Adapt this into a triMemh memory/code audit workflow:
  - collect relevant memories for changed files,
  - identify decisions and constraints,
  - compare code state against remembered intent,
  - flag stale or contradicted memories,
  - propose updates or supersession links.

Why this matters:
- triMemh already has memory-code links and impact radius tools.
- "Intended vs implemented" is a natural use case for memory-backed review.

### 6. Companion "Brain" Concept

PM Skills mentions a companion markdown "brain" approach. triMemh should not
replace its SQLite/vector memory with plain markdown, but the idea of exporting
or projecting memory into human-readable files is useful.

Clone target:
- Add optional memory projections:
  - `MEMORY.md` summary,
  - `docs/decisions.md`,
  - `docs/procedures.md`,
  - `docs/project-map.md`.

Guardrail:
- The database remains source of truth.
- Markdown projections are generated views, not authoritative storage.

## What Not To Clone

### Do Not Clone PM Domain Content By Default

Most PM workflows are outside triMemh's core product. Pulling them in would make
the product noisy.

Keep PM-like workflows only when they serve memory:
- decision capture,
- PRD-to-memory extraction,
- launch/shipping review,
- research evidence capture.

### Do Not Create 50+ Skills Before The Core Is Excellent

PM Skills works because it is a marketplace. triMemh should not start there.
First make 5-8 memory workflows excellent.

### Do Not Treat Marketplace Install As Trust

Skill marketplaces create a security surface. triMemh should treat third-party
skills as untrusted unless reviewed. This is especially important because memory
tools can persist knowledge across sessions.

Potential guardrails:
- manifest validation,
- source pinning,
- risk labels,
- read-only preview before install,
- warning for skills that invoke shell/network/write operations,
- governance review for memory-writing skills.

## triMemh Current Gap List

1. No marketplace/catalog concept.
2. No workflow-pack taxonomy.
3. No command chains that combine multiple MCP tools.
4. No plugin-level READMEs.
5. No memory audit workflow based on intended-vs-implemented gaps.
6. No human-readable memory projection files.

## Suggested Roadmap

P0:
- Define the triMemh workflow taxonomy.
- Create one first-party pack manifest for current skills.
- Add a plugin-level README for the core pack.

P1:
- Add command chains for start/capture/close/impact/learn.
- Add an `intended-vs-implemented` memory audit workflow.
- Add memory projection command in dry-run mode.

P2:
- Add marketplace root manifest with multiple first-party packs.
- Add third-party pack validation.
- Add governance rules for skills that write memories.

## Proposed First-Party Packs

### `trimemh-core`

Purpose:
- Basic memory usage for daily agent work.

Skills:
- using-trimemh
- recall
- remember
- handoff
- session-history

Commands:
- `/memh-start`
- `/memh-capture`
- `/memh-close`

### `trimemh-governance`

Purpose:
- Review, approve, reject, supersede, and audit memory changes.

Skills:
- proposal-review
- conflict-review
- risk-classification
- memory-supersession

Commands:
- `/memh-review-proposals`
- `/memh-conflicts`
- `/memh-supersede`

### `trimemh-code-intel`

Purpose:
- Connect memory to code paths and review impact.

Skills:
- code-memory-linking
- impact-radius
- stale-code-context-review

Commands:
- `/memh-impact`
- `/memh-link-code`
- `/memh-audit-files`

### `trimemh-learning`

Purpose:
- Learn from failed sessions and feedback.

Skills:
- failure-learning
- feedback-loop
- session-mining

Commands:
- `/memh-learn`
- `/memh-feedback`

## Open Questions

1. Should triMemh ship a single plugin first, or immediately model packs?
2. Should marketplace metadata live in this repo or a separate distribution repo?
3. How should we validate third-party memory skills before allowing them to write
   proposals?
4. Should human-readable projections be committed to repos or generated locally?

