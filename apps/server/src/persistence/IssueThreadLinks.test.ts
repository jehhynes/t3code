import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as IssueThreadLinks from "./IssueThreadLinks.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "answers the issues linked to a thread that is not settled, archived or deleted, with the one updated last, and every such thread's links",
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
      // Every open thread, also two of one issue (jehhynes/t3code#76).
      const links = yield* (yield* IssueThreadLinks.IssueThreadLinksRepository).openLinks;
      expect(links.toSorted((a, b) => a.threadId.localeCompare(b.threadId))).toEqual([
        { threadId: "open", issueKey: "github github.com acme/web open" },
        { threadId: "open-older", issueKey: "github github.com acme/web open" },
        { threadId: "side-chat", issueKey: "github github.com acme/web side-chat" },
        { threadId: "unsettled", issueKey: "github github.com acme/web unsettled" },
      ]);
    }).pipe(
      Effect.provide(
        IssueThreadLinks.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
);

it.effect(
  "answers the worktree of the issue's thread in the project updated last, settled and archived included",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-10T00:00:00.000Z";
      const fixtures: ReadonlyArray<{
        readonly id: string;
        readonly worktreePath: string | null;
        readonly updatedAt: string;
        readonly project?: string;
        readonly issue?: string;
        readonly settled?: boolean;
        readonly archived?: boolean;
        readonly deleted?: boolean;
      }> = [
        { id: "older", worktreePath: "/wt/older", updatedAt: "2026-11-10T00:00:01.000Z" },
        {
          id: "settled",
          worktreePath: "/wt/settled",
          updatedAt: "2026-11-10T00:00:02.000Z",
          settled: true,
          archived: true,
        },
        // Each later thread is not the issue's worktree.
        { id: "root", worktreePath: null, updatedAt: "2026-11-10T00:00:03.000Z" },
        {
          id: "deleted",
          worktreePath: "/wt/deleted",
          updatedAt: "2026-11-10T00:00:04.000Z",
          deleted: true,
        },
        {
          id: "elsewhere",
          worktreePath: "/wt/elsewhere",
          updatedAt: "2026-11-10T00:00:05.000Z",
          project: "project-2",
        },
        {
          id: "other-issue",
          worktreePath: "/wt/other",
          updatedAt: "2026-11-10T00:00:06.000Z",
          issue: "7",
        },
      ];
      for (const fixture of fixtures) {
        const payload = yield* encodePayload({
          settledAt: fixture.settled ? at : null,
          archivedAt: fixture.archived ? at : null,
          worktreePath: fixture.worktreePath,
          branch: fixture.worktreePath === null ? null : `t3/${fixture.id}`,
          issues: [
            {
              tracker: "github",
              host: "GitHub.com",
              scope: "Acme/Web",
              key: fixture.issue ?? "6",
              projectId: fixture.project ?? "project-1",
              url: "https://github.com/acme/web/issues/6",
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
          ${fixture.id}, ${fixture.project ?? "project-1"}, ${fixture.id}, 'codex', 'full-access',
          'default', ${at}, ${fixture.updatedAt}, ${fixture.archived ? at : null},
          ${fixture.deleted ? at : null}, ${payload}
        )
      `;
      }
      const links = yield* IssueThreadLinks.IssueThreadLinksRepository;

      expect(
        yield* links.latestWorktree("github github.com acme/web 6", ProjectId.make("project-1")),
      ).toEqual({ worktreePath: "/wt/settled", branch: "t3/settled" });
      expect(
        yield* links.latestWorktree("github github.com acme/web 8", ProjectId.make("project-1")),
      ).toBeNull();
    }).pipe(
      Effect.provide(
        IssueThreadLinks.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
);
