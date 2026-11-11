import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#102): the playbook whose prompt each start sent, keyed by that
  // prompt's message id; a thread whose first user message it is was started by that playbook.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_playbook_starts (
      message_id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      playbook TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});
