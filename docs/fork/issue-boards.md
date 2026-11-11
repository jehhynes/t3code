# GitHub boards on the Issues page

The Issues page can list every open issue on a GitHub project board, from every repository on the
board, without a setting per repository.

## Name your boards

Name your boards in **Settings → Source control → GitHub boards**: **Add board** asks for the
board's owner, number and status field, and whether it waits for blockers; each board has **Edit**
and **Remove**. The same section sets how often the boards are read and how many issue threads run
at once. A value outside the limits below, an empty field or a board already in the list is refused
there with the reason, and nothing is saved. Changing these needs a connection that may
change settings; any other connection sees them only.

The section saves the same keys you can write by hand in the server's `settings.json`
(`~/.t3/userdata/settings.json` by default), and shows what you write there. Any save from Settings,
this section or another, writes the file in the server's own form: keys it does not know, and keys
set to their default value, are left out, so a key you add that T3 Code does not read is lost at
the next save. The other keys keep their values.
In the file, boards are `githubBoards`:

```json
{
  "githubBoards": [
    { "owner": "my-org", "number": 1 },
    { "owner": "my-user", "number": 4, "statusField": "Stage" }
  ]
}
```

- `owner` is the user or organization that owns the board, and `number` is the number in the
  board's URL (`github.com/orgs/my-org/projects/1`).
- `statusField` names the board's single-select field that holds each issue's status. It is
  `Status` unless you set it.
- `"waitForBlockers": true` holds the start of each issue that has an open blocking issue on GitHub
  until its blockers close; see [Wait for blockers](playbooks.md#wait-for-blockers). It is off
  unless you set it, because stacked work starts from its blocker's branch.
- Boards are read with the server's GitHub sign-in, which needs access to the board's projects
  (the `project` or `read:project` scope for a GitHub CLI token).

The server reads every board that is on every five minutes, whether or not the Issues page is open,
so a [playbook that starts by itself](playbooks.md#start-by-itself) can start. Set
**Board read interval** in Settings, in seconds and at least 10, or `githubBoardReadInterval` in the
file in milliseconds, such as `120000` for two minutes, to change how often; a change applies at once. A value above zero but under 10 seconds counts as 10 seconds, and zero or
less as five minutes. Opening the Issues page shows the latest read at once, and reads the boards
again when that read is more than 30 seconds old; its refresh button reads them again.

At most two issue threads run at once; set **Issue threads at once** in Settings, or
`maxRunningIssueThreads`, from 1 to 10, in the file, to change that. See [Run a few at a time](playbooks.md#run-a-few-at-a-time).

A change to the boards, in Settings or in the file, reads them again at once, so the Issues page
shows an added board and drops a removed one without a restart.

## Turn a board on and off

A board you add starts off: its section shows only its heading, marked **Off**, and T3 Code does
not read it from GitHub, so nothing starts from it. Turn it on with the switch in its heading, and its issues list at once.
Turn it off for the weeks you do not work on it; its threads stay as they are.

Removing a board in Settings does what turning it off does and also forgets its switch, so the board
starts off if you add it again. Its issues' open threads stay open, and nothing more starts or
settles from it. A board you give another owner or number in Settings starts off too. A board you
remove from the file by hand keeps its switch: added back, by hand or in Settings, it is on or off
as it was.

The server remembers which boards are on across restarts. The switch never changes
`settings.json`, so you can keep that file in git.

## What the page shows

Each board gets its own section at the top of the Issues page. Its issues are grouped under the
T3 Code project for their repository; an issue whose repository has no project is grouped under
"No T3 Code project for owner/repo" and opens on GitHub instead of beside the list. Each issue
shows its board status, assignees, labels, the open issues that block it, and the
[playbook](playbooks.md) that picks it. Above the boards, the issues that entered a playbook's
selection wait for you to [start](playbooks.md#start-an-issue) them.

The sections hold open issues only, so they hide under **Closed**. The search box narrows them by
title and number; the involvement and tracker filters do not apply to them.

A board that is on but cannot be read says why in its section: for example, a status field that does not
exist or is not a single-select field. GitHub search lists at most 1,000 issues, so a board with
more open issues than that cannot be read.

## When an issue counts as gone

GitHub search can answer with some issues missing, for example during an outage. So when a read of
a board leaves out an issue that is in a [playbook's selection](playbooks.md#start-an-issue) there,
T3 Code reads that issue from GitHub on its own first. The issue has left the board only when that
read finds it closed, no longer on the board, or not there at all, such as deleted or no longer
readable with the server's GitHub sign-in; otherwise it stays listed, with what that read found,
and keeps its place in its selection. When that read fails, the board's read fails
too: its section says why, and nothing changes or starts from that board until a later read
succeeds.
