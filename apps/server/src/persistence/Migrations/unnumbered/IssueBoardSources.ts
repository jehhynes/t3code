import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#4): one row per GitHub board in settings.json that is turned on,
  // keyed by its lowercased owner and number. A board with no row is off and is not read.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_board_sources (
      owner TEXT NOT NULL,
      number INTEGER NOT NULL,
      enabled_at TEXT NOT NULL,
      PRIMARY KEY (owner, number)
    ) WITHOUT ROWID
  `;
});
