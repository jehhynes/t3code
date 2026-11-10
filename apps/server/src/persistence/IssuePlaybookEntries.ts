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
    }) => Effect.Effect<boolean, IssuePlaybookEntriesRepositoryError>;
    /** Makes the entry wait again while this claim still holds it. */
    readonly release: (input: {
      readonly issueKey: string;
      readonly startedBy: string;
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
        started_by AS "startedBy"
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
            INSERT INTO issue_playbook_entries (issue_key, board, playbook, started_by)
            VALUES (${row.issueKey}, ${row.board}, ${row.playbook}, ${row.startedBy})
            ON CONFLICT (issue_key) DO UPDATE SET
              board = excluded.board,
              playbook = excluded.playbook,
              started_by = excluded.started_by
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
        const [row] = yield* sql<{ playbook: string | null; startedBy: string | null }>`
          SELECT playbook AS "playbook", started_by AS "startedBy"
          FROM issue_playbook_entries WHERE issue_key = ${input.issueKey}
        `;
        // Names compare as selection compares them, which SQLite's ASCII-only lower() does not.
        if (
          row === undefined ||
          row.startedBy !== null ||
          row.playbook?.toLowerCase() !== input.playbook.toLowerCase()
        ) {
          return false;
        }
        yield* sql`
          UPDATE issue_playbook_entries SET started_by = ${input.startedBy}
          WHERE issue_key = ${input.issueKey}
        `;
        return true;
      },
      sql.withTransaction,
      Effect.mapError(sqlError("claimIssuePlaybookEntry")),
    ),
    release: Effect.fn("IssuePlaybookEntriesRepository.release")(
      function* (input) {
        yield* sql`
          UPDATE issue_playbook_entries SET started_by = NULL
          WHERE issue_key = ${input.issueKey} AND started_by = ${input.startedBy}
        `;
      },
      Effect.mapError(sqlError("releaseIssuePlaybookEntry")),
    ),
  });
});

export const layer = Layer.effect(IssuePlaybookEntriesRepository, make);
