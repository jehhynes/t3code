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

| Setting            | What it sets                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `prompt`           | The first message, with the issue's fields filled in                                                   |
| `modelSelection`   | The provider instance and model, as `{ "instanceId": "codex", "model": "gpt-5.4" }`                    |
| `runtimeMode`      | The permission mode: `approval-required`, `auto-accept-edits`, `auto` or `full-access`                 |
| `interactionMode`  | `default`, or `plan` to start in plan mode                                                             |
| `autoStart`        | `true` to [start by itself](#start-by-itself) instead of waiting for Start                             |
| `requiresWorktree` | `true` to give an issue without a worktree its own; see [Which folder](#which-folder-a-thread-runs-in) |

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

The number, URL and repository go into the prompt as written, so `/sb-plan {{issue.number}}`
sends `/sb-plan 42`, when each has GitHub's form: digits,
`https://github.com/<owner>/<name>/issues/<number>` for the issue's own repository and number,
and `<owner>/<name>`. In that form they hold only an identifier's characters, with no spaces or
line breaks. The title, status, labels and assignees, and a number, URL or repository in any
other form, go in between tags that mark them as copied from the issue, because anyone who can
edit the issue or the board writes them; the prompt then ends with a note asking the agent to
treat that text as untrusted data. A field with no value, such as an issue with no labels, is
left empty.

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
issue's project, linked to the issue, in the folder that
[Which folder a thread runs in](#which-folder-a-thread-runs-in) describes. Either way the issue leaves the
list. An issue whose repository has no T3 Code project shows that instead of Start.

To change a start before it runs, open the arrow beside Start or Retry and choose **Start with
guidance…**. T3 Code opens a new thread in the issue's project, not yet started, with the
playbook's prompt in the composer, its issue fields filled in as Start fills them, and the model,
permission mode and folder Start would use. Edit the prompt, change the model, mode or folder, or
add attachments as in any new thread, then press Send: the thread is linked to the issue and the
issue leaves the list, as after Start. When `playbooks.json` has more than one playbook, the menu
also lists the others under **With another playbook**: the draft then takes that playbook's prompt
and settings, and the issue stays in its own selection, so it does not wait or start there again.
A draft does not take a playbook's `interactionMode`, because the composer has no plan mode; start
such a playbook with Start.

- When the issue has an open thread, the prompt goes into that thread's composer instead, asking
  first when the composer already has text. The thread keeps its own model, modes and folder, and
  the next message you send in that thread, whatever its text, counts as the issue's start.
- Nothing starts until you send. Discarding the draft leaves the issue waiting, and so does a send
  that T3 Code refuses, which the draft shows as any draft does. Once T3 Code has accepted your
  message, the issue counts as started even when the thread's run then fails, as when
  [a start fails](#start-an-issue) once the prompt reached its thread.
- Until you send, the issue still waits, so Start, another client or a playbook that starts by
  itself can start it first; sending the draft then starts an ordinary thread, not linked to the
  issue.
- A draft opened before T3 Code restarts no longer counts: sending it starts an ordinary thread and
  the issue still waits.

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

## Which folder a thread runs in

A new thread for an issue runs in the issue's worktree when it has one, whichever playbook starts
it. The issue's worktree is the one its latest thread with a worktree ran in, also when that thread
is settled or archived, as long as git still lists it for the project. An issue whose worktree was
removed counts as having none.

When none of the issue's threads has a worktree, a worktree of the project whose branch names the
issue is the issue's: the issue's number, after an optional lowercase `<type>/`, then `-`, such as
`123-login-page` or `fix/123-login-page` for issue 123, as Switchboard names them. The thread
starts in it, on its branch, as it is: T3 Code makes no worktree or branch and resets, fetches or
renames nothing there, though the project's setup script runs in it as in any worktree. A worktree
whose folder is gone, and the project's own folder, never count. In a fork checkout only issues
of its `origin` repository are matched, because its branches are numbered by the fork's issues; an
issue of the repository it was forked from gets what follows. When more than one worktree matches,
Start fails with a cause that names them and makes nothing, and Start with guidance opens the draft
in the project's folder (Local), where picking one of their branches in the branch picker binds
its worktree.

An adopted worktree is treated as any worktree of the issue: deleting its last thread offers to
remove the worktree, which loses its uncommitted work; reverting a turn restores its files to that
checkpoint; and automatic worktree cleanup, when it is on, applies to it when it is inside T3
Code's worktrees folder.

When the issue has no worktree:

- A playbook with `"requiresWorktree": true` starts its thread in a new worktree, as T3 Code makes
  one for any new thread in a worktree: from the project's default branch, with the project's
  worktree settings (where worktrees go, branch naming, starting from origin) and its setup script,
  except where [the project names it](#name-an-issues-worktree). That worktree is then the issue's.
- Any other playbook starts its thread in the project's own folder.

A prompt sent to the issue's open thread runs in that thread's own folder. A draft from Start with guidance opens in
the folder a new thread would run in, and you can change it before you send.

A worktree that cannot be created fails the new thread's run, which shows the failure with its own
Retry; the issue counts as started, as when [a start fails](#start-an-issue) once the prompt
reached its thread. T3 Code removes a worktree it only partly made, so Retry makes it again rather
than adding a second one. A setup script that fails shows in the thread's setup output; when T3
Code waits for it, it also fails the run, and Retry reuses the thread's worktree. When T3 Code
cannot tell whether the issue's worktree is still there, the start fails before any thread exists
and the issue waits with the cause and Retry.

### Name an issue's worktree

A project can give the new worktree of each of its issues a branch name, a folder and a base branch
of its own, under `issueWorktrees` in `settings.json`, keyed by the issue's repository:

```json
"issueWorktrees": {
  "acme/web": {
    "branch": "{{issue.type}}/{{issue.number}}-{{issue.slug}}",
    "folder": "../web.worktrees/{{issue.number}}-{{issue.slug}}",
    "baseBranch": "main"
  }
}
```

With these, issue 123 "Fix the login page" with the label `bug` gets the branch
`fix/123-fix-the-login-page` in `<project's parent>/web.worktrees/123-fix-the-login-page`, from
`main`. Each of the three is optional; one you leave out keeps T3 Code's own behavior for it.
They apply to Start, a start by the playbook itself and a draft from Start with guidance, and only
to a new worktree: an issue that already has one keeps it.

- `branch` takes the place of T3 Code's own branch naming (**Settings → Worktrees → Worktree branch
  naming**), which names a new worktree from its first message; the branch keeps this name after
  the first message.
- `folder` takes the place of **Settings → Worktrees → Worktree location** for the issue's worktree.
  It is an absolute path, `~/…`, or relative to the project's folder, and the issue's fields may
  appear only in its last part. The folder must not exist yet.
- `baseBranch` takes the place of the project's default branch. Any ref git accepts works, such as
  `switchboard` or `origin/switchboard`; the project's `newWorktreesStartFromOrigin` still applies to it. A
  base you pick in a draft wins.
- `types` sets `{{issue.type}}`: a map from a label to a type, such as
  `{ "bug": "fix", "documentation": "docs" }`. The issue's first label that the map names gives the
  type, otherwise `feat`. Without a map, `bug` gives `fix`.

`{{issue.number}}` is the issue's number, and `{{issue.slug}}` is its title in lowercase letters,
digits and hyphens, at most 40 characters, so a title cannot move the worktree elsewhere or make a
bad branch name.

A start fails with its cause and makes nothing when the branch already exists, the folder already
exists, the name is one git refuses or one that looks like T3 Code's temporary `t3/…` names, or the
base branch does not resolve. For a draft, these are checked when you send it.

A worktree outside T3 Code's worktrees folder works as any other: diffs, checkpoints, its thread's
worktree controls and reuse by the issue's later threads. Two things differ: T3 Code does not
recreate it when its folder goes missing, and automatic cleanup (**Settings → Worktrees → Cleanup**)
leaves it alone, so with **Delete worktrees with deleted threads** on, deleting its thread leaves
the worktree; with it off, Delete offers to remove it as usual.

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
