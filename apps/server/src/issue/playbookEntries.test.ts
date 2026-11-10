import { describe, expect, it } from "@effect/vitest";
import { IssueTrackerKind, type IssueBoard, type IssueBoardEntry } from "@t3tools/contracts";

import { OPEN_THREAD, type PlaybookEntryRow } from "../persistence/IssuePlaybookEntries.ts";
import { reconcilePlaybookEntries, waitingPlaybook } from "./playbookEntries.ts";

const earlier = "2026-11-09T12:00:00.000Z";
const started = "issue-playbook:earlier";
const key = (number: string) => `github github.com acme/web ${number}`;

function entry(number: string, playbook: string | null, hasOpenThread = false): IssueBoardEntry {
  return {
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "Acme/Web",
    key: number,
    displayKey: `#${number}`,
    title: `Issue ${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: earlier,
    updatedAt: earlier,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    status: "Ready",
    blockers: [],
    projectId: null,
    projectTitle: null,
    playbook,
    hasOpenThread,
    waitingPlaybook: null,
  };
}

function board(
  number: number,
  entries: ReadonlyArray<IssueBoardEntry>,
  state: "read" | "off" | "failed" = "read",
): IssueBoard {
  return {
    owner: "acme",
    number,
    statusField: "Status",
    enabled: state !== "off",
    entries: state === "read" ? entries : [],
    error: state === "failed" ? "Bad credentials" : null,
  };
}

const row = (
  number: string,
  playbook: string | null,
  startedBy: string | null,
  boardKey = "acme/1",
  autoTried = false,
): PlaybookEntryRow => ({ issueKey: key(number), board: boardKey, playbook, startedBy, autoTried });

describe("reconcilePlaybookEntries", () => {
  it.each<{
    name: string;
    rows: ReadonlyArray<PlaybookEntryRow>;
    boards: ReadonlyArray<IssueBoard>;
    writes: ReadonlyArray<PlaybookEntryRow>;
  }>([
    {
      name: "an issue first seen in a selection waits",
      rows: [],
      boards: [board(1, [entry("1", "develop")])],
      writes: [row("1", "develop", null)],
    },
    {
      name: "an issue first seen in a selection with an open thread counts as started",
      rows: [],
      boards: [board(1, [entry("1", "develop", true)])],
      writes: [row("1", "develop", OPEN_THREAD)],
    },
    {
      name: "an issue first seen in no selection is recorded, so entering later waits",
      rows: [],
      boards: [board(1, [entry("1", null, true)])],
      writes: [row("1", null, null)],
    },
    {
      name: "a started entry stays started once its thread is settled",
      rows: [row("1", "develop", started)],
      boards: [board(1, [entry("1", "Develop")])],
      writes: [],
    },
    {
      name: "an issue that moves to another selection waits with it, open thread or not, untried",
      rows: [row("1", "develop", started, "acme/1", true), row("2", "develop", started)],
      boards: [board(1, [entry("1", "ship", true), entry("2", "ship")])],
      writes: [row("1", "ship", null), row("2", "ship", null)],
    },
    {
      name: "an issue that leaves every selection, or the board, leaves its entry",
      rows: [
        row("1", "develop", started),
        row("2", "develop", null, "acme/1", true),
        row("3", null, null),
      ],
      boards: [board(1, [entry("1", null)])],
      writes: [row("1", null, null), row("2", null, null)],
    },
    {
      name: "an issue that comes back waits, even with its thread still open",
      rows: [row("1", null, null)],
      boards: [board(1, [entry("1", "develop", true)])],
      writes: [row("1", "develop", null)],
    },
    {
      name: "a board that is off or failed changes none of its issues",
      rows: [row("1", "develop", null, "acme/1"), row("2", "develop", started, "acme/2")],
      boards: [board(1, [], "off"), board(2, [], "failed")],
      writes: [],
    },
    {
      name: "another board cannot change an issue whose own board is off",
      rows: [row("1", "develop", started, "acme/1")],
      boards: [board(1, [], "off"), board(2, [entry("1", "ship")])],
      writes: [],
    },
    {
      name: "an issue on two boards follows the first that selects it",
      rows: [],
      boards: [board(1, [entry("1", null)]), board(2, [entry("1", "ship")])],
      writes: [row("1", "ship", null, "acme/2")],
    },
    {
      name: "an issue that moved to another board follows it, keeping its entry",
      rows: [row("1", "develop", started, "acme/1", true)],
      boards: [board(1, []), board(2, [entry("1", "develop")])],
      writes: [row("1", "develop", started, "acme/2", true)],
    },
  ])("$name", ({ rows, boards, writes }) => {
    expect(
      reconcilePlaybookEntries({
        rows: new Map(rows.map((candidate) => [candidate.issueKey, candidate])),
        boards,
      }),
    ).toEqual(writes);
  });

  it("waits only while the entry is not started", () => {
    expect(waitingPlaybook(row("1", "develop", null))).toBe("develop");
    expect(waitingPlaybook(row("1", "develop", started))).toBeNull();
    expect(waitingPlaybook(row("1", null, null))).toBeNull();
    expect(waitingPlaybook(undefined)).toBeNull();
  });
});
