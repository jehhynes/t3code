---
name: worktrees
description: Create, remove or inspect a T3 Code fork worktree, or find a checkout's dev server and its web URL.
---

# Worktrees

- Create a worktree for fork work with `git worktree add ../t3code.worktrees/<leaf> -b <type>/<issue>-<leaf> origin/switchboard` from the main checkout, then run `vp i` in it; T3 Code creates its own worktrees under `~/.t3/worktrees/` and sets them up with the setup script in [t3.json](../../../t3.json).
- Remove a worktree by its path with `scripts/fork/remove-worktree.sh <path>` from the main checkout ([the script](../../../scripts/fork/remove-worktree.sh)); it refuses a worktree with uncommitted or untracked changes, copies its `.wip/` to the main checkout's `.wip/shipped/<worktree folder>/`, stops the processes that listen on a port from inside it and runs `git worktree remove`, and it deletes no branch.
- Make the removal the session's last command when the session runs in that worktree.
- List the checkouts with `git worktree list`; the first entry is the main checkout.
- Find a checkout's dev server in its `.wip/dev.log`, whose `[dev-runner]` line gives `serverPort` and `webPort` and whose `pairingUrl:` line gives the startup pairing URL; the web URL is `http://localhost:<webPort>`.
- Each worktree's dev server keeps its state in the worktree's ignored `.t3/`, and its ports derive from the worktree path.
