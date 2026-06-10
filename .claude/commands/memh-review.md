# Review Pending Memory Proposals

Triage and resolve pending memory proposals.

## Steps

1. Call `memory_stats` to get the pending proposal count.
2. If no pending proposals, report "No pending proposals" and stop.
3. List each pending proposal showing: short ID, kind, risk level, text (truncated to ~80 chars), and rationale.
4. For each proposal, ask the user: **approve**, **reject**, or **skip**.
5. For approvals: call the approve endpoint with `decided_by` set to the user.
6. For rejections: ask for a brief reason, then call the reject endpoint with the reason.
7. After all proposals are handled, report the final tally: approved, rejected, remaining.

## Key Rules

- Present proposals one at a time for clarity.
- High-risk proposals (procedure, mistake, trade_rule, security_rule) should be flagged with ⚠️.
- Never auto-approve high-risk proposals — always require explicit user confirmation.
- If the user says "approve all", confirm once before batch-approving.
- Use `memory_retrieve` if the user wants to see the full text of a proposal.
