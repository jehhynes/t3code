import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#86): `snoozed_until` holds a waiting issue's start until its wake.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "snoozed_until")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN snoozed_until TEXT
  `;
});
