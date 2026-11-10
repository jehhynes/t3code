---
name: final-checks
description: Run the full checks on a T3 Code fork branch's final tree before it is reported ready for review or pushed.
---

# Final checks

1. When `git diff origin/switchboard...HEAD` changes `apps/server/src/persistence/` and the checkout's dev server runs, restart it, because the server applies pending migrations only when it starts; a stopped server applies them at its next start.
2. Run `vp run check:changed origin/switchboard` on HEAD's tree with no uncommitted changes, because it also checks uncommitted and untracked files.
3. Report a pass with the output of `git rev-parse HEAD^{tree}`, or each failure with its step name, its command and the end of its output, and fix no failure.
