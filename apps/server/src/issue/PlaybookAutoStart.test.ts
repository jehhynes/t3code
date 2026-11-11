import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_GITHUB_BOARD_READ_INTERVAL,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  ThreadId,
  type IssueBoardEntry,
  type IssueBoardResult,
  type IssuePlaybook,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueService from "./IssueService.ts";
import { autoStartEntries } from "./PlaybookAutoStart.ts";
import * as PlaybookAutoStart from "./PlaybookAutoStart.ts";
import * as PlaybookStartService from "./PlaybookStartService.ts";

const entry = (key: string, overrides: Partial<IssueBoardEntry> = {}): IssueBoardEntry => ({
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "acme/web",
  key,
  displayKey: `#${key}`,
  title: `Issue ${key}`,
  url: `https://github.com/acme/web/issues/${key}`,
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  status: "Ready",
  blockers: [],
  projectId: ProjectId.make("web"),
  projectTitle: "web",
  playbook: "deploy",
  hasOpenThread: false,
  waitingPlaybook: "deploy",
  ...overrides,
});
const issueKey = (key: string) => `github github.com acme/web ${key}`;

const result = (
  entries: ReadonlyArray<IssueBoardEntry>,
  overrides: Partial<IssueBoardResult> = {},
): IssueBoardResult => ({
  boards: [
    { owner: "acme", number: 1, statusField: "Status", enabled: true, entries, error: null },
  ],
  playbookErrors: [],
  ...overrides,
});

const playbooks: ReadonlyArray<IssuePlaybook> = [
  { name: "deploy", rules: {}, prompt: "p", autoStart: true },
  { name: "develop", rules: {}, prompt: "p" },
];

const row = (
  key: string,
  autoTried = false,
  overrides: Partial<IssuePlaybookEntries.PlaybookEntryRow> = {},
): IssuePlaybookEntries.PlaybookEntryRow => ({
  issueKey: issueKey(key),
  board: "acme/1",
  playbook: "deploy",
  startedBy: null,
  autoTried,
  startFailure: null,
  leftAt: null,
  startQueued: false,
  waitingSince: null,
  ...overrides,
});

describe("autoStartEntries", () => {
  it("picks each waiting issue of a self-starting playbook that has a project and was not tried", () => {
    const rows = new Map(
      [row("1"), row("2"), row("3"), row("4", true), row("5")].map((r) => [r.issueKey, r]),
    );
    const listed = [
      entry("1"),
      entry("2", { waitingPlaybook: "develop" }),
      entry("3", { projectId: null }),
      entry("4"),
      entry("5", { waitingPlaybook: null }),
      entry("6"),
    ];
    expect(
      autoStartEntries({ result: result(listed), playbooks, rows }).map((s) => s.entry.key),
    ).toEqual(["1"]);
    // Nothing starts while any playbook cannot select, or from a board that is off or failed.
    for (const blocked of [
      result(listed, { playbookErrors: ["Playbook 2: Expected object"] }),
      { ...result(listed), boards: [{ ...result(listed).boards[0]!, enabled: false }] },
      { ...result(listed), boards: [{ ...result(listed).boards[0]!, error: "Bad credentials" }] },
    ]) {
      expect(autoStartEntries({ result: blocked, playbooks, rows })).toEqual([]);
    }
  });

  it("holds an issue with an open blocker on a board that waits for blockers, and starts a queued one once none is left", () => {
    const blocker = {
      scope: "acme/web",
      key: "12",
      displayKey: "#12",
      title: "Blocker",
      url: "https://github.com/acme/web/issues/12",
    };
    const queued = { playbook: "develop", startQueued: true };
    const rows = new Map(
      [
        row("1"),
        row("2", false, queued),
        row("3", true, { ...queued, playbook: "deploy" }),
        row("4", false, { playbook: "develop" }),
      ].map((r) => [r.issueKey, r]),
    );
    const listed = (blockers: ReadonlyArray<typeof blocker>) => [
      entry("1", { blockers }),
      entry("2", { waitingPlaybook: "develop", blockers }),
      entry("3", { blockers }),
      entry("4", { waitingPlaybook: "develop", blockers }),
    ];
    const waiting = (blockers: ReadonlyArray<typeof blocker>, waitForBlockers?: boolean) => {
      const read = result(listed(blockers));
      return {
        ...read,
        boards: read.boards.map((board) =>
          waitForBlockers === undefined ? board : { ...board, waitForBlockers },
        ),
      };
    };
    const keys = (read: IssueBoardResult) =>
      autoStartEntries({ result: read, playbooks, rows }).map((s) => s.entry.key);

    expect(keys(waiting([blocker], true))).toEqual([]);
    // Once no blocker is left: the untried self-starting one, and each queued one, tried or not.
    expect(keys(waiting([], true))).toEqual(["1", "2", "3"]);
    // A board that does not wait for blockers starts them as before.
    expect(keys(waiting([blocker]))).toEqual(["1", "2", "3"]);
    expect(keys(waiting([blocker], false))).toEqual(["1", "2", "3"]);
  });

  it("orders the waiting issues by when they began to wait, a record without a time first", () => {
    const rows = new Map(
      [
        row("1", false, { waitingSince: "2026-11-11T12:00:00.000Z" }),
        row("2", false, {
          playbook: "develop",
          startQueued: true,
          waitingSince: "2026-11-11T10:00:00.000Z",
        }),
        row("3", false, { waitingSince: "2026-11-11T11:00:00.000Z" }),
        row("4"),
        row("5", false, { waitingSince: "2026-11-11T11:00:00.000Z" }),
      ].map((r) => [r.issueKey, r]),
    );
    const listed = [
      entry("1"),
      entry("2", { waitingPlaybook: "develop" }),
      entry("3"),
      entry("4"),
      entry("5"),
    ];
    expect(
      autoStartEntries({ result: result(listed), playbooks, rows }).map((s) => s.entry.key),
    ).toEqual(["4", "2", "3", "5", "1"]);
  });
});

interface Harness {
  readonly reads: Queue.Queue<void>;
  /** Each Start the server asked for, before its claim. */
  readonly attempts: Queue.Queue<string>;
  readonly started: Queue.Queue<string>;
  readonly publish: (value: IssueBoardResult) => Effect.Effect<void>;
  readonly setSettings: (change: Partial<ServerSettingsValue>) => Effect.Effect<void>;
  /** Holds each board read until the returned effect lets it go. */
  readonly holdReads: Effect.Effect<Effect.Effect<void>>;
  /** A thread's turn ends: one more slot is free, and the starter is told. */
  readonly freeSlot: Effect.Effect<void>;
}

function harness<A, E>(
  input: {
    readonly listed: ReadonlyArray<IssueBoardEntry>;
    /** Issues with a record, waiting untried; the listed ones when left out. */
    readonly recorded?: ReadonlyArray<string>;
    readonly start?: (key: string) => Effect.Effect<void>;
    /** Free slots; a start finds none once they are taken. Unlimited when left out. */
    readonly slots?: number;
  },
  body: (context: Harness) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-playbook-autostart-" });
    yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
    yield* fs.writeFileString(`${baseDir}/userdata/playbooks.json`, JSON.stringify(playbooks));

    const reads = yield* Queue.unbounded<void>();
    const attempts = yield* Queue.unbounded<string>();
    const started = yield* Queue.unbounded<string>();
    const latest = yield* SubscriptionRef.make<IssueBoardResult | null>(null);
    const settings = yield* Ref.make({
      githubBoardReadInterval: DEFAULT_GITHUB_BOARD_READ_INTERVAL,
      githubBoards: [] as ServerSettingsValue["githubBoards"],
    } as ServerSettingsValue);
    const gate = yield* Ref.make<Deferred.Deferred<void> | null>(null);
    const changes = yield* PubSub.unbounded<ServerSettingsValue>();
    const publish = (value: IssueBoardResult) => SubscriptionRef.set(latest, value);
    const free = yield* Ref.make(input.slots ?? Number.POSITIVE_INFINITY);
    const freed = yield* Queue.unbounded<void>();

    const store = Context.get(
      yield* Layer.build(
        IssuePlaybookEntries.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      ),
      IssuePlaybookEntries.IssuePlaybookEntriesRepository,
    );
    yield* store.reconcile(() =>
      (input.recorded ?? input.listed.map((listed) => listed.key)).map((key) => row(key)),
    );

    return yield* Effect.scoped(
      Layer.build(PlaybookAutoStart.layer).pipe(
        Effect.andThen(
          body({
            reads,
            attempts,
            started,
            publish,
            setSettings: (change) =>
              Ref.updateAndGet(settings, (current) => ({ ...current, ...change })).pipe(
                Effect.flatMap((next) => PubSub.publish(changes, next)),
              ),
            holdReads: Deferred.make<void>().pipe(
              Effect.tap((held) => Ref.set(gate, held)),
              Effect.map((held) =>
                Ref.set(gate, null).pipe(Effect.andThen(Deferred.succeed(held, undefined))),
              ),
            ),
            freeSlot: Ref.update(free, (slots) => slots + 1).pipe(
              Effect.andThen(Queue.offer(freed, undefined)),
            ),
          }),
        ),
      ),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(IssueService.IssueService)({
            board: Queue.offer(reads, undefined).pipe(
              Effect.andThen(Ref.get(gate)),
              Effect.flatMap((held) => (held === null ? Effect.void : Deferred.await(held))),
              Effect.andThen(publish(result(input.listed))),
              Effect.as(result(input.listed)),
            ),
            boardChanges: SubscriptionRef.changes(latest).pipe(
              Stream.filter((value): value is IssueBoardResult => value !== null),
            ),
            withLatestBoard: (use) => SubscriptionRef.get(latest).pipe(Effect.flatMap(use)),
          }),
          // Claims as Start does, so an entry it tried is not offered again.
          Layer.mock(PlaybookStartService.PlaybookStartService)({
            start: (request, options) =>
              Effect.gen(function* () {
                if (!("entry" in request)) return yield* Effect.die("no cancel here");
                const { playbook, entry: startEntry } = request;
                yield* Queue.offer(attempts, startEntry.key);
                // No free slot: nothing is claimed, so the try is not spent.
                if ((yield* Ref.get(free)) <= 0) return { threadId: null };
                const claimed = yield* store
                  .claim({
                    issueKey: issueKey(startEntry.key),
                    playbook,
                    startedBy: `issue-playbook:${startEntry.key}`,
                    auto: options?.auto === true,
                    selfStarting: playbook === "deploy",
                  })
                  .pipe(Effect.orDie);
                if (!claimed) {
                  return yield* new IssueOperationError({
                    operation: "startPlaybook",
                    detail: "not waiting",
                  });
                }
                yield* input.start?.(startEntry.key) ?? Effect.void;
                yield* Ref.update(free, (slots) => slots - 1);
                yield* Queue.offer(started, startEntry.key);
                return { threadId: ThreadId.make(`thread ${startEntry.key}`) };
              }),
            awaitFreedSlot: Queue.take(freed),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.get(settings),
            subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          }),
          Layer.succeed(IssuePlaybookEntries.IssuePlaybookEntriesRepository, store),
          ServerConfig.layerTest(process.cwd(), baseDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}

describe("PlaybookAutoStart", () => {
  it.effect(
    "reads the boards at start and each interval with no client, and starts what waits",
    () =>
      harness(
        { listed: [entry("1")], recorded: ["1", "2"] },
        ({ reads, attempts, started, publish, setSettings, holdReads }) =>
          Effect.gen(function* () {
            yield* Queue.take(reads);
            expect(yield* Queue.take(started)).toBe("1");

            yield* TestClock.adjust(DEFAULT_GITHUB_BOARD_READ_INTERVAL);
            yield* Queue.take(reads);

            // A shorter interval applies without a restart: two reads within two of its minutes.
            yield* setSettings({ githubBoardReadInterval: Duration.minutes(1) });
            yield* TestClock.adjust(Duration.minutes(1));
            yield* Queue.take(reads);
            yield* TestClock.adjust(Duration.minutes(1));
            yield* Queue.take(reads);

            // 5 meant as minutes is read as 5 ms: the server waits at least 10 seconds.
            yield* setSettings({ githubBoardReadInterval: Duration.millis(5) });
            yield* TestClock.adjust(Duration.seconds(10));
            yield* Queue.take(reads);
            yield* Queue.takeAll(reads);
            yield* TestClock.adjust(Duration.seconds(9));
            expect(yield* Queue.size(reads)).toBe(0);
            yield* TestClock.adjust(Duration.seconds(1));
            yield* Queue.take(reads);

            // Fork-only (jehhynes/t3code#85): a change to the boards reads them at once, even one
            // made while a read runs; a change that leaves them and the interval alone does not.
            const board = { owner: "acme", number: 1, statusField: "Status" };
            yield* setSettings({ maxRunningIssueThreads: 3 });
            yield* TestClock.adjust(Duration.seconds(9));
            expect(yield* Queue.size(reads)).toBe(0);
            yield* setSettings({ githubBoards: [board] });
            yield* Queue.take(reads);
            const release = yield* holdReads;
            yield* TestClock.adjust(Duration.seconds(10));
            yield* Queue.take(reads);
            yield* setSettings({ githubBoards: [board, { ...board, number: 2 }] });
            yield* release;
            yield* Queue.take(reads);
            yield* setSettings({ githubBoards: [{ ...board }, { ...board, number: 2 }] });
            yield* TestClock.adjust(Duration.seconds(9));
            expect(yield* Queue.size(reads)).toBe(0);
            yield* TestClock.adjust(Duration.seconds(1));
            yield* Queue.take(reads);

            // Results are handled in turn, so once #2 starts every read before it was handled:
            // each listed #1 again, and it was tried only once.
            yield* publish(result([entry("1"), entry("2")]));
            expect(yield* Queue.take(started)).toBe("2");
            expect([...(yield* Queue.takeAll(attempts))]).toEqual(["1", "2"]);
          }),
      ),
  );

  // Fork-only (jehhynes/t3code#76)
  it.effect(
    "starts as many as there are free slots, then the next oldest each time a slot frees, with no board read",
    () =>
      harness(
        { listed: [entry("1"), entry("2"), entry("3"), entry("4")], slots: 2 },
        ({ reads, attempts, started, freeSlot }) =>
          Effect.gen(function* () {
            yield* Queue.take(reads);
            expect(yield* Queue.take(started)).toBe("1");
            expect(yield* Queue.take(started)).toBe("2");

            // #3 found no slot and the pass stopped there, so #4 was not tried before the wake.
            yield* freeSlot;
            expect(yield* Queue.take(started)).toBe("3");
            yield* freeSlot;
            expect(yield* Queue.take(started)).toBe("4");
            expect([...(yield* Queue.takeAll(attempts))]).toEqual(["1", "2", "3", "3", "4", "4"]);
            expect(yield* Queue.size(reads)).toBe(0);
          }),
      ),
  );

  it.effect("starts an issue held by a blocker and by the limit only once both allow it", () => {
    const blocker = {
      scope: "acme/web",
      key: "12",
      displayKey: "#12",
      title: "Blocker",
      url: "https://github.com/acme/web/issues/12",
    };
    const waitsForBlockers = (entries: ReadonlyArray<IssueBoardEntry>) => {
      const read = result(entries);
      return { ...read, boards: read.boards.map((board) => ({ ...board, waitForBlockers: true })) };
    };
    return harness(
      { listed: [entry("1")], recorded: ["1", "2"], slots: 1 },
      ({ reads, attempts, started, publish, freeSlot }) =>
        Effect.gen(function* () {
          yield* Queue.take(reads);
          expect(yield* Queue.take(started)).toBe("1");
          yield* Queue.takeAll(attempts);

          // Held by its blocker, #2 is not tried.
          yield* publish(waitsForBlockers([entry("2", { blockers: [blocker] })]));
          // Its blocker closes while no slot is free: it is tried, finds none, and waits.
          yield* publish(waitsForBlockers([entry("2")]));
          expect(yield* Queue.take(attempts)).toBe("2");
          // A slot frees: it starts, and was tried only by that read and this wake.
          yield* freeSlot;
          expect(yield* Queue.take(started)).toBe("2");
          expect([...(yield* Queue.takeAll(attempts))]).toEqual(["2"]);
        }),
    );
  });
});
