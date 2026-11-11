import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type IssueBoardEntry,
  type IssueBoardResult,
  type IssuePlaybook,
  type ModelSelection,
} from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTriage from "./IssueTriage.ts";

const issueKey = (key: string) => `github github.com acme/web ${key}`;
const entered = "2026-11-11T10:00:00.000Z";

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
  status: "Backlog",
  blockers: [],
  projectId: ProjectId.make("web"),
  projectTitle: "web",
  playbook: "triage",
  hasOpenThread: false,
  waitingPlaybook: "triage",
  ...overrides,
});

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

const row = (
  key: string,
  overrides: Partial<IssuePlaybookEntries.PlaybookEntryRow> = {},
): IssuePlaybookEntries.PlaybookEntryRow => ({
  issueKey: issueKey(key),
  board: "acme/1",
  playbook: "triage",
  startedBy: null,
  autoTried: false,
  startFailure: null,
  leftAt: null,
  startQueued: false,
  waitingSince: entered,
  snoozedUntil: null,
  triage: null,
  ...overrides,
});

const playbooks: ReadonlyArray<IssuePlaybook> = [
  { name: "triage", rules: {}, prompt: "Sort it.", choices: ["answer", "Fix"] },
  { name: "answer", rules: {}, prompt: "Answer.", description: "A question", autoStart: true },
  { name: "fix", rules: {}, prompt: "Fix.", description: "Something broken" },
  { name: "develop", rules: {}, prompt: "Develop." },
];

const claude: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
};
const codex: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

/** Model text a hostile issue could get into a provider's error or answer. */
const hostile = "SECRET-FROM-MODEL";

interface Call {
  readonly key: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly answer: Deferred.Deferred<string, TextGenerationError>;
}

/**
 * Board results are handled in turn, so once a later result's issue is called, every earlier
 * result was handled: the next call names `key` only if those made none.
 */
const nextCall = (calls: Queue.Queue<Call>, key: string) =>
  Queue.take(calls).pipe(Effect.tap((call) => Effect.sync(() => expect(call.key).toBe(key))));

describe("triageCandidates", () => {
  const now = "2026-11-11T12:00:00.000Z";
  it("picks each issue waiting unclassified in a triage playbook, with a project, unsnoozed and without a failure", () => {
    const rows = new Map(
      [
        row("1"),
        row("2", { playbook: "develop" }),
        row("3"),
        row("4", { startFailure: "failed" }),
        row("5", { snoozedUntil: "2026-11-12T00:00:00.000Z" }),
        row("6", { playbook: "fix", triage: "triage" }),
        row("7", { startedBy: "issue-playbook:a" }),
      ].map((candidate) => [candidate.issueKey, candidate]),
    );
    const listed = [
      entry("1"),
      entry("2", { waitingPlaybook: "develop" }),
      entry("3", { projectId: null }),
      entry("4"),
      entry("5"),
      entry("6", { waitingPlaybook: "fix" }),
      entry("7", { waitingPlaybook: null }),
      entry("8"),
    ];
    const keys = (value: IssueBoardResult) =>
      IssueTriage.triageCandidates({ result: value, playbooks, rows, now }).map(
        (candidate) => candidate.entry.key,
      );
    expect(keys(result(listed))).toEqual(["1"]);
    // None while any playbook cannot select, or from a board that is off or failed.
    expect(keys(result(listed, { playbookErrors: ["Playbook 2: Expected object"] }))).toEqual([]);
    expect(
      keys({ ...result(listed), boards: [{ ...result(listed).boards[0]!, enabled: false }] }),
    ).toEqual([]);
    expect(
      keys({ ...result(listed), boards: [{ ...result(listed).boards[0]!, error: "x" }] }),
    ).toEqual([]);
  });
});

function harness<A, E>(
  input: {
    readonly listed: ReadonlyArray<IssueBoardEntry>;
    readonly rows: ReadonlyArray<IssuePlaybookEntries.PlaybookEntryRow>;
    readonly playbooks?: ReadonlyArray<IssuePlaybook>;
    /** The text generation model in Settings; Claude when left out. */
    readonly model?: ModelSelection;
    /** Whether reading the issue from GitHub fails. */
    readonly readFails?: boolean;
    /** Whether the model call dies with the model's text instead of answering. */
    readonly callDies?: boolean;
  },
  body: (context: {
    readonly calls: Queue.Queue<Call>;
    readonly refreshed: Queue.Queue<void>;
    readonly publish: (value: IssueBoardResult) => Effect.Effect<void>;
    readonly entries: IssuePlaybookEntries.IssuePlaybookEntriesRepository["Service"];
    readonly stored: (
      key: string,
    ) => Effect.Effect<IssuePlaybookEntries.PlaybookEntryRow | undefined>;
    readonly triage: IssueTriage.IssueTriage["Service"];
    readonly writePlaybooks: (value: ReadonlyArray<IssuePlaybook>) => Effect.Effect<void>;
    /** Whether the record's writes fail. */
    readonly failWrites: Ref.Ref<boolean>;
    /** Each classification outcome the service tried to write. */
    readonly writes: Queue.Queue<void>;
  }) => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-issue-triage-" });
    yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
    const writePlaybooks = (value: ReadonlyArray<IssuePlaybook>) =>
      fs
        .writeFileString(`${baseDir}/userdata/playbooks.json`, JSON.stringify(value))
        .pipe(Effect.orDie);
    yield* writePlaybooks(input.playbooks ?? playbooks);

    const calls = yield* Queue.unbounded<Call>();
    const refreshed = yield* Queue.unbounded<void>();
    const latest = yield* SubscriptionRef.make<IssueBoardResult | null>(null);
    const failWrites = yield* Ref.make(false);
    const store = Context.get(
      yield* Layer.build(
        IssuePlaybookEntries.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      ),
      IssuePlaybookEntries.IssuePlaybookEntriesRepository,
    );
    yield* store.reconcile(() => input.rows);
    const writes = yield* Queue.unbounded<void>();
    const entries: IssuePlaybookEntries.IssuePlaybookEntriesRepository["Service"] = {
      ...store,
      setTriage: (write) =>
        Queue.offer(writes, undefined).pipe(
          Effect.andThen(Ref.get(failWrites)),
          Effect.flatMap((fails) =>
            fails
              ? Effect.fail(
                  new PersistenceSqlError({ operation: "test", cause: new Error("disk full") }),
                )
              : store.setTriage(write),
          ),
        ),
    };

    const generation = (key: string) =>
      ({
        generateTranscriptionPostProcessing: ({ prompt, modelSelection }) =>
          Effect.gen(function* () {
            if (input.callDies === true) return yield* Effect.die(new Error(hostile));
            const answer = yield* Deferred.make<string, TextGenerationError>();
            const issue = /Issue (\d+) in/.exec(prompt)?.[1] ?? key;
            yield* Queue.offer(calls, { key: issue, prompt, modelSelection, answer });
            return { transcription: yield* Deferred.await(answer) };
          }),
      }) as ProviderTextGeneration;

    const layer = IssueTriage.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(IssueService.IssueService)({
            boardChanges: SubscriptionRef.changes(latest).pipe(
              Stream.filter((value): value is IssueBoardResult => value !== null),
            ),
            withLatestBoard: (use) => SubscriptionRef.get(latest).pipe(Effect.flatMap(use)),
            // Publishes the latest result again, as the server does after each change.
            refreshWaiting: Queue.offer(refreshed, undefined).pipe(
              Effect.andThen(SubscriptionRef.update(latest, (value) => value && { ...value })),
            ),
            detail: (ref) =>
              input.readFails === true
                ? Effect.fail(new IssueOperationError({ operation: "detail", detail: hostile }))
                : Effect.succeed({
                    title: `Issue ${ref.key}`,
                    body: "It is broken.",
                    comments: [],
                  } as never),
          }),
          Layer.succeed(IssuePlaybookEntries.IssuePlaybookEntriesRepository, entries),
          ServerSettings.ServerSettingsService.layerTest({
            textGenerationModelSelection: input.model ?? claude,
          }),
          Layer.mock(TextGenerators.TextGenerators)({
            runner: () => Effect.undefined,
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (id) =>
              Effect.succeed({
                instanceId: id,
                driverKind: ProviderDriverKind.make(
                  id === claude.instanceId ? "claudeAgent" : "codex",
                ),
                textGeneration: generation(id),
              } as never),
          }),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(7)),
          ),
          ServerConfig.layerTest(process.cwd(), baseDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
    return yield* Effect.scoped(
      Layer.build(layer).pipe(
        Effect.flatMap((context) =>
          body({
            calls,
            refreshed,
            publish: (value) => SubscriptionRef.set(latest, value),
            entries,
            stored: (key) =>
              store.list.pipe(
                Effect.map((rows) => rows.get(issueKey(key))),
                Effect.orDie,
              ),
            triage: Context.get(context, IssueTriage.IssueTriage),
            writePlaybooks,
            failWrites,
            writes,
          }),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}

describe("IssueTriage", () => {
  it.effect("classifies an entering issue once, with the triage prompt, and keeps the choice", () =>
    harness(
      { listed: [entry("1")], rows: [row("1"), row("9")] },
      ({ calls, refreshed, publish, stored }) =>
        Effect.gen(function* () {
          yield* publish(result([entry("1")]));
          const call = yield* Queue.take(calls);
          // The text generation model in Settings, as it stores it.
          expect(call.modelSelection).toMatchObject(claude);
          expect(call.prompt).toContain(
            "Sort it.\n\nChoose one playbook:\n- answer: A question\n- fix: Something broken",
          );
          yield* Deferred.succeed(call.answer, " fix ");
          yield* Queue.take(refreshed);
          expect(yield* stored("1")).toMatchObject({
            playbook: "fix",
            triage: "triage",
            startFailure: null,
            waitingSince: entered,
          });
          // Later reads make no call.
          const chosen = entry("1", { waitingPlaybook: "fix", triagedBy: "triage" });
          yield* publish(result([chosen]));
          yield* publish(result([chosen, entry("9")]));
          yield* nextCall(calls, "9");
        }),
    ),
  );

  it.effect("runs at most two calls at once", () =>
    harness({ listed: [], rows: [row("1"), row("2"), row("3")] }, ({ calls, refreshed, publish }) =>
      Effect.gen(function* () {
        yield* publish(result([entry("1"), entry("2"), entry("3")]));
        const first = yield* Queue.take(calls);
        yield* Queue.take(calls);
        expect(yield* Queue.size(calls)).toBe(0);
        yield* Deferred.succeed(first.answer, "answer");
        yield* Queue.take(refreshed);
        expect((yield* Queue.take(calls)).key).toBe("3");
      }),
    ),
  );

  it.effect.each([
    {
      name: "an answer naming no listed playbook",
      answer: Effect.succeed(`deploy ${hostile}`),
      cause: "The classifier's answer named no listed playbook.",
    },
    {
      name: "a provider error carrying model text",
      answer: Effect.fail(
        new TextGenerationError({
          operation: "generateTranscriptionPostProcessing",
          detail: hostile,
        }),
      ),
      cause: "The classifier could not answer.",
    },
    {
      name: "a timeout",
      answer: Effect.fail(
        new TextGenerationError({
          operation: "generateTranscriptionPostProcessing",
          detail: "Claude CLI request timed out.",
        }),
      ),
      cause: "The classifier did not answer in time.",
    },
  ])(
    "records a fixed cause for $name, calls no more until Retry, then calls again",
    ({ answer, cause }) =>
      harness(
        { listed: [], rows: [row("1"), row("9")] },
        ({ calls, refreshed, publish, stored, triage }) =>
          Effect.gen(function* () {
            yield* publish(result([entry("1")]));
            const call = yield* Queue.take(calls);
            yield* Deferred.complete(call.answer, answer);
            yield* Queue.take(refreshed);
            const failed = yield* stored("1");
            expect(failed).toMatchObject({ playbook: "triage", triage: null, startFailure: cause });
            expect(JSON.stringify(failed)).not.toContain(hostile);

            yield* publish(result([entry("1"), entry("9")]));
            yield* nextCall(calls, "9");

            expect(yield* triage.retry({ playbook: "triage", entry: entry("1") })).toBe(true);
            expect((yield* stored("1"))?.startFailure).toBeNull();
            yield* publish(result([entry("1")]));
            yield* nextCall(calls, "1");
          }),
      ),
  );

  it.effect(
    "refuses a model that keeps tools without calling it, and uses the triage playbook's own model",
    () =>
      harness(
        {
          listed: [],
          rows: [row("1"), row("2", { playbook: "sorted" })],
          model: codex,
          playbooks: [
            ...playbooks,
            {
              name: "sorted",
              rules: {},
              prompt: "Sort.",
              choices: ["fix"],
              modelSelection: claude,
            },
          ],
        },
        ({ calls, refreshed, publish, stored }) =>
          Effect.gen(function* () {
            yield* publish(result([entry("1"), entry("2", { waitingPlaybook: "sorted" })]));
            const call = yield* Queue.take(calls);
            expect(call.key).toBe("2");
            expect(call.modelSelection).toEqual(claude);
            yield* Queue.take(refreshed);
            expect((yield* stored("1"))?.startFailure).toBe(
              "Choosing a playbook needs a Claude model or a text generator API: set modelSelection on the triage playbook to a Claude model.",
            );
          }),
      ),
  );

  it.effect("records a fixed cause when the issue cannot be read, with no model call", () =>
    harness(
      { listed: [], rows: [row("1")], readFails: true },
      ({ calls, refreshed, publish, stored }) =>
        Effect.gen(function* () {
          yield* publish(result([entry("1")]));
          yield* Queue.take(refreshed);
          const failed = yield* stored("1");
          expect(failed?.startFailure).toBe(
            "The issue could not be read from GitHub, so no playbook was chosen.",
          );
          expect(JSON.stringify(failed)).not.toContain(hostile);
          expect(yield* Queue.size(calls)).toBe(0);
        }),
    ),
  );

  it.effect(
    "writes nothing for an answer that arrives after the issue left and came back, and keeps the new entry's call",
    () =>
      harness(
        { listed: [], rows: [row("1"), row("9")] },
        ({ calls, publish, entries, stored, refreshed }) =>
          Effect.gen(function* () {
            yield* publish(result([entry("1")]));
            const stale = yield* Queue.take(calls);
            // The issue left and came back during the call: a new entry, waiting since later.
            yield* entries.reconcile(() => [
              row("1", { waitingSince: "2026-11-11T11:00:00.000Z" }),
            ]);
            yield* publish(result([entry("1")]));
            const fresh = yield* nextCall(calls, "1");
            yield* Deferred.succeed(stale.answer, "fix");
            yield* Queue.take(refreshed);
            expect((yield* stored("1"))?.triage).toBeNull();
            // The earlier call left the new entry's call alone: no second call for it.
            yield* publish(result([entry("1"), entry("9")]));
            yield* nextCall(calls, "9");
            yield* Deferred.succeed(fresh.answer, "answer");
            yield* Queue.take(refreshed);
            expect(yield* stored("1")).toMatchObject({ playbook: "answer", triage: "triage" });
          }),
      ),
  );

  it.effect(
    "records a fixed cause for a call that dies with the model's text, and calls no more",
    () =>
      harness(
        { listed: [], rows: [row("1"), row("9")], callDies: true },
        ({ refreshed, publish, stored }) =>
          Effect.gen(function* () {
            yield* publish(result([entry("1")]));
            yield* Queue.take(refreshed);
            const failed = yield* stored("1");
            expect(failed?.startFailure).toBe("The classifier could not answer.");
            expect(JSON.stringify(failed)).not.toContain(hostile);
          }),
      ),
  );

  it.effect("writes nothing for an answer the triage playbook no longer offers", () =>
    harness(
      { listed: [], rows: [row("1")] },
      ({ calls, publish, stored, writePlaybooks, refreshed }) =>
        Effect.gen(function* () {
          yield* publish(result([entry("1")]));
          const call = yield* Queue.take(calls);
          yield* writePlaybooks([
            { name: "triage", rules: {}, prompt: "Sort it.", choices: ["answer"] },
            ...playbooks.slice(1),
          ]);
          yield* Deferred.succeed(call.answer, "fix");
          // Published, so the next pass classifies it again under the new file.
          yield* Queue.take(refreshed);
          yield* publish(result([entry("1"), entry("1")]));
          yield* Queue.take(calls);
          expect(yield* stored("1")).toMatchObject({ playbook: "triage", triage: null });
        }),
    ),
  );

  it.effect("classifies again an unstarted issue whose choice the triage playbook dropped", () =>
    harness(
      { listed: [], rows: [row("1", { playbook: "fix", triage: "triage" })] },
      ({ calls, publish, stored, writePlaybooks, refreshed }) =>
        Effect.gen(function* () {
          yield* writePlaybooks([
            { name: "triage", rules: {}, prompt: "Sort it.", choices: ["answer"] },
            ...playbooks.slice(1),
          ]);
          yield* publish(result([entry("1", { waitingPlaybook: "fix", triagedBy: "triage" })]));
          yield* Queue.take(refreshed);
          expect(yield* stored("1")).toMatchObject({ playbook: "triage", triage: null });
          yield* publish(result([entry("1")]));
          expect((yield* Queue.take(calls)).key).toBe("1");
        }),
    ),
  );

  it.effect("keeps a failure it could not save, writes it later without another call", () =>
    harness(
      { listed: [], rows: [row("1"), row("9")] },
      ({ calls, publish, stored, failWrites, refreshed, writes }) =>
        Effect.gen(function* () {
          yield* Ref.set(failWrites, true);
          yield* publish(result([entry("1")]));
          const call = yield* Queue.take(calls);
          yield* Deferred.succeed(call.answer, "deploy");
          yield* Queue.take(writes);
          expect((yield* stored("1"))?.startFailure).toBeNull();
          yield* Ref.set(failWrites, false);
          yield* publish(result([entry("1")]));
          yield* Queue.take(refreshed);
          expect((yield* stored("1"))?.startFailure).toBe(
            "The classifier's answer named no listed playbook.",
          );
          // Once recorded it is written no more, however often the boards are published.
          yield* publish(result([entry("1"), entry("9")]));
          const marker = yield* nextCall(calls, "9");
          yield* Queue.takeAll(writes);
          yield* Deferred.succeed(marker.answer, "fix");
          yield* Queue.take(refreshed);
          expect((yield* Queue.takeAll(writes)).length).toBe(1);
        }),
    ),
  );
});
