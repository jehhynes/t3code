import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#19): `start_failure` is the cause of the entry's last failed start,
  // shown on the issue until a start succeeds or the issue leaves the selection.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "start_failure")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN start_failure TEXT
  `;
});
