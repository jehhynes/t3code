---
name: orchestrate
description: Orchestrate the fork's epic, issue #1, in the operator's place; only when the operator invokes it.
disable-model-invocation: true
---

# Orchestrate the epic

You take the operator's place in the sb workflow for the epic [issue #1](https://github.com/jehhynes/t3code/issues/1): you break down the next item into an issue, assign a worker, answer the worker's questions, review its handover and approve its shipping. Write no plan, code or commit yourself, and leave the main checkout clean, because `sb-ship` fast-forwards it.

## Knowledge

- Take the goals, the approach, the order of work and the fork-only constraints from issue #1 and its comments, and the architecture from [overview.md](../../../docs/internals/overview.md) and `docs/internals/`.
- Consult the Switchboard repository, the sibling checkout `../switchboard`, only for reference: [prd.md](../../../../switchboard/docs/prd.md) defines the requirement IDs (R1, R44 and so on) that issue #1 cites, and its `packages/` hold the code that issue #1 ports, such as `packages/zoho` and `packages/dpaf`.
- Keep the epic's state on GitHub, not in this session: issue #1's checkboxes, its child issues and the T3 Code fork board; on a new session, rebuild the state from them and from `git worktree list`.

## Scope rule

Apply the scope rule of [AGENTS.md § Development workflow](../../../AGENTS.md#development-workflow) to every answer, plan review and handover review.

## Loop

Run one issue at a time, and start the next issue only after the previous one shipped.

### 1. Break down the next item

1. When an open issue of issue #1 is on the board as In progress or In review, resume it instead: assign a worker per [step 2](#2-assign-a-worker) in its existing worktree, with the sb skill that its `.wip/<issue>/` state reaches (`sb-build` when the plan's evidence has empty cells, otherwise `sb-review`), and continue at [step 3](#3-answer-the-worker).
2. Otherwise choose the first item of issue #1's Work section that is not ticked; take a later item first only when the first one depends on it.
3. Read the code the item names, enough to write the issue; assign an `Explore` subagent when the reading spans many files.
4. When the item needs more than one change that can ship on its own, split it in issue #1 into one checkbox per change, and take the first.
5. File the issue per the `issues` skill, as one change that can ship on its own.
6. Add the issue to the board with the status In progress and assign it with `gh issue edit <issue> --add-assignee @me`.

### 2. Assign a worker

1. Create the worktree per the `worktrees` skill, with the branch `<type>/<issue>-<slug>` from `origin/switchboard`, and run `vp i` in it.
2. Assign the issue to a Claude subagent with the model `opus` and the effort `medium`, which the operator chose for workers, and this brief:
   - **Checkout:** the absolute path of the worktree; start every Bash command with `cd <path> && `, give file tools absolute paths, and pass `--cd <path>` to the `cross-check` script, because the subagent's working directory is the main checkout.
   - **Task:** invoke the `sb-plan` skill with the issue number, as if the operator had typed `/sb-plan <issue>`, and continue through `sb-build` and `sb-review` to the handover.
   - **Dev server:** you are the primary agent of this checkout: start its dev server per the `environment-repair` skill before you assign UAT, and stop it by its PID before `sb-ship`.
   - **Questions:** where an sb skill says to stop with AskUserQuestion, end the turn with the question, the options with a recommended answer first and its reason, and the state needed to resume.
3. Keep the worker's ID for `SendMessage` until the issue ships.

### 3. Answer the worker

- Answer each question with `SendMessage` from the knowledge sources and the [Scope rule](#scope-rule), and tell the worker to record the answer in the plan's goal sources.
- Ask the operator with AskUserQuestion only when the sources do not settle the question and the answer changes the result: an unclear requirement, a product behavior that no source decides, a departure from the architecture in issue #1, an irreversible effect, a change to the base branch's history such as an upstream sync, or a credential or access that only the operator can give.
- When you ask the operator, give your recommended answer first with its reason, and pass the answer to the worker.

### 4. Review the handover

1. Read the handover's change summary, `git log origin/switchboard..HEAD` and `git diff origin/switchboard...HEAD` in the worktree, `.wip/<issue>/evidence.md`, the last round's `review.md` and the plan's decisions log.
2. Check the change against the issue's goal and acceptance, issue #1's approach and the [Scope rule](#scope-rule).
3. Send each change you require to the worker as operator feedback, which `sb-review` applies per its Operator feedback section, and repeat this step after the worker's next handover.
4. Send each Out-of-scope finding that the handover offers to file to the worker as a follow-up for the issue's Follow-up section, not as a new issue, unless it blocks a later item of issue #1.

### 5. Ship

1. Approve by sending the worker `/sb-ship <issue>`, to run the `sb-ship` skill.
2. Confirm that the issue is closed, that its body has the Implementation and Follow-up sections, and that issue #1 ticks its item.
3. Edit issue #1 per the `issues` skill when the shipped work changed what a later item needs: tick, reword, split or reorder items, or add an item for a follow-up that a later item depends on; ask the operator before you change its goal, its Done when section, its Deferred or Dropped lists or its fork workflow.
4. Report to the operator in two or three lines that describe what shipped and link the issue, which is the full report; then continue at [step 1](#1-break-down-the-next-item).
5. When the shipped items make the fork usable for a part of the operator's daily work that it was not usable for before, propose installing it per [building.md](../../../docs/fork/building.md), and install it only with the operator's approval, because the install replaces the T3 Code app that the operator uses.

## Boundaries

- Never merge upstream into `switchboard-base` or `switchboard`; when an item needs an upstream change, ask the operator, who syncs the base.
- Work only on the items of issue #1's Work section; the items under Deferred wait for the operator.

## Stop

Stop the loop and report to the operator when issue #1's Work section has no item left that is not ticked, when a worker fails twice on the same step, or when the operator's answer is needed and the operator does not answer.
