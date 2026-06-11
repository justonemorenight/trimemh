# Check Memory-Code Impact

See which memories are linked to the files you're working on.

## Steps

1. Identify the file(s) the user is working on — from open editors or user input.
2. Call `memory_code_impact` for each relevant file path.
3. Show linked memories grouped by relation type: `documents`, `warns_about`, `implements`, `depends_on`.
4. Show related memories from the memory graph (neighbors of linked memories).
5. Call `memory_stale_detect` for the same file path (and symbol if known) to flag memories that are stale or contradicted by current code.
6. Suggest new code links if appropriate using `memory_code_link_propose`.

## Key Rules

- Always use absolute file paths when calling `memory_code_impact`.
- If no links exist, suggest creating them for important files.
- Stale memories should be flagged, not silently ignored.
- Don't propose links for ephemeral files (tests, scratch scripts) unless the user asks.
