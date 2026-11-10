// Fork-only: which GitHub boards are turned on (jehhynes/t3code#4).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

type IssueBoardSourcesRepositoryError = PersistenceSqlError | PersistenceDecodeError;

/** A board's identity in the store; GitHub logins compare case-insensitively. */
export const boardSourceKey = (board: { readonly owner: string; readonly number: number }) =>
  `${board.owner.toLowerCase()}/${board.number}`;

const SourceRow = Schema.Struct({ owner: Schema.String, number: Schema.Number });

/** The boards named in settings that are turned on. A board is off while it has no row. */
export class IssueBoardSourcesRepository extends Context.Service<
  IssueBoardSourcesRepository,
  {
    /** The `boardSourceKey` of each board that is on. */
    readonly listEnabled: Effect.Effect<ReadonlySet<string>, IssueBoardSourcesRepositoryError>;
    readonly set: (input: {
      readonly owner: string;
      readonly number: number;
      readonly enabled: boolean;
      /** When the board was turned on, as an ISO instant. */
      readonly at: string;
    }) => Effect.Effect<void, IssueBoardSourcesRepositoryError>;
  }
>()("t3/persistence/IssueBoardSources/IssueBoardSourcesRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SourceRow,
    execute: () => sql`SELECT owner AS "owner", number AS "number" FROM issue_board_sources`,
  });

  return IssueBoardSourcesRepository.of({
    listEnabled: listRows(undefined).pipe(
      Effect.map((rows) => new Set(rows.map(boardSourceKey))),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError("IssueBoardSource", cause)
          : new PersistenceSqlError({ operation: "listIssueBoardSources", cause }),
      ),
    ),
    set: Effect.fn("IssueBoardSourcesRepository.set")(
      function* (input) {
        const owner = input.owner.toLowerCase();
        yield* input.enabled
          ? sql`
              INSERT INTO issue_board_sources (owner, number, enabled_at)
              VALUES (${owner}, ${input.number}, ${input.at})
              ON CONFLICT (owner, number) DO NOTHING
            `
          : sql`DELETE FROM issue_board_sources WHERE owner = ${owner} AND number = ${input.number}`;
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "setIssueBoardSource", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(IssueBoardSourcesRepository, make);
