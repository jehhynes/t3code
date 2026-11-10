import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as IssueThreadLinks from "./IssueThreadLinks.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "answers the issues linked to a thread that is not settled, archived or deleted, with the one updated last",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-10T00:00:00.000Z";
      const fixtures: ReadonlyArray<{
        readonly id: string;
        readonly payload: Record<string, unknown>;
        readonly archived?: boolean;
        readonly deleted?: boolean;
        /** The issue it links, when not its own id. */
        readonly issue?: string;
        readonly updatedAt?: string;
      }> = [
        { id: "open", payload: {}, updatedAt: "2026-11-10T00:00:02.000Z" },
        // An older open thread of the same issue; the one updated last is answered.
        { id: "open-older", payload: {}, issue: "open", updatedAt: "2026-11-10T00:00:01.000Z" },
        { id: "unsettled", payload: { settledOverride: "active" } },
        { id: "side-chat", payload: { lineage: { sideChat: true } } },
        { id: "settled", payload: { settledAt: at } },
        { id: "settled-by-hand", payload: { settledOverride: "settled" } },
        { id: "archived", payload: { archivedAt: at }, archived: true },
        { id: "deleted", payload: {}, deleted: true },
      ];
      for (const fixture of fixtures) {
        const payload = yield* encodePayload({
          settledAt: null,
          settledOverride: null,
          archivedAt: null,
          ...fixture.payload,
          issues: [
            {
              tracker: "github",
              host: "GitHub.com",
              scope: "Acme/Web",
              key: fixture.issue ?? fixture.id,
              projectId: "project-1",
              url: `https://github.com/acme/web/issues/${fixture.id}`,
              source: "manual",
              linkedAt: at,
              snapshot: null,
            },
          ],
        });
        yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${fixture.id}, 'project-1', ${fixture.id}, 'codex', 'full-access', 'default',
          ${at}, ${fixture.updatedAt ?? at}, ${fixture.archived ? at : null}, ${fixture.deleted ? at : null}, ${payload}
        )
      `;
      }

      const open = yield* (yield* IssueThreadLinks.IssueThreadLinksRepository).listOpen;

      expect([...open].toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
        ["github github.com acme/web open", { threadId: "open", projectId: "project-1" }],
        ["github github.com acme/web side-chat", { threadId: "side-chat", projectId: "project-1" }],
        ["github github.com acme/web unsettled", { threadId: "unsettled", projectId: "project-1" }],
      ]);
    }).pipe(
      Effect.provide(
        IssueThreadLinks.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
);
