# Playbooks

A playbook is a named way of working on an issue. Each playbook has rules that pick the board
issues it handles, and a prompt and settings for the thread it starts. The Issues page shows on
each board issue the playbook that picks it, and lists the issues waiting for you to start them.

## Define your playbooks

Write them in `playbooks.json`, beside the server's `settings.json`
(`~/.t3/userdata/playbooks.json` by default). T3 Code never writes this file, so you can keep it in
git. It holds a list, tried in the order you write it:

```json
[
  {
    "name": "develop",
    "rules": { "status": ["Ready", "In progress"], "assignee": "me" },
    "prompt": "Work on {{issue.repository}}#{{issue.number}}: {{issue.title}}\n{{issue.url}}",
    "modelSelection": { "instanceId": "codex", "model": "gpt-5.4" },
    "runtimeMode": "approval-required",
    "interactionMode": "plan"
  },
  { "name": "ship", "rules": { "status": ["In review"] }, "prompt": "Review {{issue.url}}." },
  { "name": "other", "prompt": "Triage {{issue.url}}." }
]
```

Each board issue gets the first playbook whose rules all match it. A playbook with no rules matches
every issue, so a last one like `other` takes everything the others leave. An issue that no playbook
matches shows none. Playbook names must differ.

A change to the file applies at the Issues page's next refresh.

## Rules

| Rule                                 | Matches an issue                         |
| ------------------------------------ | ---------------------------------------- |
| `"status": ["Ready", "In progress"]` | whose board status is one of these       |
| `"repository": ["acme/web"]`         | in one of these repositories             |
| `"labels": ["bug", "docs"]`          | with at least one of these labels        |
| `"assignee": "me"`                   | assigned to me, alone or with others     |
| `"assignee": "meAlone"`              | assigned to me and nobody else           |
| `"assignee": "meAndOthers"`          | assigned to me and somebody else         |
| `"assignee": "othersOnly"`           | assigned to somebody, but not to me      |
| `"assignee": "nobody"`               | assigned to nobody                       |
| `"blocked": true` or `false`         | with, or without, an open blocking issue |

- Names compare without regard to case.
- "Me" is the GitHub account the server reads your boards with.
- Without an `assignee` rule, a playbook picks issues whoever is assigned, so board status alone can
  decide.
- `blocked` only selects: nothing waits for a blocker yet.

## What a playbook starts

Every playbook needs a `prompt`: the first message of the thread it starts. The other settings are
optional; each one you leave out takes what a new thread in the issue's project would take.

| Setting           | What it sets                                                                           |
| ----------------- | -------------------------------------------------------------------------------------- |
| `prompt`          | The first message, with the issue's fields filled in                                   |
| `modelSelection`  | The provider instance and model, as `{ "instanceId": "codex", "model": "gpt-5.4" }`    |
| `runtimeMode`     | The permission mode: `approval-required`, `auto-accept-edits`, `auto` or `full-access` |
| `interactionMode` | `default`, or `plan` to start in plan mode                                             |

Without `modelSelection`, the thread takes the default model for new threads in the project, and
Start fails if there is none. Without `runtimeMode`, it takes the default permission mode. Without
`interactionMode`, it starts in the default mode.

The prompt can name these fields of the issue:

| Field                  | Holds                                      |
| ---------------------- | ------------------------------------------ |
| `{{issue.number}}`     | The issue number, such as `42`             |
| `{{issue.title}}`      | The title                                  |
| `{{issue.url}}`        | The issue's GitHub URL                     |
| `{{issue.repository}}` | The repository, such as `acme/web`         |
| `{{issue.status}}`     | The board status                           |
| `{{issue.labels}}`     | The label names, separated by commas       |
| `{{issue.assignees}}`  | The assignees' logins, separated by commas |

Each value is put into the prompt between tags that mark it as copied from the issue, with a note
asking the agent to treat it as untrusted data, because anyone who can edit the issue writes it. A
field with no value, such as an issue with no labels, is left empty.

## Start an issue

Above the boards, **Waiting to start** lists every board issue that a playbook picks and that has
no open thread, with its playbook. An open thread is one linked to the issue that is not settled,
archived or deleted. An issue on two boards is listed once, with the playbook its first board in
`settings.json` gives it.

Press **Start** to launch the playbook's thread in the issue's project, in the project's own
folder. The thread appears in the sidebar, linked to the issue, and the issue leaves the list. An
issue whose repository has no T3 Code project shows that instead of Start. A Start that fails says
why, and the issue stays so you can press Start again; a thread that starts and then fails shows
its failure in the thread, as any thread does.

Nothing starts on its own yet. When you settle an issue's thread while a playbook still picks the
issue, it is listed again. Starting needs the permission to run threads on that environment.

## Mistakes

When the file has a mistake, the Issues page says what it is above the boards, which still list.
Your settings are untouched.

- A playbook with a mistake, such as an unknown rule, a missing prompt or a prompt field that does
  not exist, is left out, and the others still pick their
  issues. Its issues may then fall to a later playbook, such as `other`.
- A file that is not valid JSON, or not a list, gives no issue a playbook.
- When an `assignee` rule is used and the server cannot read your GitHub account, no issue gets a
  playbook.
