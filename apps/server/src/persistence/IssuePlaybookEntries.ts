// Fork-only: each board issue's playbook entry, and whether it was started (jehhynes/t3code#7).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type IssuePlaybookEntriesRepositoryError = PersistenceSqlError | PersistenceDecodeError;

const PlaybookEntryRow = Schema.Struct({
  /** The issue's `issueThreadKey`. */
  issueKey: Schema.String,
  /** The `boardSourceKey` of the board whose read last decided the row. */
  board: Schema.String,
  /** The playbook whose selection the issue is in; null once it left every selection. */
  playbook: Schema.NullOr(Schema.String),
  /**
   * The command id of the Start that started the entry, or `OPEN_THREAD` when the issue was
   * first seen with an open thread; null while it waits for Start.
   */
  startedBy: Schema.NullOr(Schema.String),
  /** Whether the server tried to start this entry by itself; a try is never repeated. */
  autoTried: Schema.BooleanFromBit,
  /**
   * Why the entry's last start failed, or null; it counts only while the entry waits, because the
   * entry waits again only through another failed start or a new entry, which replace it.
   */
  startFailure: Schema.NullOr(Schema.String),
  /**
   * When the issue last left every selection, as an ISO time, or null; kept through later
   * entries, so its threads settle once for each leave (jehhynes/t3code#57).
   */
  leftAt: Schema.NullOr(Schema.String),
  /**
   * Whether Start was pressed while the issue had an open blocker, so the server starts the entry
   * by itself once none is left; a new entry clears it (jehhynes/t3code#65).
   */
  startQueued: Schema.BooleanFromBit,
  /**
   * When the entry began to wait, as an ISO time: when it began, or when Start last queued it;
   * null on rows from before jehhynes/t3code#76. Starts that wait for a free slot go oldest first.
   */
  waitingSince: Schema.NullOr(Schema.String),
  /**
   * Until when the waiting entry is snoozed, as a UTC ISO time, or null; nothing starts it before
   * then, and a new entry clears it (jehhynes/t3code#86).
   */
  snoozedUntil: Schema.NullOr(Schema.String),
  /**
   * The triage playbook whose classifier chose `playbook`, or null; a new entry clears it
   * (jehhynes/t3code#93). Until the choice, `playbook` is the triage playbook itself.
   */
  triage: Schema.NullOr(Schema.String),
  /**
   * When the first turn of the issue's earlier thread started, as a UTC ISO time, when the
   * classifier found no comment by anyone else newer: the entry then waits for Start, its try
   * used. Null otherwise; a new entry clears it (jehhynes/t3code#100).
   */
  nothingNewSince: Schema.NullOr(Schema.String),
});
export type PlaybookEntryRow = typeof PlaybookEntryRow.Type;

type Rows = ReadonlyMap<string, PlaybookEntryRow>;

export const OPEN_THREAD = "open-thread";

/** Whether a snooze, as stored, lasts past `now`; both are UTC ISO times, which order as strings. */
export const snoozedPast = (snoozedUntil: string | null, now: string | undefined): boolean =>
  now !== undefined && snoozedUntil !== null && snoozedUntil > now;

export class IssuePlaybookEntriesRepository extends Context.Service<
  IssuePlaybookEntriesRepository,
  {
    readonly list: Effect.Effect<Rows, IssuePlaybookEntriesRepositoryError>;
    /** Writes the rows `compute` answers for the current ones, atomically; answers the result. */
    readonly reconcile: (
      compute: (rows: Rows) => ReadonlyArray<PlaybookEntryRow>,
    ) => Effect.Effect<Rows, IssuePlaybookEntriesRepositoryError>;
    /** Marks the issue's entry started if it waits with this playbook; answers whether it did. */
    readonly claim: (input: {
      readonly issueKey: string;
      readonly playbook: string;
      /** Unique to this Start. */
      readonly startedBy: string;
      /**
       * A start by the server itself, which claims only a queued entry, or one it has not tried
       * whose playbook starts by itself.
       */
      readonly auto?: boolean;
      /** Whether the playbook starts by itself. */
      readonly selfStarting?: boolean;
      /** A UTC ISO time; refuses an entry snoozed past it. A draft's send passes none. */
      readonly now?: string;
      /**
       * A draft's send: also claims the entry when `playbook` is the triage playbook that chose
       * its playbook since the draft opened (jehhynes/t3code#93).
       */
      readonly orTriage?: boolean;
      /**
       * The id of the prompt message this start sends; the claim records it with the playbook,
       * so the thread it starts is that playbook's (jehhynes/t3code#102).
       */
      readonly messageId: string;
      /** The playbook whose prompt it sends, when not the entry's own, as a draft's. */
      readonly startedWith?: string;
    }) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    /**
     * Queues or takes back a Start of the issue's entry while it waits with this playbook; answers
     * whether it did. Keeps the entry's try and its last failure. An entry that becomes queued
     * waits from `now`; one already queued keeps its place.
     */
    readonly setQueued: (input: {
      readonly issueKey: string;
      readonly playbook: string;
      readonly queued: boolean;
      /** A UTC ISO time; queueing refuses an entry snoozed past it. */
      readonly now: string;
    }) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    /**
     * Snoozes the issue's entry until `until`, or wakes it with null, while it waits with this
     * playbook; answers whether it did. Keeps everything else on the entry.
     */
    readonly setSnoozed: (input: {
      readonly issueKey: string;
      readonly playbook: string;
      /** A UTC ISO time. */
      readonly until: string | null;
    }) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    /**
     * Makes the entry wait again while this claim still holds it, with why its start failed; a
     * start with no cause, as an interrupted one, keeps the cause before it.
     */
    /**
     * Records the classifier's outcome for the issue's entry while it still waits unclassified in
     * `triage` since `waitingSince`: the chosen playbook, or why it failed, or no failure (Retry).
     * Answers whether it wrote. A choice with `nothingNewSince` waits for Start, its try used.
     */
    readonly setTriage: (
      input: {
        readonly issueKey: string;
        readonly triage: string;
        readonly waitingSince: string | null;
      } & (
        | { readonly chosen: string; readonly nothingNewSince?: string | null }
        | { readonly failure: string | null }
      ),
    ) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    /**
     * Puts the issue's unstarted entry that `triage` chose `playbook` for back to waiting
     * unclassified in `triage`; answers whether it did (jehhynes/t3code#93).
     */
    readonly resetTriage: (input: {
      readonly issueKey: string;
      readonly triage: string;
      readonly playbook: string;
      readonly waitingSince: string | null;
    }) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    readonly release: (input: {
      readonly issueKey: string;
      readonly startedBy: string;
      readonly failure: string | null;
    }) => Effect.Effect<void, IssuePlaybookEntriesRepositoryError>;
  }
>()("t3/persistence/IssuePlaybookEntries/IssuePlaybookEntriesRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlError = (operation: string) => (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError("IssuePlaybookEntry", cause)
      : new PersistenceSqlError({ operation, cause });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PlaybookEntryRow,
    execute: () => sql`
      SELECT issue_key AS "issueKey", board AS "board", playbook AS "playbook",
        started_by AS "startedBy", auto_tried AS "autoTried", start_failure AS "startFailure",
        left_at AS "leftAt", start_queued AS "startQueued", waiting_since AS "waitingSince",
        snoozed_until AS "snoozedUntil", triage AS "triage",
        nothing_new_since AS "nothingNewSince"
      FROM issue_playbook_entries
    `,
  });
  const readRows = listRows(undefined).pipe(
    Effect.map((rows): Rows => new Map(rows.map((row) => [row.issueKey, row]))),
  );

  return IssuePlaybookEntriesRepository.of({
    list: readRows.pipe(Effect.mapError(sqlError("listIssuePlaybookEntries"))),
    reconcile: Effect.fn("IssuePlaybookEntriesRepository.reconcile")(
      function* (compute) {
        const rows = yield* readRows;
        const writes = compute(rows);
        if (writes.length === 0) return rows;
        const next = new Map(rows);
        for (const row of writes) {
          yield* sql`
            INSERT INTO issue_playbook_entries (
              issue_key, board, playbook, started_by, auto_tried, start_failure, left_at,
              start_queued, waiting_since, snoozed_until, triage, nothing_new_since
            )
            VALUES (
              ${row.issueKey}, ${row.board}, ${row.playbook}, ${row.startedBy},
              ${row.autoTried ? 1 : 0}, ${row.startFailure}, ${row.leftAt},
              ${row.startQueued ? 1 : 0}, ${row.waitingSince}, ${row.snoozedUntil}, ${row.triage},
              ${row.nothingNewSince}
            )
            ON CONFLICT (issue_key) DO UPDATE SET
              board = excluded.board,
              playbook = excluded.playbook,
              started_by = excluded.started_by,
              auto_tried = excluded.auto_tried,
              start_failure = excluded.start_failure,
              left_at = excluded.left_at,
              start_queued = excluded.start_queued,
              waiting_since = excluded.waiting_since,
              snoozed_until = excluded.snoozed_until,
              triage = excluded.triage,
              nothing_new_since = excluded.nothing_new_since
          `;
          next.set(row.issueKey, row);
        }
        return next;
      },
      // One transaction, so a Start's claim cannot fall between the read and the writes.
      sql.withTransaction,
      Effect.mapError(sqlError("reconcileIssuePlaybookEntries")),
    ),
    claim: Effect.fn("IssuePlaybookEntriesRepository.claim")(
      function* (input) {
        const [row] = yield* sql<{
          playbook: string | null;
          startedBy: string | null;
          autoTried: number;
          startQueued: number;
          snoozedUntil: string | null;
          triage: string | null;
        }>`
          SELECT playbook AS "playbook", started_by AS "startedBy", auto_tried AS "autoTried",
            start_queued AS "startQueued", snoozed_until AS "snoozedUntil", triage AS "triage"
          FROM issue_playbook_entries WHERE issue_key = ${input.issueKey}
        `;
        // Names compare as selection compares them, which SQLite's ASCII-only lower() does not.
        if (
          row === undefined ||
          row.startedBy !== null ||
          (row.playbook?.toLowerCase() !== input.playbook.toLowerCase() &&
            (input.orTriage !== true ||
              row.triage?.toLowerCase() !== input.playbook.toLowerCase())) ||
          snoozedPast(row.snoozedUntil, input.now) ||
          (input.auto === true &&
            row.startQueued === 0 &&
            (input.selfStarting !== true || row.autoTried !== 0))
        ) {
          return false;
        }
        yield* sql`
          UPDATE issue_playbook_entries
          SET started_by = ${input.startedBy}, auto_tried = ${input.auto === true ? 1 : row.autoTried},
            start_queued = 0, snoozed_until = NULL
          WHERE issue_key = ${input.issueKey}
        `;
        yield* sql`
          INSERT INTO issue_playbook_starts (message_id, issue_key, playbook)
          VALUES (${input.messageId}, ${input.issueKey}, ${input.startedWith ?? row.playbook ?? input.playbook})
          ON CONFLICT (message_id) DO NOTHING
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("claimIssuePlaybookEntry")),
    ),
    setQueued: Effect.fn("IssuePlaybookEntriesRepository.setQueued")(
      function* (input) {
        const [row] = yield* sql<{
          playbook: string | null;
          startedBy: string | null;
          snoozedUntil: string | null;
        }>`
          SELECT playbook AS "playbook", started_by AS "startedBy",
            snoozed_until AS "snoozedUntil"
          FROM issue_playbook_entries WHERE issue_key = ${input.issueKey}
        `;
        if (
          row === undefined ||
          row.startedBy !== null ||
          row.playbook?.toLowerCase() !== input.playbook.toLowerCase() ||
          // Cancel start still takes a snoozed issue's queued start back.
          (input.queued && snoozedPast(row.snoozedUntil, input.now))
        ) {
          return false;
        }
        yield* sql`
          UPDATE issue_playbook_entries
          SET start_queued = ${input.queued ? 1 : 0},
            waiting_since = CASE WHEN ${input.queued ? 1 : 0} = 1 AND start_queued = 0
              THEN ${input.now} ELSE waiting_since END
          WHERE issue_key = ${input.issueKey}
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("queueIssuePlaybookEntry")),
    ),
    setSnoozed: Effect.fn("IssuePlaybookEntriesRepository.setSnoozed")(
      function* (input) {
        const [row] = yield* sql<{ playbook: string | null; startedBy: string | null }>`
          SELECT playbook AS "playbook", started_by AS "startedBy"
          FROM issue_playbook_entries WHERE issue_key = ${input.issueKey}
        `;
        if (
          row === undefined ||
          row.startedBy !== null ||
          row.playbook?.toLowerCase() !== input.playbook.toLowerCase()
        ) {
          return false;
        }
        yield* sql`
          UPDATE issue_playbook_entries SET snoozed_until = ${input.until}
          WHERE issue_key = ${input.issueKey}
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("snoozeIssuePlaybookEntry")),
    ),
    setTriage: Effect.fn("IssuePlaybookEntriesRepository.setTriage")(
      function* (input) {
        const [row] = yield* sql<{
          playbook: string | null;
          startedBy: string | null;
          waitingSince: string | null;
          triage: string | null;
        }>`
          SELECT playbook AS "playbook", started_by AS "startedBy",
            waiting_since AS "waitingSince", triage AS "triage"
          FROM issue_playbook_entries WHERE issue_key = ${input.issueKey}
        `;
        if (
          row === undefined ||
          row.startedBy !== null ||
          row.triage !== null ||
          row.playbook?.toLowerCase() !== input.triage.toLowerCase() ||
          row.waitingSince !== input.waitingSince
        ) {
          return false;
        }
        if ("chosen" in input) {
          yield* sql`
            UPDATE issue_playbook_entries
            SET playbook = ${input.chosen}, triage = ${row.playbook}, start_failure = NULL,
              nothing_new_since = ${input.nothingNewSince ?? null},
              auto_tried = CASE WHEN ${input.nothingNewSince ?? null} IS NULL
                THEN auto_tried ELSE 1 END
            WHERE issue_key = ${input.issueKey}
          `;
        } else {
          yield* sql`
            UPDATE issue_playbook_entries SET start_failure = ${input.failure}
            WHERE issue_key = ${input.issueKey}
          `;
        }
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("triageIssuePlaybookEntry")),
    ),
    resetTriage: Effect.fn("IssuePlaybookEntriesRepository.resetTriage")(
      function* (input) {
        const [row] = yield* sql<{
          playbook: string | null;
          startedBy: string | null;
          waitingSince: string | null;
          triage: string | null;
        }>`
          SELECT playbook AS "playbook", started_by AS "startedBy",
            waiting_since AS "waitingSince", triage AS "triage"
          FROM issue_playbook_entries WHERE issue_key = ${input.issueKey}
        `;
        if (
          row === undefined ||
          row.startedBy !== null ||
          row.triage?.toLowerCase() !== input.triage.toLowerCase() ||
          row.playbook?.toLowerCase() !== input.playbook.toLowerCase() ||
          row.waitingSince !== input.waitingSince
        ) {
          return false;
        }
        yield* sql`
          UPDATE issue_playbook_entries
          SET playbook = ${row.triage}, triage = NULL, start_failure = NULL, start_queued = 0,
            auto_tried = 0, nothing_new_since = NULL
          WHERE issue_key = ${input.issueKey}
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("resetIssuePlaybookEntryTriage")),
    ),
    release: Effect.fn("IssuePlaybookEntriesRepository.release")(
      function* (input) {
        yield* sql`
          UPDATE issue_playbook_entries
          SET started_by = NULL, start_failure = COALESCE(${input.failure}, start_failure)
          WHERE issue_key = ${input.issueKey} AND started_by = ${input.startedBy}
        `;
      },
      Effect.mapError(sqlError("releaseIssuePlaybookEntry")),
    ),
  });
});

export const layer = Layer.effect(IssuePlaybookEntriesRepository, make);
