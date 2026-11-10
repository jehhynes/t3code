# Playbooks

A playbook is a named way of working on an issue. Each playbook has rules that pick the board
issues it handles, and the Issues page shows on each board issue the playbook that picks it. For
now a playbook only selects: starting a thread from it comes later.

## Define your playbooks

Write them in `playbooks.json`, beside the server's `settings.json`
(`~/.t3/userdata/playbooks.json` by default). T3 Code never writes this file, so you can keep it in
git. It holds a list, tried in the order you write it:

```json
[
  { "name": "develop", "rules": { "status": ["Ready", "In progress"], "assignee": "me" } },
  { "name": "ship", "rules": { "status": ["In review"] } },
  { "name": "other" }
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

## Mistakes

When the file has a mistake, the Issues page says what it is above the boards, which still list.
Your settings are untouched.

- A playbook with a mistake, such as an unknown rule, is left out, and the others still pick their
  issues. Its issues may then fall to a later playbook, such as `other`.
- A file that is not valid JSON, or not a list, gives no issue a playbook.
- When an `assignee` rule is used and the server cannot read your GitHub account, no issue gets a
  playbook.
