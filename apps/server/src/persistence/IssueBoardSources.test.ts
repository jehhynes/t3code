import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssueBoardSources from "./IssueBoardSources.ts";
import { runMigrations } from "./Migrations.ts";

it.effect("keeps a board on by its owner in any casing until it is turned off", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const store = yield* IssueBoardSources.IssueBoardSourcesRepository;
    const at = "2026-11-10T00:00:00.000Z";

    assert.deepStrictEqual([...(yield* store.listEnabled)], []);
    yield* store.set({ owner: "Acme", number: 1, enabled: true, at });
    yield* store.set({ owner: "acme", number: 1, enabled: true, at });
    yield* store.set({ owner: "acme", number: 2, enabled: false, at });
    assert.deepStrictEqual([...(yield* store.listEnabled)], ["acme/1"]);
    yield* store.set({ owner: "ACME", number: 1, enabled: false, at });
    assert.deepStrictEqual([...(yield* store.listEnabled)], []);
  }).pipe(
    Effect.provide(
      IssueBoardSources.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
