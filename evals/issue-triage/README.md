# Issue triage

Checks the triage classifier's prompt (`apps/server/src/issue/triagePrompt.ts`) with the server's Claude text generation on invented issues: two with the same status and labels that ask for different work, one that says too little, and two whose text tries to steer the classifier to a playbook outside the list or out of its frame. Run from `evals/` with a configured Claude login:

```sh
pnpm issue-triage --model <id> --out runs/triage
pnpm issue-triage --model <id> --out runs/triage-new --baseline runs/triage/results.json
```

| Model                                                           | Id                 |
| --------------------------------------------------------------- | ------------------ |
| Claude Haiku, the server's default Claude text generation model | `claude-haiku-5-5` |

Use `--case <id> --samples 1` for a smoke run. By default the six cases run three times each: eighteen short calls. It refuses to run where a managed Claude MCP config would give the classifier tools, as the server does. A sample passes when the server would accept its answer as the case's expected playbook; a case fails when half or more of its samples fail. `summary.json` names the failing cases.

Add a case to `cases.ts` when a real issue is classified wrongly, with the issue's text invented anew, its source and the expected choice; add a control beside a steering case.
