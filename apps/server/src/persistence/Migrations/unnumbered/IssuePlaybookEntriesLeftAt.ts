import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#57): `left_at` is when the issue last left every selection, the
  // moment its threads settle; rows that left before this step have none.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "left_at")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN left_at TEXT
  `;
});
