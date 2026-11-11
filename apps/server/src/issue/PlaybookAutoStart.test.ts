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

const row = (key: string, autoTried = false): IssuePlaybookEntries.PlaybookEntryRow => ({
  issueKey: issueKey(key),
  board: "acme/1",
  playbook: "deploy",
  startedBy: null,
  autoTried,
  startFailure: null,
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
});

interface Harness {
  readonly reads: Queue.Queue<void>;
  /** Each Start the server asked for, before its claim. */
  readonly attempts: Queue.Queue<string>;
  readonly started: Queue.Queue<string>;
  readonly publish: (value: IssueBoardResult) => Effect.Effect<void>;
  readonly setInterval: (interval: Duration.Duration) => Effect.Effect<void>;
}

function harness<A, E>(
  input: {
    readonly listed: ReadonlyArray<IssueBoardEntry>;
    /** Issues with a record, waiting untried; the listed ones when left out. */
    readonly recorded?: ReadonlyArray<string>;
    readonly start?: (key: string) => Effect.Effect<void>;
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
    } as ServerSettingsValue);
    const changes = yield* PubSub.unbounded<ServerSettingsValue>();
    const publish = (value: IssueBoardResult) => SubscriptionRef.set(latest, value);

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
            setInterval: (interval) =>
              Ref.updateAndGet(settings, (current) => ({
                ...current,
                githubBoardReadInterval: interval,
              })).pipe(Effect.flatMap((next) => PubSub.publish(changes, next))),
          }),
        ),
      ),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(IssueService.IssueService)({
            board: Queue.offer(reads, undefined).pipe(
              Effect.andThen(publish(result(input.listed))),
              Effect.as(result(input.listed)),
            ),
            boardChanges: SubscriptionRef.changes(latest).pipe(
              Stream.filter((value): value is IssueBoardResult => value !== null),
            ),
          }),
          // Claims as Start does, so an entry it tried is not offered again.
          Layer.mock(PlaybookStartService.PlaybookStartService)({
            start: ({ playbook, entry: startEntry }, options) =>
              Effect.gen(function* () {
                yield* Queue.offer(attempts, startEntry.key);
                const claimed = yield* store
                  .claim({
                    issueKey: issueKey(startEntry.key),
                    playbook,
                    startedBy: `issue-playbook:${startEntry.key}`,
                    auto: options?.auto === true,
                  })
                  .pipe(Effect.orDie);
                if (!claimed) {
                  return yield* new IssueOperationError({
                    operation: "startPlaybook",
                    detail: "not waiting",
                  });
                }
                yield* input.start?.(startEntry.key) ?? Effect.void;
                yield* Queue.offer(started, startEntry.key);
                return { threadId: ThreadId.make(`thread ${startEntry.key}`) };
              }),
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
        ({ reads, attempts, started, publish, setInterval }) =>
          Effect.gen(function* () {
            yield* Queue.take(reads);
            expect(yield* Queue.take(started)).toBe("1");

            yield* TestClock.adjust(DEFAULT_GITHUB_BOARD_READ_INTERVAL);
            yield* Queue.take(reads);

            // A shorter interval applies without a restart: two reads within two of its minutes.
            yield* setInterval(Duration.minutes(1));
            yield* TestClock.adjust(Duration.minutes(1));
            yield* Queue.take(reads);
            yield* TestClock.adjust(Duration.minutes(1));
            yield* Queue.take(reads);

            // 5 meant as minutes is read as 5 ms: the server waits at least 10 seconds.
            yield* setInterval(Duration.millis(5));
            yield* TestClock.adjust(Duration.seconds(10));
            yield* Queue.take(reads);
            yield* Queue.takeAll(reads);
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
});
