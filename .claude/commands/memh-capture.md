# Capture Durable Project Knowledge

Propose a new memory for long-term retention.

## Steps

1. Identify what to capture: decision, procedure, mistake, fact, preference, code_context, trade_rule, security_rule, or other kind.
2. Pick the **narrowest** kind that fits — prefer `decision` over `fact`, `mistake` over `decision` when a failure occurred.
3. Write concise memory text that will be useful months from now. Avoid vague language.
4. Write a rationale explaining **why** this is worth remembering.
5. Include evidence: source file path, conversation context, or user statement.
6. Call `memory_propose` with: kind, text, rationale, and evidence fields.
7. Report the proposal ID and risk level to the user.
8. If risk is **high** (procedure, mistake, trade_rule, security_rule), remind: "Run `/memh-review` to approve this proposal."

## Key Rules

- Never write memory directly — always use `memory_propose`.
- One memory per concept. Don't bundle unrelated facts.
- Evidence must be verifiable — cite files, lines, or user quotes.
- Don't capture secrets, tokens, passwords, or ephemeral tool output.
