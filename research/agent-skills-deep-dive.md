# Agent Skills Deep Dive

Snapshot date: 2026-06-10

Repo: https://github.com/addyosmani/agent-skills

Primary sources:
- README: https://github.com/addyosmani/agent-skills
- Skill anatomy: https://raw.githubusercontent.com/addyosmani/agent-skills/main/docs/skill-anatomy.md
- Meta-skill: https://raw.githubusercontent.com/addyosmani/agent-skills/main/skills/using-agent-skills/SKILL.md
- Context engineering skill: https://raw.githubusercontent.com/addyosmani/agent-skills/main/skills/context-engineering/SKILL.md
- Plugin manifest: https://raw.githubusercontent.com/addyosmani/agent-skills/main/.claude-plugin/plugin.json
- Marketplace manifest: https://raw.githubusercontent.com/addyosmani/agent-skills/main/.claude-plugin/marketplace.json

## Executive Fit

`addyosmani/agent-skills` is the strongest reference for triMemh's adoption
layer. It is not a memory engine, but it shows how to package agent workflows so
users can install, discover, and trust them.

triMemh currently has four skills:
- `remember`
- `recall`
- `handoff`
- `session-history`

Those are useful but minimal. Agent Skills shows how to make a skill pack feel
production-grade: explicit triggers, workflow steps, red flags, verification,
anti-rationalization tables, supporting references, commands, agents/personas,
and marketplace metadata.

## What Agent Skills Is

Agent Skills is a pack of engineering workflows for AI coding agents. The README
organizes it around seven lifecycle commands:
- `/spec`
- `/plan`
- `/build`
- `/test`
- `/review`
- `/code-simplify`
- `/ship`

It also includes 23 skills across phases:
- Define.
- Plan.
- Build.
- Verify.
- Review.
- Ship.

The key point is that skills are not long essays. They are procedural workflows
with triggers and proof requirements. The repo also ships:
- `skills/` directory.
- `agents/` personas.
- `references/` checklists.
- `.claude/commands/`.
- `.gemini/commands/`.
- setup docs for multiple tools.
- `.claude-plugin/plugin.json` and marketplace metadata.

## Strong Ideas To Clone

### 1. Skill Frontmatter With Activation Conditions

Agent Skills requires a frontmatter contract:
- `name`
- `description`

The description must tell the agent what the skill does and when to activate it.

Clone target for triMemh:
- Add frontmatter to every `skills/*/SKILL.md`.
- Make descriptions specific enough for auto-discovery.
- Keep `name` equal to directory name.

Example target shape:

```markdown
---
name: recall
description: Loads triMemh project memory. Use when starting a task, switching context, debugging repeated mistakes, or needing prior decisions, code context, procedures, or session summaries.
---
```

### 2. Skill Anatomy Standard

Agent Skills documents a repeatable anatomy:
- Overview.
- When to Use.
- Core Process.
- Common Rationalizations.
- Red Flags.
- Verification.
- Supporting files only when they reduce token load.

Clone target for triMemh:
- Add `docs/skill-anatomy.md` or `research/skill-anatomy.md` for triMemh.
- Update current skills to follow one pattern.
- Add verification checklists to skills that currently only have short steps.

Why this matters:
- Current triMemh skills are concise, but too thin for public reuse.
- Verification makes the skill operational, not merely descriptive.

### 3. Meta-Skill For Discovery

Agent Skills has `using-agent-skills`, a meta-skill that maps tasks to the right
skill. triMemh should have the same.

Clone target:
- Add `skills/using-trimemh/SKILL.md`.
- Include task routing:
  - start task -> `recall`
  - durable fact/decision -> `remember`
  - handoff/compaction -> `handoff`
  - previous sessions -> `session-history`
  - code impact -> MCP `memory_code_impact`
  - compressed details -> MCP `memory_retrieve`
  - post-task close -> `memory_session_close`

Why this matters:
- Users should not need to know all triMemh tools upfront.
- The meta-skill can encode governance-first behavior.

### 4. Anti-Rationalization Tables

Agent Skills explicitly documents excuses agents use to skip steps and counters
them with concrete reality checks.

Clone target:
- Add anti-rationalization sections to triMemh skills.

Examples:

| Rationalization | Reality |
|---|---|
| "This task is simple, no need to call memory_context." | Simple tasks still depend on project decisions and prior mistakes. |
| "I can save this memory directly." | triMemh is governance-first; use proposals unless explicitly bypassed. |
| "The compressed summary is enough." | If the task depends on exact wording, retrieve the full memory. |

### 5. Verification Gates

Agent Skills treats evidence as mandatory. This maps perfectly to triMemh.

Clone target:
- Each skill ends with proof requirements.
- `recall`: show which memory IDs informed the task and provide feedback.
- `remember`: proposal created, rationale/evidence included, risk appropriate.
- `handoff`: summary includes files, decisions, blockers, next checks, no secrets.
- `session-history`: conflicts with repo state are called out.

### 6. Commands As Workflow Entry Points

Agent Skills uses slash commands as high-level workflows that activate skills.

Clone target:
- Add optional command templates under `.claude/commands` or equivalent:
  - `/memh-recall`
  - `/memh-remember`
  - `/memh-handoff`
  - `/memh-review-proposals`
  - `/memh-impact`
  - `/memh-learn`

These should be thin wrappers around MCP/CLI workflows, not a second product.

### 7. Plugin Manifest

The Agent Skills plugin manifest points to commands, skills, and agents. triMemh
could ship a similar manifest for users who install skills via marketplace-like
flows.

Clone target:
- Add `.claude-plugin/plugin.json`.
- Add `.claude-plugin/marketplace.json` only when the package is ready for a
  public marketplace.
- Keep metadata minimal and truthful.

Potential triMemh plugin manifest fields:
- name: `trimemh`
- description: local-first governance-first agent memory workflows
- commands: `./.claude/commands`
- skills: `./skills`

## What Not To Clone

### Do Not Clone The Full Engineering Skill Pack

triMemh should not become a generic engineering-process skill pack. That would
blur the product and create unnecessary maintenance.

Good boundary:
- triMemh skills teach memory, governance, retrieval, handoff, and project
  continuity.

Bad boundary:
- triMemh reimplements TDD, frontend, security, CI/CD, and deployment skills.

### Do Not Add Large Reference Files Prematurely

Agent Skills uses references well, but triMemh should keep references lean until
there are enough workflows to justify them.

Start with:
- `references/memory-protocol.md`
- `references/memory-kind-guide.md`
- `references/governance-risk-guide.md`

### Do Not Make Commands Required

Commands are an adoption layer. MCP tools and CLI should remain the canonical
implementation.

## triMemh Current Gap List

1. Skills lack frontmatter, which weakens auto-discovery.
2. Skills lack a shared anatomy and verification requirements.
3. No meta-skill routes users across memory workflows.
4. No public plugin manifest for skill-only installation.
5. No command entry points that compose common workflows.
6. No skill-specific references for memory kind selection and governance risk.

## Suggested Roadmap

P0:
- Add frontmatter to current skills.
- Add `skills/using-trimemh/SKILL.md`.
- Add verification and anti-rationalization sections to current skills.

P1:
- Add `.claude-plugin/plugin.json`.
- Add command templates for common memory workflows.
- Add `references/memory-kind-guide.md`.

P2:
- Add marketplace metadata.
- Add persona/reviewer files for memory governance review.
- Add install tests that validate skill frontmatter and plugin manifest.

## Example Skill Pack Shape

```text
skills/
  using-trimemh/
    SKILL.md
  recall/
    SKILL.md
  remember/
    SKILL.md
  handoff/
    SKILL.md
  session-history/
    SKILL.md
references/
  memory-kind-guide.md
  governance-risk-guide.md
.claude-plugin/
  plugin.json
  marketplace.json
.claude/
  commands/
    memh-recall.md
    memh-handoff.md
```

## Product Positioning Lesson

Agent Skills makes the workflow feel concrete because it maps user intent to
commands and skill phases. triMemh can use the same pattern:

- "Start work with memory context."
- "Capture durable project knowledge."
- "Close a session with a compact handoff."
- "Review pending memory proposals."
- "Explain memory-backed code impact."
- "Learn from failed sessions."

That gives triMemh a clearer mental model than "15 MCP tools are available."

## Open Questions

1. Should triMemh skills be packaged inside the npm package only, or also as a
   standalone skill/plugin repo?
2. Should the skill pack install by default in `trimemh install`, or be opt-in?
3. Should command templates call MCP tools directly, CLI fallback commands, or
   both?
4. How strict should skill verification be before it becomes annoying?

