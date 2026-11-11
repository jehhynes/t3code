# What a running thread is working on

While a thread runs a turn, its card in the sidebar shows the stage the agent is at, in place of
the project name on the card's top line. Hover the row to read the whole stage.

## Where it comes from

The stage is the one the agent reported for the current turn, or else the item in progress on its
todo list. An agent that does neither shows no stage.

### A stage the agent reports

An agent reports a stage with the `t3_thread_update` tool, `action: "set_stage"`, and a short
phrase in `stage`. Without `threadId` it sets its own thread's stage; with one, it sets another
thread's, wherever it may rename that thread.

- The stage shows until the turn ends, ahead of any todo item; a new report replaces it, and a
  later turn starts with none.
- A stage is one line of at most 64 characters. An empty, longer or multi-line stage is refused
  with a message that says why, and a report for a thread with no running turn is refused.
- A report changes nothing else about the thread: not its title, its place in the sidebar, whether
  it is unread, settled or snoozed.

The tool does not ask agents to report one. To have an agent report its stage, put a line like
this in a skill or instruction file:

> At the start of each step, call `t3_thread_update` with `action: "set_stage"` and `stage` set to
> a few words for that step, such as `2/6 verifying findings`; omit `threadId`.

Report at step boundaries, not continuously: each report is one event in the thread's history.

### The agent's todo list

Without a report, the stage is the item the agent marked in progress in the latest todo list it
wrote during the current turn, worded as the agent wrote it. The thread shows the same list in its
timeline.

- Codex, Cursor, OpenCode, Muse, Grok, Kiro and other ACP agents show a stage when they keep a
  todo list.
- Claude keeps one only when its provider offers it the task tools: add
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to the Claude provider's environment variables, as
  [Task lists](../user/providers-claude.md#task-lists) describes. T3 Code does not turn this on
  for you. A thread whose Claude session is already open gets the tools when that session next
  starts, such as after T3 Code restarts.
- Even with the task tools, a Claude agent keeps a list only when it chooses to, so many Claude
  threads show a stage only when the agent reports one.

## When it shows

- A turn without a reported stage or a todo item in progress shows no stage, and its card looks
  as it always does.
- The stage stays while the turn waits for an approval or an answer.
- It goes away when the turn ends, and neither a report nor a list from an earlier turn shows in a
  later one.
- Rows under **Snoozed** and **Settled**, and rows in project folders (**Settings → Labs → Boring
  sidebar**), show the stage only when you hover them.
