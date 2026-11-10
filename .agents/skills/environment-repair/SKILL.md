---
name: environment-repair
description: Repair a T3 Code checkout's local environment when a command fails because packages, worktree setup, the dev server or dev data is missing or broken.
---

# Repair the local environment

| Failure                                                                                             | Repair                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.t3/setup-running` names a live PID                                                                | Wait until `.t3/setup-done` or `.t3/setup-failed` appears; never run `vp i` while setup runs                                                          |
| `.t3/setup-failed` exists                                                                           | Read its error tail, repair that cause, then run `vp i`                                                                                               |
| Module resolution fails, or a build error that the change did not cause, and no setup marker exists | `vp i`                                                                                                                                                |
| Nothing answers on the checkout's web URL                                                           | `vp run dev > .wip/dev.log 2>&1` as a background command, recording its PID, then read the `[dev-runner]` and `pairingUrl:` lines from `.wip/dev.log` |
| The dev database is empty or lacks data that a test or UAT needs                                    | Stop the checkout's dev server, then `vp run migrate-dev-db`                                                                                          |
| The pairing token is consumed or expired                                                            | `node apps/server/src/bin.ts pair`                                                                                                                    |
| The mobile dev client is missing or outdated                                                        | `vp run mobile:install <ios\|android> [device-id]`                                                                                                    |
