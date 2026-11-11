import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#93): `triage` names the triage playbook that chose the entry's playbook.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "triage")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN triage TEXT
  `;
});
