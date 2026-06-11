# Stale Memory Demo

This demo shows triMemh's wedge: **stale memory is a correctness bug**.

An AI coding agent can be worse than forgetful when it confidently follows old project knowledge. This fixture creates a memory linked to `auth.ts#validateSession`, refactors the code to remove that symbol, then runs stale-memory detection.

```bash
bun scripts/demo-stale-memory.ts
```

Expected shape:

```text
Created a memory linked to auth.ts#validateSession.
Now simulating a refactor from cookie sessions to bearer tokens...

Stale memory report
───────────────────
1/1 flagged (high=1, medium=0, low=0)

[high] code_context action=update_link
memory: auth.ts#validateSession validates cookie-based sessions; use it before touching auth middleware.
- missing_symbol: Linked code entity no longer exists: /tmp/trimemh-stale-memory-demo/src/auth.ts#validateSession

Takeaway: stale memory is a correctness bug. triMemh flags it before an agent trusts it.
```

The same check is available in normal project workflows:

```bash
trimemh lifecycle stale --path src/auth.ts
```

Agents can also call the MCP tool:

```text
memory_stale_detect(path="src/auth.ts")
```
