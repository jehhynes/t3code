import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#65): `start_queued` is a Start held until the issue's blockers close.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "start_queued")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN start_queued INTEGER NOT NULL DEFAULT 0
  `;
});
