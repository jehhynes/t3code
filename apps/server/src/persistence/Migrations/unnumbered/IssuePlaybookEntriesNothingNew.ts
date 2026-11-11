import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only (jehhynes/t3code#100): `nothing_new_since` holds a returning issue with nothing new.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issue_playbook_entries)
  `;
  if (columns.some((column) => column.name === "nothing_new_since")) return;
  yield* sql`
    ALTER TABLE issue_playbook_entries
    ADD COLUMN nothing_new_since TEXT
  `;
});
