import { describe, expect, it } from "@effect/vitest";
import { IssueTrackerKind, type IssueBoard, type IssueBoardEntry } from "@t3tools/contracts";

import { OPEN_THREAD, type PlaybookEntryRow } from "../persistence/IssuePlaybookEntries.ts";
import {
  heldIn,
  reconcilePlaybookEntries,
  startFailure,
  waitingFields,
  waitingPlaybook,
} from "./playbookEntries.ts";

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

const now = "2026-11-11T12:00:00.000Z";
const row = (
  number: string,
  playbook: string | null,
  startedBy: string | null,
  boardKey = "acme/1",
  autoTried = false,
  startFailure: string | null = null,
  leftAt: string | null = null,
  startQueued = false,
  waitingSince: string | null = now,
): PlaybookEntryRow => ({
  issueKey: key(number),
  board: boardKey,
  playbook,
  startedBy,
  autoTried,
  startFailure,
  leftAt,
  startQueued,
  waitingSince,
});
const failed = "The project has no default model.";

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
      name: "an issue that moves to another selection waits with it from the read, open thread or not, untried, and has not left",
      rows: [
        row("1", "develop", started, "acme/1", true, null, earlier, false, earlier),
        row("2", "develop", null, "acme/1", true, failed, null, true, earlier),
      ],
      boards: [board(1, [entry("1", "ship", true), entry("2", "ship")])],
      writes: [row("1", "ship", null, "acme/1", false, null, earlier), row("2", "ship", null)],
    },
    {
      name: "an issue that leaves every selection, or the board, leaves its entry at the read's time",
      rows: [
        row("1", "develop", started, "acme/1", false, null, earlier),
        row("2", "develop", null, "acme/1", true, failed, null, true),
        row("3", null, null, "acme/1", false, null, earlier),
      ],
      boards: [board(1, [entry("1", null), entry("3", null)])],
      writes: [
        row("1", null, null, "acme/1", false, null, now),
        row("2", null, null, "acme/1", false, null, now),
      ],
    },
    {
      name: "an issue that comes back waits, even with its thread still open, keeping when it left",
      rows: [row("1", null, null, "acme/1", false, null, earlier)],
      boards: [board(1, [entry("1", "develop", true)])],
      writes: [row("1", "develop", null, "acme/1", false, null, earlier)],
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
      rows: [row("1", "develop", null, "acme/1", true, failed, earlier, true, earlier)],
      boards: [board(1, []), board(2, [entry("1", "develop")])],
      writes: [row("1", "develop", null, "acme/2", true, failed, earlier, true, earlier)],
    },
  ])("$name", ({ rows, boards, writes }) => {
    expect(
      reconcilePlaybookEntries({
        rows: new Map(rows.map((candidate) => [candidate.issueKey, candidate])),
        boards,
        now,
      }),
    ).toEqual(writes);
  });

  it("waits only while the entry is not started", () => {
    expect(waitingPlaybook(row("1", "develop", null))).toBe("develop");
    expect(waitingPlaybook(row("1", "develop", started))).toBeNull();
    expect(waitingPlaybook(row("1", null, null))).toBeNull();
    expect(waitingPlaybook(undefined)).toBeNull();
  });

  it("shows a failed start's cause only while the entry waits", () => {
    expect(startFailure(row("1", "develop", null, "acme/1", false, failed))).toBe(failed);
    expect(startFailure(row("1", "develop", started, "acme/1", false, failed))).toBeNull();
    expect(startFailure(row("1", "develop", null))).toBeNull();
    expect(startFailure(undefined)).toBeNull();
  });

  it("starts a waiting entry by itself when it was queued, or its playbook starts by itself and has not tried it", () => {
    const selfStarting = new Set(["deploy"]);
    const fields = (candidate: PlaybookEntryRow | undefined) => {
      const { startQueued, startsBySelf } = waitingFields(candidate, selfStarting);
      return { startQueued, startsBySelf };
    };
    const queued = row("1", "develop", null, "acme/1", false, null, null, true);
    expect(fields(queued)).toEqual({ startQueued: true, startsBySelf: true });
    expect(fields(row("1", "develop", null))).toEqual({ startQueued: false, startsBySelf: false });
    expect(fields(row("1", "Deploy", null))).toEqual({ startQueued: false, startsBySelf: true });
    // Tried by itself, failed or interrupted, it waits for Start.
    expect(fields(row("1", "deploy", null, "acme/1", true))).toEqual({
      startQueued: false,
      startsBySelf: false,
    });
    expect(fields({ ...queued, startedBy: started })).toEqual({
      startQueued: false,
      startsBySelf: false,
    });
    expect(fields(undefined)).toEqual({ startQueued: false, startsBySelf: false });
  });
});

describe("heldIn", () => {
  const blocker = {
    scope: "acme/web",
    key: "12",
    displayKey: "#12",
    title: "Blocker",
    url: "https://github.com/acme/web/issues/12",
  };
  const listed = (waitForBlockers: boolean | undefined, blockers = [blocker]) => ({
    boards: [
      {
        ...board(1, [{ ...entry("1", "develop"), waitingPlaybook: "develop", blockers }]),
        ...(waitForBlockers === undefined ? {} : { waitForBlockers }),
      },
    ],
    playbookErrors: [],
  });

  it("holds a waiting issue with an open blocker only on a board that waits for blockers", () => {
    expect(heldIn(listed(true), key("1"), "Develop")).toEqual([blocker]);
    expect(heldIn(listed(true, []), key("1"), "develop")).toEqual([]);
    expect(heldIn(listed(false), key("1"), "develop")).toEqual([]);
    expect(heldIn(listed(undefined), key("1"), "develop")).toEqual([]);
    expect(heldIn(listed(true), key("1"), "ship")).toEqual([]);
    expect(heldIn(null, key("1"), "develop")).toEqual([]);
    // A mistake in playbooks.json keeps the records as they were, and their hold.
    expect(
      heldIn(
        { ...listed(true), playbookErrors: ["Playbook 2: Expected object"] },
        key("1"),
        "develop",
      ),
    ).toEqual([blocker]);
  });
});
