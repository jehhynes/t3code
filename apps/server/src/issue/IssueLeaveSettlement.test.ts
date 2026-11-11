import { describe, expect, it } from "@effect/vitest";
import {
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type IssueBoard,
  type IssueBoardResult,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IssueLeaveSettlement from "./IssueLeaveSettlement.ts";
import * as IssueService from "./IssueService.ts";

const linkedAt = "2026-11-10T00:00:00.000Z";
const leftAt = "2026-11-11T00:00:00.000Z";
const key = (number: string) => `github github.com acme/web ${number}`;

const link = (number: string, at = linkedAt): ThreadIssueLink => ({
  tracker: IssueTrackerKind.make("github"),
  host: "GitHub.com",
  scope: "Acme/Web",
  key: number,
  projectId: ProjectId.make("project-1"),
  url: `https://github.com/acme/web/issues/${number}`,
  source: "manual",
  linkedAt: at,
  snapshot: null,
});

const entry = (playbook: string | null, at: string | null = leftAt, board = "acme/1") => ({
  board,
  playbook,
  leftAt: at,
});

describe("issueLeftThreads", () => {
  it.each<{
    name: string;
    issues: ReadonlyArray<ThreadIssueLink>;
    unsettledAt?: string;
    entries: ReadonlyArray<readonly [string, ReturnType<typeof entry>]>;
    deciding?: ReadonlyArray<string>;
    settles: boolean;
  }>([
    {
      name: "a thread whose issue left settles",
      issues: [link("1")],
      entries: [[key("1"), entry(null)]],
      settles: true,
    },
    {
      name: "a thread also linked to an issue still in a selection stays open",
      issues: [link("1"), link("2")],
      entries: [
        [key("1"), entry(null)],
        [key("2"), entry("develop", null)],
      ],
      settles: false,
    },
    {
      name: "a thread whose issue moved to another playbook, or came back, stays open",
      issues: [link("1")],
      entries: [[key("1"), entry("ship")]],
      settles: false,
    },
    {
      name: "a thread linked to an issue on no board, beside one that left, settles",
      issues: [link("1"), link("9")],
      entries: [[key("1"), entry(null)]],
      settles: true,
    },
    {
      name: "a thread linked after the leave, or in the same millisecond, stays open",
      issues: [link("1", "2026-11-11T00:00:00Z"), link("2", "2026-11-12T00:00:00.000Z")],
      entries: [
        [key("1"), entry(null)],
        [key("2"), entry(null)],
      ],
      settles: false,
    },
    {
      name: "times compare as instants, not as text",
      issues: [link("1", "2026-11-11T00:00:00Z")],
      entries: [[key("1"), entry(null, "2026-11-11T00:00:00.500Z")]],
      settles: true,
    },
    {
      name: "a thread un-settled after the leave stays open, also once a message cleared the override",
      issues: [link("1")],
      unsettledAt: "2026-11-11T00:00:01.000Z",
      entries: [[key("1"), entry(null)]],
      settles: false,
    },
    {
      name: "a thread un-settled before a later leave settles",
      issues: [link("1")],
      unsettledAt: "2026-11-10T12:00:00.000Z",
      entries: [[key("1"), entry(null)]],
      settles: true,
    },
    {
      name: "a leave on a board that did not decide the latest read settles nothing",
      issues: [link("1")],
      entries: [[key("1"), entry(null, leftAt, "acme/2")]],
      settles: false,
    },
    {
      name: "nothing settles before a board decides",
      issues: [link("1")],
      entries: [[key("1"), entry(null)]],
      deciding: [],
      settles: false,
    },
    {
      name: "an issue that left before leaves were recorded, or never was in a selection, settles nothing",
      issues: [link("1"), link("2")],
      entries: [
        [key("1"), entry(null, null)],
        [key("2"), entry(null, "not a time")],
      ],
      settles: false,
    },
    { name: "a thread with no issue stays open", issues: [], entries: [], settles: false },
  ])("$name", ({ issues, unsettledAt, entries, deciding, settles }) => {
    const id = ThreadId.make("thread-1");
    expect(
      IssueLeaveSettlement.issueLeftThreads({
        candidates: [
          {
            id,
            issues,
            unsettledAt: unsettledAt === undefined ? null : DateTime.makeUnsafe(unsettledAt),
          },
        ],
        entries: new Map(entries),
        deciding: new Set(deciding ?? ["acme/1"]),
      }).has(id),
    ).toBe(settles);
  });
});

const board = (number: number, state: "read" | "off" | "failed" = "read"): IssueBoard => ({
  owner: "Acme",
  number,
  statusField: "Status",
  enabled: state !== "off",
  entries: [],
  error: state === "failed" ? "Bad credentials" : null,
});
const result = (
  boards: ReadonlyArray<IssueBoard>,
  playbookErrors: ReadonlyArray<string> = [],
): IssueBoardResult => ({ boards, playbookErrors });

describe("readWakes", () => {
  it("decides with the boards read without error, and none while playbooks.json has a mistake", () => {
    expect([
      ...IssueLeaveSettlement.decidingBoards(
        result([board(1), board(2, "off"), board(3, "failed")]),
      ),
    ]).toEqual(["acme/1"]);
    expect(IssueLeaveSettlement.decidingBoards(result([board(1)], ["Bad JSON"])).size).toBe(0);
  });

  it.each<{
    name: string;
    previous: ReadonlyArray<string>;
    next: ReadonlyArray<string>;
    seenLeftAt: string | null;
    leftAt: string | null;
    wakes: boolean;
  }>([
    {
      name: "a new leave",
      previous: ["acme/1"],
      next: ["acme/1"],
      seenLeftAt: null,
      leftAt,
      wakes: true,
    },
    {
      name: "a later leave",
      previous: ["acme/1"],
      next: ["acme/1"],
      seenLeftAt: "2026-11-10T00:00:00.000Z",
      leftAt,
      wakes: true,
    },
    {
      name: "the same leave on the same boards",
      previous: ["acme/1"],
      next: ["acme/1"],
      seenLeftAt: leftAt,
      leftAt,
      wakes: false,
    },
    {
      name: "a board that decides again at the same leave",
      previous: [],
      next: ["acme/1"],
      seenLeftAt: leftAt,
      leftAt,
      wakes: true,
    },
    {
      name: "no leave recorded",
      previous: [],
      next: ["acme/1"],
      seenLeftAt: null,
      leftAt: null,
      wakes: false,
    },
  ])("$name", ({ previous, next, seenLeftAt, leftAt: latest, wakes }) => {
    expect(
      IssueLeaveSettlement.readWakes({
        previous: new Set(previous),
        next: new Set(next),
        seenLeftAt,
        leftAt: latest,
      }),
    ).toBe(wakes);
  });
});

it.effect(
  "wakes after a read that may settle a thread, and reads only the candidates' entries",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A leave recorded before this start.
      yield* sql`
      INSERT INTO issue_playbook_entries (issue_key, board, playbook, started_by, auto_tried, left_at)
      VALUES (${key("1")}, 'acme/1', NULL, NULL, 0, ${leftAt}),
        (${key("2")}, 'acme/1', 'develop', NULL, 0, NULL)
    `;
      const reads = yield* Queue.unbounded<{
        readonly result: IssueBoardResult;
        readonly done: Deferred.Deferred<void>;
      }>();
      // Each read's `done` completes once the service has handled that read.
      const boardChanges = Stream.fromQueue(reads).pipe(
        Stream.flatMap(({ result: read, done }) =>
          Stream.make(read).pipe(
            Stream.concat(Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain)),
          ),
        ),
      );
      const left = ThreadId.make("left");
      const selected = ThreadId.make("selected");
      yield* Effect.gen(function* () {
        const service = yield* IssueLeaveSettlement.IssueLeaveSettlement;
        const wakes = yield* service.subscribeChanges;
        const read = Effect.fn(function* (next: IssueBoardResult) {
          const done = yield* Deferred.make<void>();
          yield* Queue.offer(reads, { result: next, done });
          yield* Deferred.await(done);
          const count = yield* PubSub.remaining(wakes);
          if (count > 0) yield* PubSub.takeAll(wakes);
          return count;
        });
        const candidates = [
          { id: left, issues: [link("1")] },
          { id: selected, issues: [link("1"), link("2")] },
        ];

        expect(yield* service.threads(candidates)).toEqual(new Set());
        expect(yield* read(result([board(1)]))).toBe(1);
        expect([...(yield* service.threads(candidates))]).toEqual([left]);
        expect(yield* read(result([board(1)]))).toBe(0);
        expect(yield* read(result([board(1, "failed")]))).toBe(0);
        expect(yield* service.threads(candidates)).toEqual(new Set());
        expect(yield* read(result([board(1)]))).toBe(1);
        expect(yield* read(result([board(1)], ["Bad JSON"]))).toBe(0);
        expect(yield* read(result([board(1)]))).toBe(1);
        yield* sql`
        UPDATE issue_playbook_entries SET left_at = '2026-11-12T00:00:00.000Z'
        WHERE issue_key = ${key("1")}
      `;
        expect(yield* read(result([board(1)]))).toBe(1);
      }).pipe(
        Effect.provide(
          IssueLeaveSettlement.layer.pipe(
            Layer.provide(Layer.mock(IssueService.IssueService)({ boardChanges })),
          ),
        ),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
