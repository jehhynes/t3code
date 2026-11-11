import type {
  EnvironmentId,
  IssueBoard,
  IssueBoardEntry,
  IssueTrackerKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { otherPlaybooks, draftWorkspace, isSnoozed, waitingIssues } from "./issueStartList.logic";

const env = "env-1" as EnvironmentId;

function entry(key: string, overrides: Partial<IssueBoardEntry> = {}): IssueBoardEntry {
  return {
    tracker: "github" as IssueTrackerKind,
    host: "github.com",
    scope: "acme/web",
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: `https://github.com/acme/web/issues/${key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: `2026-11-0${key}T00:00:00Z`,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    status: "Ready",
    blockers: [],
    projectId: null,
    projectTitle: null,
    playbook: "develop",
    hasOpenThread: false,
    ...overrides,
  };
}

const board = (number: number, entries: ReadonlyArray<IssueBoardEntry>): IssueBoard => ({
  owner: "acme",
  number,
  statusField: "Status",
  enabled: true,
  entries,
  error: null,
});

describe("waitingIssues", () => {
  it("lists each issue that waits once, with the playbook it waits with", () => {
    const waiting = waitingIssues([
      [
        env,
        {
          playbookErrors: [],
          boards: [
            board(1, [
              // Started, and its thread since settled.
              entry("1", { waitingPlaybook: null }),
              // Moved to ship with its thread open.
              entry("2", { playbook: "ship", hasOpenThread: true, waitingPlaybook: "ship" }),
              // Selection is frozen by a mistake; it still waits as before.
              entry("3", { playbook: null, waitingPlaybook: "develop" }),
            ]),
          ],
        },
      ],
    ]);

    expect(waiting.map(({ entry }) => [entry.key, entry.playbook])).toEqual([
      ["3", "develop"],
      ["2", "ship"],
    ]);
  });

  it("from a server older than #7, lists each selected issue without an open thread once, as the first board selecting it lists it", () => {
    const waiting = waitingIssues([
      [
        env,
        {
          playbookErrors: [],
          boards: [
            board(1, [
              entry("1"),
              entry("2", { playbook: null }),
              entry("3", { hasOpenThread: true }),
              entry("4", { playbook: null }),
            ]),
            board(2, [
              entry("1", { scope: "Acme/Web", playbook: "ship" }),
              entry("4", { playbook: "ship" }),
            ]),
          ],
        },
      ],
    ]);

    expect(waiting.map(({ entry }) => [entry.key, entry.playbook])).toEqual([
      ["4", "ship"],
      ["1", "develop"],
    ]);
  });
});

describe("hold", () => {
  const blocker = (key: string) => ({
    scope: "acme/web",
    key,
    displayKey: `#${key}`,
    title: `Blocker ${key}`,
    url: `https://github.com/acme/web/issues/${key}`,
  });

  it("holds a waiting issue with an open blocker only on a board that waits for blockers", () => {
    const blockers = [blocker("12")];
    const rows = (waitForBlockers: boolean | undefined) =>
      waitingIssues([
        [
          env,
          {
            playbookErrors: [],
            boards: [
              {
                ...board(1, [
                  entry("1", { waitingPlaybook: "develop", blockers }),
                  entry("2", { waitingPlaybook: "develop", blockers, startsBySelf: true }),
                  entry("3", { waitingPlaybook: "develop" }),
                ]),
                ...(waitForBlockers === undefined ? {} : { waitForBlockers }),
              },
            ],
          },
        ],
      ]).map((issue) => [issue.entry.key, issue.hold]);

    expect(rows(true)).toEqual([
      ["3", null],
      ["2", "starts"],
      ["1", "waits"],
    ]);
    expect(rows(undefined).map(([, hold]) => hold)).toEqual([null, null, null]);
  });

  // Fork-only (jehhynes/t3code#76)
  it("holds an issue that starts by itself, or was queued, until a slot frees, naming a blocker first", () => {
    const projectId = "web" as IssueBoardEntry["projectId"];
    const waits = { waitingPlaybook: "develop", projectId };
    const rows = (playbookErrors: ReadonlyArray<string>) =>
      waitingIssues([
        [
          env,
          {
            playbookErrors,
            boards: [
              {
                ...board(1, [
                  entry("1", { ...waits, startsBySelf: true }),
                  entry("2", { ...waits, startQueued: true, startsBySelf: true }),
                  entry("3", { ...waits }),
                  entry("4", { ...waits, startsBySelf: true, projectId: null }),
                  entry("5", {
                    ...waits,
                    startQueued: true,
                    startsBySelf: true,
                    blockers: [blocker("12")],
                  }),
                ]),
                waitForBlockers: true,
              },
            ],
          },
        ],
      ]).map((issue) => [issue.entry.key, issue.hold]);

    expect(rows([])).toEqual([
      ["5", "starts"],
      ["4", null],
      ["3", null],
      ["2", "slot"],
      ["1", "slot"],
    ]);
    // During a mistake nothing starts by itself: an untried issue keeps its Start.
    expect(rows(["Playbook 2: a prompt is required"])).toEqual([
      ["5", "starts"],
      ["4", null],
      ["3", null],
      ["2", "slot"],
      ["1", null],
    ]);
  });
});

// Fork-only (jehhynes/t3code#86)
describe("isSnoozed", () => {
  it("holds a waiting issue until its wake, read as an instant", () => {
    const wake = "2026-11-12T09:00:00.000Z";
    const wakeMs = Date.parse(wake);
    const issues = waitingIssues([
      [
        env,
        {
          playbookErrors: [],
          boards: [
            board(1, [
              entry("1", { waitingPlaybook: "develop", snoozedUntil: wake }),
              entry("2", { waitingPlaybook: "develop", snoozedUntil: "2026-11-12T04:00:00-05:00" }),
              entry("3", { waitingPlaybook: "develop", snoozedUntil: null }),
              entry("4", { waitingPlaybook: "develop" }),
            ]),
          ],
        },
      ],
    ]);
    const snoozed = (nowMs: number) =>
      issues.filter((issue) => isSnoozed(issue, nowMs)).map((issue) => issue.entry.key);

    expect(snoozed(wakeMs - 1)).toEqual(["2", "1"]);
    // At the wake itself, and after it, it waits again.
    expect(snoozed(wakeMs)).toEqual([]);
    expect(snoozed(wakeMs + 60_000)).toEqual([]);
  });
});

describe("otherPlaybooks", () => {
  it.each([
    { own: "Ship", playbooks: ["develop", "ship", "other"], others: ["develop", "other"] },
    { own: "ship", playbooks: undefined, others: [] },
    // Fork-only (jehhynes/t3code#93): no issue starts with a triage playbook.
    {
      own: "triage",
      playbooks: ["triage", "Sort", "fix", "answer"],
      triagePlaybooks: ["triage", "sort"],
      others: ["fix", "answer"],
    },
  ])("lists $others besides $own", ({ own, playbooks, others, triagePlaybooks }) => {
    expect(
      otherPlaybooks({
        environmentId: env,
        entry: { ...entry("1"), playbook: own },
        playbooks,
        hold: null,
        triage: null,
        triagePlaybooks,
      }),
    ).toEqual(others);
  });
});

// Fork-only (jehhynes/t3code#93)
describe("triage", () => {
  it("tells a row whose triage playbook still chooses, or failed to, from one it chose for", () => {
    const rows = (triagePlaybooks: ReadonlyArray<string> | undefined) =>
      waitingIssues([
        [
          env,
          {
            playbookErrors: [],
            ...(triagePlaybooks === undefined ? {} : { triagePlaybooks }),
            boards: [
              board(1, [
                entry("1", { waitingPlaybook: "Triage" }),
                entry("2", { waitingPlaybook: "triage", startFailure: "No answer in time." }),
                entry("3", { waitingPlaybook: "fix", triagedBy: "triage" }),
                entry("4", { waitingPlaybook: "develop" }),
              ]),
            ],
          },
        ],
      ]).map((issue) => [issue.entry.key, issue.triage]);

    expect(rows(["triage"])).toEqual([
      ["4", null],
      ["3", null],
      ["2", "failed"],
      ["1", "choosing"],
    ]);
    // A server older than #93 has no triage playbooks.
    expect(rows(undefined).map(([, triage]) => triage)).toEqual([null, null, null, null]);
  });
});

describe("draftWorkspace", () => {
  it.each([
    {
      workspace: { type: "existing_worktree", worktreePath: "/w/t3-6" } as const,
      draft: { envMode: "worktree", worktreePath: "/w/t3-6", branch: null, startFromOrigin: false },
    },
    {
      workspace: { type: "worktree", baseRef: "origin/main", startFromOrigin: true } as const,
      draft: {
        envMode: "worktree",
        worktreePath: null,
        branch: "origin/main",
        startFromOrigin: true,
      },
    },
    {
      workspace: { type: "root" } as const,
      draft: { envMode: "local", worktreePath: null, branch: null, startFromOrigin: false },
    },
  ])("opens a $workspace.type draft with every folder field set", ({ workspace, draft }) => {
    expect(draftWorkspace(workspace)).toEqual(draft);
  });
});
