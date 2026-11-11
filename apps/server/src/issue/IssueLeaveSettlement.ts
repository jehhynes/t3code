// Fork-only: a thread settles when its issue leaves every playbook's selection
// (jehhynes/t3code#57). The automatic settlement reads this; it settles nothing itself.
import type { IssueBoardResult, ThreadId, ThreadIssueLink } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { boardSourceKey } from "../persistence/IssueBoardSources.ts";
import { issueThreadKey } from "../persistence/IssueThreadLinks.ts";
import * as IssueService from "./IssueService.ts";

export interface LeaveEntry {
  readonly board: string;
  readonly playbook: string | null;
  readonly leftAt: string | null;
}

export interface LeaveCandidate {
  readonly id: ThreadId;
  readonly issues?: ReadonlyArray<ThreadIssueLink> | undefined;
  readonly unsettledAt?: DateTime.Utc | null | undefined;
}

const millis = (value: string | null) => {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * The candidates whose issue left, on a board that decided in the latest read, after it was
 * linked and after the thread was last un-settled, while none of their issues is in a selection.
 */
export function issueLeftThreads(input: {
  readonly candidates: ReadonlyArray<LeaveCandidate>;
  readonly entries: ReadonlyMap<string, LeaveEntry>;
  readonly deciding: ReadonlySet<string>;
}): ReadonlySet<ThreadId> {
  const settle = new Set<ThreadId>();
  for (const thread of input.candidates) {
    const links = (thread.issues ?? []).map((link) => ({
      link,
      entry: input.entries.get(issueThreadKey(link)),
    }));
    if (links.some(({ entry }) => entry !== undefined && entry.playbook !== null)) continue;
    let leftAt: number | null = null;
    for (const { link, entry } of links) {
      if (entry === undefined || !input.deciding.has(entry.board)) continue;
      const left = millis(entry.leftAt);
      const linked = millis(link.linkedAt);
      if (left === null || linked === null || left <= linked) continue;
      if (leftAt === null || left > leftAt) leftAt = left;
    }
    if (leftAt === null) continue;
    const unsettledAt =
      thread.unsettledAt == null ? null : DateTime.toEpochMillis(thread.unsettledAt);
    if (unsettledAt !== null && leftAt <= unsettledAt) continue;
    settle.add(thread.id);
  }
  return settle;
}

/** The boards whose entries the latest read decided: none while `playbooks.json` has a mistake. */
export const decidingBoards = (result: IssueBoardResult): ReadonlySet<string> =>
  result.playbookErrors.length > 0
    ? new Set()
    : new Set(
        result.boards.filter((board) => board.enabled && board.error === null).map(boardSourceKey),
      );

/**
 * Whether a read may let a thread settle: a leave newer than any seen, or, with any leave
 * recorded, a board that decides now and did not before (recovered, turned on, or first read).
 */
export function readWakes(input: {
  readonly previous: ReadonlySet<string>;
  readonly next: ReadonlySet<string>;
  readonly seenLeftAt: string | null;
  readonly leftAt: string | null;
}): boolean {
  if (input.leftAt === null) return false;
  // `left_at` is always written by `DateTime.formatIso`, so ISO strings order as times.
  if (input.seenLeftAt === null || input.leftAt > input.seenLeftAt) return true;
  return [...input.next].some((board) => !input.previous.has(board));
}

export class IssueLeaveSettlement extends Context.Service<
  IssueLeaveSettlement,
  {
    /** Which of these candidates settle because their issue left; none when that cannot be read. */
    readonly threads: (
      candidates: ReadonlyArray<LeaveCandidate>,
    ) => Effect.Effect<ReadonlySet<ThreadId>>;
    /** Receives one item after each board read that `readWakes`. */
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/issue/IssueLeaveSettlement") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issues = yield* IssueService.IssueService;
  // Empty until the first read after a start, so nothing settles before a board can decide.
  const deciding = yield* Ref.make<ReadonlySet<string>>(new Set());
  const latestLeftAt = yield* Ref.make<string | null>(null);
  const changes = yield* PubSub.unbounded<void>();

  const observe = Effect.fn("IssueLeaveSettlement.observe")(function* (result: IssueBoardResult) {
    const next = decidingBoards(result);
    const previous = yield* Ref.getAndSet(deciding, next);
    const [row] = yield* sql<{ readonly leftAt: string | null }>`
      SELECT MAX(left_at) AS "leftAt" FROM issue_playbook_entries
    `;
    const leftAt = row?.leftAt ?? null;
    const seenLeftAt = yield* Ref.getAndSet(latestLeftAt, leftAt);
    if (readWakes({ previous, next, seenLeftAt, leftAt })) {
      yield* PubSub.publish(changes, undefined);
    }
  });

  yield* issues.boardChanges.pipe(
    Stream.runForEach((result) => observe(result).pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkScoped,
  );

  const threads = Effect.fn("IssueLeaveSettlement.threads")(
    function* (candidates: ReadonlyArray<LeaveCandidate>) {
      const current = yield* Ref.get(deciding);
      const keys = [
        ...new Set(candidates.flatMap((thread) => (thread.issues ?? []).map(issueThreadKey))),
      ];
      if (current.size === 0 || keys.length === 0) return new Set<ThreadId>();
      const rows = yield* sql<{
        readonly issueKey: string;
        readonly board: string;
        readonly playbook: string | null;
        readonly leftAt: string | null;
      }>`
        SELECT issue_key AS "issueKey", board, playbook, left_at AS "leftAt"
        FROM issue_playbook_entries WHERE issue_key IN ${sql.in(keys)}
      `;
      return issueLeftThreads({
        candidates,
        entries: new Map(rows.map((row) => [row.issueKey, row])),
        deciding: current,
      });
    },
    Effect.catch((error) =>
      Effect.logWarning("reading which issues left failed", { error }).pipe(
        Effect.as(new Set<ThreadId>()),
      ),
    ),
  );

  return IssueLeaveSettlement.of({
    threads,
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(IssueLeaveSettlement, make);
