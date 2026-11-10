import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#10): `auto_tried` is 1 once the server tried to start the entry by
  // itself, so a failed try waits for Start and is not tried again. A new entry starts at 0.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "auto_tried")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN auto_tried INTEGER NOT NULL DEFAULT 0
  `;
});
