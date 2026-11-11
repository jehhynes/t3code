# What a running thread is working on

While a thread runs a turn, its card in the sidebar shows the item the agent is working on, in
place of the project name on the card's top line. Hover the row to read the whole item.

## Where it comes from

The stage is the agent's own todo list: the item it marked in progress in the latest list it
wrote during the current turn, worded as the agent wrote it. The thread shows the same list in its
timeline. An agent that keeps none shows no stage.

- Codex, Cursor, OpenCode, Muse, Grok, Kiro and other ACP agents show a stage when they keep a
  todo list.
- Claude keeps one only when its provider offers it the task tools: add
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` to the Claude provider's environment variables, as
  [Task lists](../user/providers-claude.md#task-lists) describes. T3 Code does not turn this on
  for you. A thread whose Claude session is already open gets the tools when that session next
  starts, such as after T3 Code restarts.
- Even with the task tools, a Claude agent keeps a list only when it chooses to, so many Claude
  threads show no stage.

- A turn without a todo list, or whose latest list has no item in progress, shows no stage, and
  its card looks as it always does.
- The stage stays while the turn waits for an approval or an answer.
- It goes away when the turn ends, and a list from an earlier turn never shows in a later one.
- Rows under **Snoozed** and **Settled**, and rows in project folders (**Settings → Labs → Boring
  sidebar**), show the stage only when you hover them.
