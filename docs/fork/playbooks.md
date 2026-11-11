# Playbooks

A playbook is a named way of working on an issue. Each playbook has rules that pick the board
issues it handles, and a prompt and settings for the thread it starts. The Issues page shows on
each board issue the playbook that picks it, and lists the issues waiting for you to start them.
A playbook can also start its threads by itself.

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
  {
    "name": "ship",
    "rules": { "status": ["In review"] },
    "prompt": "Review {{issue.url}}.",
    "autoStart": true
  },
  { "name": "other", "prompt": "Triage {{issue.url}}." }
]
```

Each board issue gets the first playbook whose rules all match it. A playbook with no rules matches
every issue, so a last one like `other` takes everything the others leave. An issue that no playbook
matches shows none. Playbook names must differ.

A change to the file applies at the next board read: the server's own, every few minutes (see
[GitHub boards](issue-boards.md#name-your-boards)), or the Issues page's refresh.

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
| `autoStart`       | `true` to [start by itself](#start-by-itself) instead of waiting for Start             |

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

Above the boards, **Waiting to start** lists the board issues waiting for you to start them, each
with its playbook. An issue waits once each time it enters a playbook's selection: from when T3
Code first reads it there until you start it or it leaves that selection.

- Once started, it does not wait again while it stays in that selection, whatever happens to its
  thread: settling the thread does not list it again.
- When it moves to another playbook's selection, such as from In progress to In review, it waits
  with that playbook.
- When it leaves every selection and later comes back, it waits again.
- An issue that already has an open thread when T3 Code first reads it counts as started. An open
  thread is one linked to the issue that is not settled, archived or deleted.
- An issue on two boards is listed once, with the playbook of the first board in `settings.json`
  that picks it.

Press **Start** to run the playbook. When the issue has an open thread, the playbook's prompt is
sent to that thread, after its running turn ends if one is running, so the work keeps its context;
the thread keeps its own model and modes. Otherwise Start launches the playbook's thread in the
issue's project, in the project's own folder, linked to the issue. Either way the issue leaves the
list. An issue whose repository has no T3 Code project shows that instead of Start.

When a start fails, where it shows depends on how far it got:

- **Before any thread exists**, the issue stays under **Waiting to start** with the cause on its
  row, and its button reads **Retry**, which starts it as Start does. Every client shows the cause,
  also after a reload or a restart of T3 Code, until a start succeeds or the issue leaves the
  selection it failed in; an issue that enters a selection again shows none. Only the last failure
  is kept.
- **Once its thread exists but before the prompt reached it**, the thread is empty. It is linked to
  the issue, and the issue waits with the cause and **Retry**, which sends the prompt to that thread
  rather than starting another.
- **Once the prompt reached its thread**, the issue counts as started, linked to that thread, and
  leaves the list; the thread shows the failure, with its own Retry where the thread can retry. A
  prompt sent to the issue's open thread is not sent again, even when T3 Code could not read what
  happened next. A thread that starts and then fails, such as on a provider error, shows its
  failure in the thread, as any thread does.
- **When its thread could not be linked to the issue**, the issue still counts as started; find the
  thread in the sidebar under the issue's number and title.

A Start you pressed that fails once its thread exists tells you so and names the thread.

Issues enter and leave selections when T3 Code reads the boards, and only while it can tell: a
board that is off or cannot be read keeps its issues as they were, and so does every issue while
`playbooks.json` has a mistake or your GitHub account cannot be read. An issue that a board read
leaves out leaves its selection only once T3 Code
[confirms it is gone](issue-boards.md#when-an-issue-counts-as-gone). Starting needs the permission
to run threads on that environment.

## Start by itself

A playbook with `"autoStart": true` starts each issue that enters its selection without waiting for
Start, as Start would: a new thread in the issue's project, or the playbook's prompt in the issue's
open thread. The server reads the boards on its own timer, so this happens within a few minutes
with the Issues page closed and no client connected.

- Each entry starts once. After its thread starts, the issue is not started again while it stays
  in the selection, also after you settle the thread or restart T3 Code.
- A start that fails shows where a failed Start would, as
  [When a start fails](#start-an-issue) describes. T3 Code does not try it again by itself.
- Nothing starts by itself while `playbooks.json` has a mistake or your GitHub account cannot be
  read, nor from a board that is off or could not be read. Once you fix it, the issues that entered
  meanwhile start once.
- An issue whose repository has no T3 Code project waits with that reason, and starts by itself
  once the project exists.
- When you give a playbook `autoStart`, or turn its board on, the issues already waiting in it
  start at the next board read, except those whose start by itself already failed.

## Mistakes

When the file has a mistake, the Issues page says what it is above the boards, which still list.
Your settings are untouched.

- A playbook with a mistake, such as an unknown rule, a missing prompt or a prompt field that does
  not exist, is left out, and the others still pick their
  issues. Its issues may then fall to a later playbook, such as `other`.
- A file that is not valid JSON, or not a list, gives no issue a playbook.
- When an `assignee` rule is used and the server cannot read your GitHub account, no issue gets a
  playbook.
- While there is any mistake, the issues waiting to start stay as they were, and nothing starts
  by itself.
