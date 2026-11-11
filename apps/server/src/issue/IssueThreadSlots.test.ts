import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as ServerSettings from "../serverSettings.ts";
import { holdsSlot, make, mayFreeSlot } from "./IssueThreadSlots.ts";

const now = Date.parse("2026-11-11T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.makeUnsafe(now + offsetMs);

const shell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: ThreadId.make("thread-1"),
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    pendingGuestMessageCount: 0,
    snoozedUntil: null,
    triage: null,
    snoozedAt: null,
    latestRunCompletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const request = (kind: "approval" | "user_input") =>
  ({
    kind,
    createdAt: at(-1_000),
  }) as unknown as OrchestrationV2ThreadShell["pendingRuntimeRequest"];

describe("holdsSlot", () => {
  it.each([
    { name: "a running turn", shell: shell(), holds: true },
    {
      name: "a turn whose worktree is being prepared",
      shell: shell({ status: "preparing", activityRunStatus: "preparing" }),
      holds: true,
    },
    { name: "a turn starting", shell: shell({ activityRunStatus: "starting" }), holds: true },
    {
      name: "a turn waiting for my approval",
      shell: shell({ activityRunStatus: "waiting", pendingRuntimeRequest: request("approval") }),
      holds: false,
    },
    {
      name: "a turn waiting for my answer",
      shell: shell({ activityRunStatus: "waiting", pendingRuntimeRequest: request("user_input") }),
      holds: false,
    },
    {
      name: "a snoozed thread with a turn running",
      shell: shell({ snoozedUntil: at(60_000), snoozedAt: at(-60_000) }),
      holds: false,
    },
    {
      name: "a thread whose snooze ended",
      shell: shell({ snoozedUntil: at(-1), snoozedAt: at(-60_000) }),
      holds: true,
    },
    {
      name: "an idle thread",
      shell: shell({ status: "idle", activityRunStatus: null }),
      holds: false,
    },
    {
      name: "a thread whose message a restart held in its queue",
      shell: shell({ status: "queued", activityRunStatus: null }),
      holds: false,
    },
  ])("$name: $holds", ({ shell: candidate, holds }) => {
    expect(holdsSlot(candidate, now)).toBe(holds);
  });
});

describe("mayFreeSlot", () => {
  const event = (type: string, payload: unknown = {}) =>
    ({
      id: EventId.make(`event-${type}`),
      threadId: ThreadId.make("thread-1"),
      occurredAt: at(0),
      type,
      payload,
    }) as OrchestrationV2DomainEvent;

  it.each([
    ...["completed", "interrupted", "failed", "cancelled", "rolled_back"].map((status) => ({
      event: event("run.updated", { status }),
      frees: true,
    })),
    ...["preparing", "queued", "starting", "running", "waiting"].map((status) => ({
      event: event("run.updated", { status }),
      frees: false,
    })),
    ...[
      "runtime-request.updated",
      "thread.snoozed",
      "thread.settled",
      "thread.archived",
      "thread.deleted",
      "thread.issue-synced",
      // A guest message dismissed or a link closed can let a snooze hold again.
      "thread.guest-share-updated",
    ].map((type) => ({ event: event(type), frees: true })),
    // A secret or link request card is a pending request the shell shows.
    ...["secret_request", "link_request"].map((type) => ({
      event: event("turn-item.updated", { type, status: "waiting" }),
      frees: true,
    })),
    ...[
      { type: "secret_request", status: "completed" },
      { type: "command_execution", status: "running" },
    ].map((payload) => ({ event: event("turn-item.updated", payload), frees: false })),
    ...["message.updated", "thread.unsnoozed"].map((type) => ({
      event: event(type),
      frees: false,
    })),
  ])(
    "$event.type $event.payload.type $event.payload.status: $frees",
    ({ event: candidate, frees }) => {
      expect(mayFreeSlot(candidate)).toBe(frees);
    },
  );
});

describe("IssueThreadSlots", () => {
  const boardIssue = "github github.com acme/web 6";
  /** Runs `body` with these open threads, each running per call of the shell read. */
  const slots = <A, E>(
    input: {
      readonly links: ReadonlyArray<{ readonly threadId: string; readonly issueKey: string }>;
      /** For each shell read, in turn, the threads that run then; the last repeats. */
      readonly running: ReadonlyArray<ReadonlyArray<string>>;
      readonly limit?: number;
      /** Runs inside each shell read, given its index. */
      readonly onRead?: (call: number) => Effect.Effect<void>;
    },
    body: (
      service: Effect.Success<typeof make>,
      asked: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const service = yield* make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getShellSnapshot: (options) =>
                Ref.get(asked).pipe(
                  Effect.tap((calls) => input.onRead?.(calls.length) ?? Effect.void),
                  Effect.andThen(
                    Ref.modify(asked, (calls) => {
                      const ids = options?.threadIds ?? [];
                      const running =
                        input.running[Math.min(calls.length, input.running.length - 1)]!;
                      return [
                        {
                          schemaVersion: 1,
                          snapshotSequence: 0,
                          threads: ids.map((id) =>
                            shell({
                              id,
                              activityRunStatus: running.includes(id) ? "running" : null,
                            }),
                          ),
                          archivedThreads: [],
                        },
                        [...calls, ids],
                      ];
                    }),
                  ),
                ),
            }),
            Layer.mock(IssueThreadLinks.IssueThreadLinksRepository)({
              openLinks: Effect.succeed(
                input.links.map((link) => ({ ...link, threadId: ThreadId.make(link.threadId) })),
              ),
            }),
            Layer.mock(IssuePlaybookEntries.IssuePlaybookEntriesRepository)({
              list: Effect.succeed(
                new Map([
                  [
                    boardIssue,
                    {
                      issueKey: boardIssue,
                      board: "acme/1",
                      playbook: "develop",
                      startedBy: "issue-playbook:1",
                      autoTried: false,
                      startFailure: null,
                      leftAt: null,
                      startQueued: false,
                      waitingSince: null,
                      snoozedUntil: null,
                      triage: null,
                    },
                  ],
                ]),
              ),
            }),
            ServerSettings.ServerSettingsService.layerTest(
              input.limit === undefined ? {} : { maxRunningIssueThreads: input.limit },
            ),
          ),
        ),
      );
      return yield* body(service, asked);
    });

  it.effect(
    "counts each open thread of a board issue that runs, two of one issue included, and no other",
    () =>
      slots(
        {
          links: [
            { threadId: "a", issueKey: boardIssue },
            { threadId: "b", issueKey: boardIssue },
            // Linked only to an issue no board lists.
            { threadId: "c", issueKey: "linear linear.app acme ENG-1" },
          ],
          running: [["a", "b", "c"]],
        },
        (service, asked) =>
          Effect.gen(function* () {
            expect(yield* service.inUse).toBe(2);
            expect(yield* Ref.get(asked)).toEqual([["a", "b"]]);
          }),
      ),
  );

  it.effect("counts again once a start waits, so a slot freed just before is free", () =>
    slots(
      {
        links: [
          { threadId: "a", issueKey: boardIssue },
          { threadId: "b", issueKey: boardIssue },
        ],
        // Both run at the first count; one turn ends before the second.
        running: [["a", "b"], ["a"]],
      },
      (service, asked) =>
        Effect.gen(function* () {
          expect(yield* service.whenFree(Effect.succeed)).toBe(true);
          expect(yield* Ref.get(asked)).toHaveLength(2);
        }),
    ),
  );

  it.effect(
    "keeps a start's slot until it ends, and its end wakes a start that waits for one",
    () =>
      slots({ links: [], running: [[]], limit: 1 }, (service) =>
        Effect.gen(function* () {
          const inside = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          const first = yield* Effect.forkChild(
            service.whenFree((free) =>
              Deferred.succeed(inside, undefined).pipe(
                Effect.andThen(Deferred.await(done)),
                Effect.as(free),
              ),
            ),
          );
          yield* Deferred.await(inside);
          expect(yield* service.whenFree(Effect.succeed)).toBe(false);
          yield* Deferred.succeed(done, undefined);
          expect(yield* Fiber.join(first)).toBe(true);
          yield* service.awaitFreed;
          expect(yield* service.whenFree(Effect.succeed)).toBe(true);
        }),
      ),
  );

  it.effect("wakes a start that counted a reservation released while it counted", () =>
    Effect.gen(function* () {
      const inside = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const paused = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      return yield* slots(
        {
          links: [{ threadId: "a", issueKey: boardIssue }],
          running: [[]],
          limit: 1,
          // The second start's first count holds until the first start has ended.
          onRead: (call) =>
            call === 1
              ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
        },
        (service) =>
          Effect.gen(function* () {
            const first = yield* Effect.forkChild(
              service.whenFree(() =>
                Deferred.succeed(inside, undefined).pipe(Effect.andThen(Deferred.await(done))),
              ),
            );
            yield* Deferred.await(inside);
            const second = yield* Effect.forkChild(service.whenFree(Effect.succeed));
            yield* Deferred.await(paused);
            yield* Deferred.succeed(done, undefined);
            yield* Deferred.succeed(resume, undefined);

            expect(yield* Fiber.join(second)).toBe(false);
            yield* Fiber.join(first);
            expect(yield* service.pendingWakes).toBe(1);
          }),
      );
    }),
  );

  it.effect("wakes the starter only while a start waits, once per wait", () =>
    slots(
      { links: [{ threadId: "a", issueKey: boardIssue }], running: [["a"]], limit: 1 },
      (service) =>
        Effect.gen(function* () {
          const ended = {
            id: EventId.make("event-ended"),
            threadId: ThreadId.make("a"),
            occurredAt: at(0),
            type: "run.updated",
            payload: { status: "completed" },
          } as OrchestrationV2DomainEvent;
          yield* service.observe(ended);
          expect(yield* service.pendingWakes).toBe(0);

          expect(yield* service.whenFree(Effect.succeed)).toBe(false);
          yield* service.observe(ended);
          yield* service.observe(ended);
          expect(yield* service.pendingWakes).toBe(1);

          // Taking the wake clears the wait; the next start that finds no slot sets it again.
          yield* service.awaitFreed;
          yield* service.observe(ended);
          expect(yield* service.pendingWakes).toBe(0);
          expect(yield* service.whenFree(Effect.succeed)).toBe(false);
          yield* service.observe(ended);
          expect(yield* service.pendingWakes).toBe(1);
        }),
    ),
  );
});
