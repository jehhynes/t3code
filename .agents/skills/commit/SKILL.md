---
name: commit
description: Create a commit, write a commit message, or rebase or squash commits in the T3 Code fork, whenever the agent is about to do any of these.
---

# Commit changes

## Before each commit

- Let the pre-commit hook run, and never pass `--no-verify`; it formats and lints the staged files, and runs the repository-wide `vp run knip:check` when a code or manifest file is staged.
- Run, with the `test` skill, the existing tests that exercise the changed behavior when the change could make one of them fail; skip them when it could not, such as for a log message, a comment, a rename that the type check covers, or a change that no test exercises.
- Invoke the `final-checks` skill before you report a branch ready for review and before you push a tree that has not passed it.

## Message

- Write each subject as a Conventional Commit in plain language, `<type>(<area>): <summary>`, with the purpose of the whole commit as `<type>` and the narrowest area that the upstream history uses for the change, such as `web`, `server`, `mobile`, `desktop`, `contracts`, `issues`, `persistence` or `fork`.
- End the subject of every commit for a GitHub issue with ` #<issue>`, as in `feat(issues): read GitHub board status #12`.
- Never write `fixes`, `closes` or `resolves #<issue>` in a commit message, because `sb-ship` closes the issue when the work ships.
- Write the commit body as one bullet per change.

## Shape

- Make each commit one complete change that can be reviewed, reverted and shipped on its own, with every file the change needs: implementation, tests, documentation, instruction files and configuration.
- Commit fork work only on a branch from `switchboard`, never on `switchboard-base`, which takes only upstream integrations.
- Commit each correction of an unpushed commit, such as a fix for a failed check or test, a review finding or operator feedback, as `git commit --fixup=<commit>`, or as `--fixup=amend:<commit>` when the correction changes what the message states.
- Squash fixups with `GIT_EDITOR=true git rebase --autosquash origin/switchboard` only when every commit the rebase replays is unpushed and the operator's.
