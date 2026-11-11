import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#76): `waiting_since` orders the starts that wait for a free slot.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "waiting_since")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN waiting_since TEXT
  `;
});
