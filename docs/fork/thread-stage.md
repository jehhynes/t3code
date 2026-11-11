# What a running thread is working on

While a thread runs a turn, its card in the sidebar shows the item the agent is working on, in
place of the project name on the card's top line. Hover the row to read the whole item.

## Where it comes from

The stage is the agent's own todo list: the item it marked in progress in the latest list it
wrote during the current turn, worded as the agent wrote it. Claude, Codex and several other
agents keep such a list; the thread shows the same list in its timeline. An agent that keeps none
shows no stage.

- A turn without a todo list, or whose latest list has no item in progress, shows no stage, and
  its card looks as it always does.
- The stage stays while the turn waits for an approval or an answer.
- It goes away when the turn ends, and a list from an earlier turn never shows in a later one.
- Rows under **Snoozed** and **Settled**, and rows in project folders (**Settings → Labs → Boring
  sidebar**), show the stage only when you hover them.
