// Fork-only: at most a set number of issue threads run at once (jehhynes/t3code#76).
import type { OrchestrationV2DomainEvent, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as ServerSettings from "../serverSettings.ts";

export class IssueThreadSlotsError extends Schema.TaggedError<IssueThreadSlotsError>()(
  "IssueThreadSlotsError",
  { cause: Schema.Defect() },
) {}

/**
 * Whether an open thread linked to a board issue holds a slot: a turn runs or is being prepared,
 * and it waits neither for my approval or answer nor out a snooze.
 */
export function holdsSlot(
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "activityRunStatus"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
  >,
  nowMs: number,
): boolean {
  return (
    (shell.activityRunStatus ?? null) !== null &&
    shell.pendingRuntimeRequest === null &&
    !isSnoozed(shell, nowMs)
  );
}

const ENDED_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/** Whether a committed event can leave a thread holding no slot. */
export function mayFreeSlot(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "run.updated":
      return ENDED_RUN.has(event.payload.status);
    // A waiting secret or link request card is a pending request, as an approval is.
    case "turn-item.updated":
      return (
        (event.payload.type === "secret_request" || event.payload.type === "link_request") &&
        event.payload.status === "waiting"
      );
    case "runtime-request.updated":
    case "thread.snoozed":
    case "thread.settled":
    case "thread.archived":
    case "thread.deleted":
    case "thread.issue-synced":
    case "thread.guest-share-updated":
      return true;
    default:
      return false;
  }
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const links = yield* IssueThreadLinks.IssueThreadLinksRepository;
  const entries = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
  const settings = yield* ServerSettings.ServerSettingsService;
  // Orders each count with its reservation, so two starters cannot both take the last slot.
  const lock = yield* Semaphore.make(1);
  // Starts holding a slot until their thread is linked and stored, or they end without one.
  const inFlight = yield* Ref.make(0);
  // Set while a start waits for a slot, so events wake the starter only then.
  const waiting = yield* Ref.make(false);
  const freed = yield* Queue.sliding<void>(1);

  const inUse = Effect.gen(function* () {
    const [open, rows] = yield* Effect.all([links.openLinks, entries.list]);
    const threadIds = [
      ...new Set(open.filter((link) => rows.has(link.issueKey)).map((link) => link.threadId)),
    ];
    if (threadIds.length === 0) return 0;
    const snapshot = yield* threads.getShellSnapshot({ threadIds, location: "active" });
    const nowMs = yield* Clock.currentTimeMillis;
    return snapshot.threads.filter((shell) => holdsSlot(shell, nowMs)).length;
  }).pipe(Effect.mapError((cause) => new IssueThreadSlotsError({ cause })));

  const limit = settings.getSettings.pipe(
    Effect.map((current) => current.maxRunningIssueThreads),
    Effect.mapError((cause) => new IssueThreadSlotsError({ cause })),
  );

  const reserve = lock.withPermits(1)(
    Effect.gen(function* () {
      const max = yield* limit;
      let free = (yield* inUse) + (yield* Ref.get(inFlight)) < max;
      if (!free) {
        // Counted again once set, so a slot freed before an event could wake the starter is seen.
        yield* Ref.set(waiting, true);
        free = (yield* inUse) + (yield* Ref.get(inFlight)) < max;
      }
      if (free) yield* Ref.update(inFlight, (count) => count + 1);
      return free;
    }),
  );
  // A start that ends without a thread frees its slot with no event, so it wakes the starter too.
  // Under the lock, so a count cannot read the reservation and miss this wake.
  const release = lock.withPermits(1)(
    Ref.update(inFlight, (count) => count - 1).pipe(
      Effect.andThen(Ref.get(waiting)),
      Effect.flatMap((flagged) => (flagged ? Queue.offer(freed, undefined) : Effect.void)),
    ),
  );

  /** Runs `use` told whether a slot is free; a free one stays taken until `use` ends. */
  const whenFree = Effect.fn("IssueThreadSlots.whenFree")(function* <A, E, R>(
    use: (free: boolean) => Effect.Effect<A, E, R>,
  ) {
    return yield* Effect.acquireUseRelease(reserve, use, (free) => (free ? release : Effect.void));
  });

  // Untraced: it sees every domain event.
  const observe = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (!mayFreeSlot(event) || !(yield* Ref.get(waiting))) return;
    yield* Queue.offer(freed, undefined);
  });

  /** Waits for an event that may have freed a slot while a start waited; the next pass recounts. */
  const awaitFreed = Queue.take(freed).pipe(Effect.andThen(Ref.set(waiting, false)));

  return {
    whenFree,
    observe,
    awaitFreed,
    inUse,
    /** How many wakes wait to be taken: at most one. */
    pendingWakes: Queue.size(freed),
  };
});
