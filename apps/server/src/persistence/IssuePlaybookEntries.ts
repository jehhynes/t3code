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
});
export type PlaybookEntryRow = typeof PlaybookEntryRow.Type;

type Rows = ReadonlyMap<string, PlaybookEntryRow>;

export const OPEN_THREAD = "open-thread";

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
    }) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    /**
     * Queues or takes back a Start of the issue's entry while it waits with this playbook; answers
     * whether it did. Keeps the entry's try and its last failure.
     */
    readonly setQueued: (input: {
      readonly issueKey: string;
      readonly playbook: string;
      readonly queued: boolean;
    }) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    /**
     * Makes the entry wait again while this claim still holds it, with why its start failed; a
     * start with no cause, as an interrupted one, keeps the cause before it.
     */
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
        left_at AS "leftAt", start_queued AS "startQueued"
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
              start_queued
            )
            VALUES (
              ${row.issueKey}, ${row.board}, ${row.playbook}, ${row.startedBy},
              ${row.autoTried ? 1 : 0}, ${row.startFailure}, ${row.leftAt},
              ${row.startQueued ? 1 : 0}
            )
            ON CONFLICT (issue_key) DO UPDATE SET
              board = excluded.board,
              playbook = excluded.playbook,
              started_by = excluded.started_by,
              auto_tried = excluded.auto_tried,
              start_failure = excluded.start_failure,
              left_at = excluded.left_at,
              start_queued = excluded.start_queued
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
        }>`
          SELECT playbook AS "playbook", started_by AS "startedBy", auto_tried AS "autoTried",
            start_queued AS "startQueued"
          FROM issue_playbook_entries WHERE issue_key = ${input.issueKey}
        `;
        // Names compare as selection compares them, which SQLite's ASCII-only lower() does not.
        if (
          row === undefined ||
          row.startedBy !== null ||
          row.playbook?.toLowerCase() !== input.playbook.toLowerCase() ||
          (input.auto === true &&
            row.startQueued === 0 &&
            (input.selfStarting !== true || row.autoTried !== 0))
        ) {
          return false;
        }
        yield* sql`
          UPDATE issue_playbook_entries
          SET started_by = ${input.startedBy}, auto_tried = ${input.auto === true ? 1 : row.autoTried},
            start_queued = 0
          WHERE issue_key = ${input.issueKey}
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("claimIssuePlaybookEntry")),
    ),
    setQueued: Effect.fn("IssuePlaybookEntriesRepository.setQueued")(
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
          UPDATE issue_playbook_entries SET start_queued = ${input.queued ? 1 : 0}
          WHERE issue_key = ${input.issueKey}
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("queueIssuePlaybookEntry")),
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
