# GitHub boards on the Issues page

The Issues page can list every open issue on a GitHub project board, from every repository on the
board, without a setting per repository.

## Name your boards

Add `githubBoards` to the server's `settings.json` (`~/.t3/userdata/settings.json` by default):

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
- Boards are read with the server's GitHub sign-in, which needs access to the board's projects
  (the `project` or `read:project` scope for a GitHub CLI token).

The server reads every board that is on every five minutes, whether or not the Issues page is open,
so a [playbook that starts by itself](playbooks.md#start-by-itself) can start. Set
`githubBoardReadInterval` in milliseconds to change how often, such as `120000` for two minutes; a
change applies at once. A value above zero but under 10 seconds counts as 10 seconds, and zero or
less as five minutes. Opening the Issues page shows the latest read at once, and reads the boards
again when that read is more than 30 seconds old; its refresh button reads them again.

A change to `githubBoards` applies at the next read. Remove a board from the list to stop showing
it.

## Turn a board on and off

A board you add starts off: its section shows only its heading, marked **Off**, and T3 Code does
not read it from GitHub, so nothing starts from it. Turn it on with the switch in its heading, and its issues list at once.
Turn it off for the weeks you do not work on it; its threads stay as they are.

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
