---
name: issues
description: Create a T3 Code fork issue in jehhynes/t3code, such as a bug, feature, task or follow-up, edit an issue's body, including when its work ships, or add an issue to the T3 Code fork board.
---

# Fork issues

An issue proposes its work at a high level; when the work is built, an Implementation section that describes what was built replaces the proposal, so that the closed issue describes the current design.

## Create an issue

1. Choose the kind, its label and its sections; the fork has no issue forms, because upstream's forms are for upstream:

   | Kind    | Label         | Sections, in order                              | Use for                                                     |
   | ------- | ------------- | ----------------------------------------------- | ----------------------------------------------------------- |
   | Bug     | `bug`         | Problem, Reproduction, Evidence, Acceptance     | Something in the fork or its tooling behaves wrongly        |
   | Feature | `enhancement` | Goal, Proposed design, Out of scope, Acceptance | A new or changed capability that a user sees                |
   | Task    | none          | Goal, Scope, Out of scope, Acceptance           | Other work, such as a refactor, tooling, docs or a decision |

2. Write the body with a `### <section>` heading for each section, and write Acceptance as checkboxes.
3. For a feature, write the Proposed design as the approach in a few high-level lines, with what the user sees and does.
4. When the work is an item of the epic [issue #1](https://github.com/jehhynes/t3code/issues/1), name that item in the Goal.
5. Run `gh issue create --repo jehhynes/t3code --title <title> --body-file <path>`, with `--label <label>` when the kind has one.
6. Unless a calling skill, such as `sb-plan`, adds the issue to the board in a later step, add it to the board now, and set its status to Ready when it is ready to be picked up, per [Board](#board).

## Test issues

- Create an issue that only tests a tracker or a trigger with the title prefix `[test] ` and `--label test`, assign it as the test needs, keep it off the board, and close it when the test ends.

## Board

- Add an issue to the T3 Code fork board with `gh project item-add 4 --owner jehhynes --url <issue URL> --format json --jq .id`, which prints the item ID.
- Set an item's status with `gh project item-edit --id <item id> --project-id PVT_kwHOAH41Cs4BrAPg --field-id PVTSSF_lAHOAH41Cs4BrAPgzhpU1YA --single-select-option-id <option id>`, with the option ID of the status:

  | Status      | Option ID  | Set for                                     |
  | ----------- | ---------- | ------------------------------------------- |
  | Ready       | `4a938747` | An issue that is ready to be picked up      |
  | In progress | `7f5349d8` | An issue that `sb-plan` or `sb-build` files |
  | In review   | `984752f8` | An issue that `sb-review` files             |

## Edit an issue before its work is built

- Change the Goal, Proposed design, Scope, Out of scope or Acceptance only when the requirement changes, and keep a Proposed design high-level.
- Record implementation decisions and departures from the issue in the plan's decisions log, not in the issue.

## Update an issue when its work is built

`sb-ship` makes these edits before it closes the issue.

- Rewrite each statement that the implementation changed, so that the body describes what was built.
- Record the answer to each open question that the work settled.
- Tick each checkbox whose work the branch completes.
- Replace `### Proposed design` for a feature or `### Scope` for a task with a `### Implementation` section, and add a `### Implementation` section after the last section of a bug.
- Write in the `### Implementation` section what was built, in more detail than the proposal: the approach, the data, interfaces, UI surfaces and architecture that the work added or changed, and the reason for each design decision that the proposal did not state.
- Put a `### Evidence` section after the `### Implementation` section, moving a bug's existing Evidence section there, with the rows of the plan's `evidence.md`, and embed each screenshot that proves a row per [Evidence files](#evidence-files).
- Add a `### Follow-up` section after the `### Evidence` section, with one line per deferred edge case, optimization or finding from the plan's out-of-scope items and the review's `Out of scope` findings, each with the reason it was deferred, or `None`.
- Do not list the commits in the issue, because its timeline lists each commit whose subject ends with `#<issue>`.
- When the issue is an item of the epic [issue #1](https://github.com/jehhynes/t3code/issues/1), tick that item's checkbox in issue #1 and add ` (#<issue>)` after it.

## Evidence files

The repository is public, and the `evidence` branch holds the files that issues embed, outside the code's history.

- Before you publish a screenshot, check that it shows no data copied from the operator's database, such as project names, thread titles, messages or paths, and no credential such as a pairing URL; retake it with test data when it does.
- Upload a file with `base64 -w0 <path> | jq -Rs '{message: "docs(fork): evidence for #<issue>", branch: "evidence", content: .}' | gh api -X PUT repos/jehhynes/t3code/contents/<issue>/<file> --input -`, which passes the content on stdin because a screenshot exceeds the 128 KB limit of one command-line argument.
- Embed it as `![<what it shows>](https://github.com/jehhynes/t3code/blob/evidence/<issue>/<file>?raw=true)`.
