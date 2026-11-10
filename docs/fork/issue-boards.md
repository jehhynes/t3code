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

A change to the file applies at the Issues page's next refresh. Remove a board from the list to
stop showing it.

## Turn a board on and off

A board you add starts off: its section shows only its heading, marked **Off**, and T3 Code does
not read it from GitHub. Turn it on with the switch in its heading, and its issues list at once.
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
