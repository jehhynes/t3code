import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as IssueThreadLinks from "./IssueThreadLinks.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("answers the issues linked to a thread that is not settled, archived or deleted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = "2026-11-10T00:00:00.000Z";
    const fixtures: ReadonlyArray<{
      readonly id: string;
      readonly payload: Record<string, unknown>;
      readonly archived?: boolean;
      readonly deleted?: boolean;
    }> = [
      { id: "open", payload: {} },
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
            key: fixture.id,
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
          ${at}, ${at}, ${fixture.archived ? at : null}, ${fixture.deleted ? at : null}, ${payload}
        )
      `;
    }

    const open = yield* (yield* IssueThreadLinks.IssueThreadLinksRepository).listOpen;

    expect([...open].toSorted()).toEqual([
      "github github.com acme/web open",
      "github github.com acme/web side-chat",
      "github github.com acme/web unsettled",
    ]);
  }).pipe(
    Effect.provide(IssueThreadLinks.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
