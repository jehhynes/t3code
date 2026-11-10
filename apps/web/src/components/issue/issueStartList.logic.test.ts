import type {
  EnvironmentId,
  IssueBoard,
  IssueBoardEntry,
  IssueTrackerKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { waitingIssues } from "./issueStartList.logic";

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
  it("lists each selected issue without an open thread once, as the first board selecting it lists it", () => {
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
