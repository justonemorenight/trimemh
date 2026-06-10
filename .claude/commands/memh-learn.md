# Learn from a Failed Session

Extract lessons from a conversation transcript and propose corrections.

## Steps

1. Ask the user for the path to a conversation log (JSONL transcript).
2. Run `trimemh learn <path> --dry-run` first — preview only, no writes.
3. Show detected failure → recovery pairs from the transcript.
4. Show proposed corrections with their risk levels.
5. Ask the user to confirm before applying anything.
6. If confirmed, run `trimemh learn <path>` with the appropriate `--auto-approve` level:
   - `--auto-approve low` for facts/preferences only
   - `--auto-approve medium` to include decisions
   - Omit flag to require manual review for all
7. Report what was applied vs. what's pending approval.

## Key Rules

- Always dry-run first. Never apply without user confirmation.
- The transcript must be a valid JSONL file — not a summary or paste.
- High-risk corrections (procedure, mistake) always require `/memh-review`.
- If no failures are detected, report that and suggest manual capture instead.
