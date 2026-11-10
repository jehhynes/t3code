import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#7): one row per board issue ever read, keyed by its issueThreadKey.
  // `playbook` is the selection it is in, or NULL; `started_by` is NULL while that entry waits for
  // Start. `board` is the board whose read last decided the row.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_playbook_entries (
      issue_key TEXT PRIMARY KEY,
      board TEXT NOT NULL,
      playbook TEXT,
      started_by TEXT
    ) WITHOUT ROWID
  `;
});
