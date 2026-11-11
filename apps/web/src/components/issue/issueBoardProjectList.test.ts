// Fork-only (jehhynes/t3code#106).
import type {
  EnvironmentId,
  IssueBoard,
  IssueBoardEntry,
  IssueTrackerKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withoutBoardIssues } from "./issueBoardProjectList";

const env = "env-1" as EnvironmentId;
const otherEnv = "env-2" as EnvironmentId;

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
    updatedAt: "2026-11-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    status: "Ready",
    blockers: [],
    projectId: null,
    projectTitle: null,
    playbook: null,
    hasOpenThread: false,
    ...overrides,
  };
}

function board(overrides: Partial<IssueBoard> = {}): IssueBoard {
  return {
    owner: "acme",
    number: 1,
    statusField: "Status",
    enabled: true,
    entries: [entry("106")],
    error: null,
    ...overrides,
  };
}

const group = (rows = [entry("106"), entry("1")]) => ({
  tracker: { configured: true },
  rows: rows.map((row) => ({ ...row, environmentId: env })),
  errors: [] as string[],
  more: [] as EnvironmentId[],
});

const answers = (boards = [board()]) => [[env, { boards, playbookErrors: [] }]] as const;

describe("withoutBoardIssues", () => {
  it("keeps board issues in their section, matching identity across checkouts and casing", () => {
    const original = group();
    const groups = withoutBoardIssues(
      [original],
      answers([board({ entries: [entry("106", { host: "GitHub.COM", scope: "Acme/Web" })] })]),
      "",
      true,
    );
    expect(groups[0]?.rows.map((row) => row.key)).toEqual(["1"]);
    expect(original.rows.map((row) => row.key)).toEqual(["106", "1"]);
    const alternate = { ...original.rows[0]!, projectId: "alternate-checkout" };
    expect(withoutBoardIssues([{ ...original, rows: [alternate] }], answers(), "", true)).toEqual(
      [],
    );
  });

  it.each([
    { name: "off", boards: [board({ enabled: false })], visible: true },
    { name: "removed", boards: [], visible: true },
    { name: "unreadable", boards: [board({ error: "Cannot read board" })], visible: true },
    { name: "Closed", boards: [board()], visible: false },
  ])("restores project rows when $name", ({ boards, visible }) => {
    const original = [group()];
    expect(withoutBoardIssues(original, answers(), "", true)[0]?.rows).toHaveLength(1);
    expect(withoutBoardIssues(original, answers(boards), "", visible)).toBe(original);
  });

  it("keeps other environments, hosts, repositories, trackers and issue numbers", () => {
    const original = group();
    const row = original.rows[0]!;
    const distinct = [
      { ...row, environmentId: otherEnv },
      { ...row, host: "github.acme.test" },
      { ...row, scope: "acme/other" },
      { ...row, tracker: "gitlab" as IssueTrackerKind },
      original.rows[1]!,
    ];
    const rows = [{ ...original, rows: [row, ...distinct] }];
    expect(withoutBoardIssues(rows, answers(), "", true)[0]?.rows).toEqual(distinct);
  });

  it.each([
    { query: "ISSUE", hidden: true },
    { query: "#106", hidden: true },
    { query: "different board title", hidden: false },
  ])("suppresses only board rows visible for $query", ({ query, hidden }) => {
    const original = [group()];
    expect(withoutBoardIssues(original, answers(), query, true)[0]?.rows).toHaveLength(
      hidden ? 1 : 2,
    );
  });

  it("drops groups emptied by suppression, retaining diagnostics, continuations and existing empty states", () => {
    const onlyBoard = group([entry("106")]);
    const diagnostics = { ...onlyBoard, errors: ["Project could not be read"] };
    const continuation = { ...onlyBoard, more: [env] };
    const unavailable = { ...onlyBoard, tracker: { configured: false } };
    const empty = group([]);
    const groups = withoutBoardIssues(
      [onlyBoard, diagnostics, continuation, unavailable, empty],
      answers(),
      "",
      true,
    );
    expect(groups).toEqual([
      { ...diagnostics, rows: [] },
      { ...continuation, rows: [] },
      { ...unavailable, rows: [] },
      empty,
    ]);
  });
});
