import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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

it.effect(
  "answers when the first turn of the issue's latest thread that ran started (jehhynes/t3code#100)",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-10T00:00:00.000Z";
      const fixtures: ReadonlyArray<{
        readonly id: string;
        /** Each run's `startedAt`; null for a run that never started. */
        readonly runs: ReadonlyArray<string | null>;
        readonly issue?: string;
        readonly settled?: boolean;
        readonly deleted?: boolean;
      }> = [
        { id: "first", runs: ["2026-11-10T01:00:00.000Z", "2026-11-10T09:00:00.000Z"] },
        // Settled, and in another ISO form: its first turn is the latest.
        {
          id: "settled",
          runs: ["2026-11-10T05:00:00Z", "2026-11-10T04:00:00.000Z"],
          settled: true,
        },
        // Created but never ran a turn.
        { id: "never-ran", runs: [null] },
        { id: "no-runs", runs: [] },
        { id: "deleted", runs: ["2026-11-10T08:00:00.000Z"], deleted: true },
        { id: "other-issue", runs: ["2026-11-10T08:00:00.000Z"], issue: "7" },
      ];
      for (const fixture of fixtures) {
        const payload = yield* encodePayload({
          settledAt: fixture.settled ? at : null,
          archivedAt: null,
          issues: [
            {
              tracker: "github",
              host: "GitHub.com",
              scope: "Acme/Web",
              key: fixture.issue ?? "6",
              projectId: "project-1",
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
          ${fixture.id}, 'project-1', ${fixture.id}, 'codex', 'full-access', 'default',
          ${at}, ${at}, NULL, ${fixture.deleted ? at : null}, ${payload}
        )
      `;
        for (const [index, startedAt] of fixture.runs.entries()) {
          const runPayload = yield* encodePayload({ startedAt });
          yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
            completed_at, payload_json
          ) VALUES (
            ${`${fixture.id}-${index}`}, ${fixture.id}, ${index + 1}, 'codex', NULL,
            ${startedAt === null ? "failed" : "completed"}, ${at}, NULL, ${runPayload}
          )
        `;
        }
      }
      const links = yield* IssueThreadLinks.IssueThreadLinksRepository;

      expect(yield* links.earlierWork("github github.com acme/web 6")).toEqual({
        at: "2026-11-10T04:00:00.000Z",
        playbook: null,
      });
      expect(yield* links.earlierWork("github github.com acme/web 8")).toBeNull();

      // Fork-only (jehhynes/t3code#102): named by the start whose prompt is its first message.
      yield* insertMessage(sql, { id: "m-settled", threadId: "settled", createdAt: at });
      yield* sql`
        INSERT INTO issue_playbook_starts (message_id, issue_key, playbook)
        VALUES ('m-settled', 'github github.com acme/web 6', 'Fix')
      `;
      expect(yield* links.earlierWork("github github.com acme/web 6")).toEqual({
        at: "2026-11-10T04:00:00.000Z",
        playbook: "Fix",
      });
      // A later start into the thread, or a restart's steering message, does not take it over.
      yield* insertMessage(sql, {
        id: "m-later",
        threadId: "settled",
        createdAt: "2026-11-10T06:00:00.000Z",
      });
      yield* sql`
        INSERT INTO issue_playbook_starts (message_id, issue_key, playbook)
        VALUES ('m-later', 'github github.com acme/web 6', 'answer')
      `;
      expect((yield* links.earlierWork("github github.com acme/web 6"))?.playbook).toBe("Fix");
      // A first message no start recorded, as before this change, names none.
      yield* insertMessage(sql, {
        id: "m-first",
        threadId: "settled",
        createdAt: "2026-11-09T23:00:00.000Z",
      });
      expect((yield* links.earlierWork("github github.com acme/web 6"))?.playbook).toBeNull();
    }).pipe(
      Effect.provide(
        IssueThreadLinks.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
);

const insertMessage = (
  sql: SqlClient.SqlClient,
  message: { readonly id: string; readonly threadId: string; readonly createdAt: string },
) => sql`
  INSERT INTO orchestration_v2_projection_messages (
    message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
  ) VALUES (
    ${message.id}, ${message.threadId}, NULL, NULL, 'user', 0, ${message.createdAt},
    ${message.createdAt}, '{}'
  )
`;

// Fork-only (jehhynes/t3code#102)
it.effect(
  "counts each playbook's threads for an issue that ran, by the start whose prompt is the thread's first message",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const issueKey = "github github.com acme/web 6";
      const fixtures: ReadonlyArray<{
        readonly id: string;
        /** Its user messages: id, the minute after 00:00 it was sent, and the start that sent it. */
        readonly messages: ReadonlyArray<readonly [string, number, string | null]>;
        /** Each run's `startedAt` minute; null for a run that never started. */
        readonly runs: ReadonlyArray<number | null>;
        readonly issue?: string;
        readonly deleted?: boolean;
      }> = [
        { id: "launched", messages: [["a1", 10, "Fix"]], runs: [11] },
        // A later start into the thread, as Start into an open thread, does not take it over.
        {
          id: "sent-into",
          messages: [
            ["b1", 20, "fix"],
            ["b2", 30, "answer"],
          ],
          runs: [21, 31],
        },
        // A restarted first turn: its run now names the steering message; the first stays the start's.
        {
          id: "restarted",
          messages: [
            ["r1", 40, "fix"],
            ["r2", 41, null],
          ],
          runs: [42],
        },
        { id: "never-ran", messages: [["n1", 50, "fix"]], runs: [null] },
        { id: "deleted", messages: [["d1", 50, "fix"]], runs: [51], deleted: true },
        { id: "unlinked", messages: [["u1", 50, "fix"]], runs: [51], issue: "7" },
        // Started before this change: its first message has no record.
        {
          id: "pre-change",
          messages: [
            ["p0", 5, null],
            ["p1", 6, "fix"],
          ],
          runs: [7],
        },
        { id: "other", messages: [["o1", 60, "answer"]], runs: [61] },
        // Two drafts sent into one thread are two records; the thread counts once.
        {
          id: "drafts",
          messages: [
            ["c1", 70, "check"],
            ["c2", 80, "check"],
          ],
          runs: [71, 81],
        },
      ];
      const minute = (value: number) =>
        DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 10, 10, 0, value)));
      for (const fixture of fixtures) {
        const payload = yield* encodePayload({
          settledAt: null,
          archivedAt: null,
          issues: [
            {
              tracker: "github",
              host: "github.com",
              scope: "acme/web",
              key: fixture.issue ?? "6",
              projectId: "project-1",
              url: "https://github.com/acme/web/issues/6",
              source: "manual",
              linkedAt: minute(0),
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
            ${minute(0)}, ${minute(0)}, NULL, ${fixture.deleted ? minute(0) : null}, ${payload}
          )
        `;
        for (const [id, sent, playbook] of fixture.messages) {
          yield* insertMessage(sql, { id, threadId: fixture.id, createdAt: minute(sent) });
          if (playbook !== null) {
            yield* sql`
              INSERT INTO issue_playbook_starts (message_id, issue_key, playbook)
              VALUES (${id}, ${issueKey}, ${playbook})
            `;
          }
        }
        for (const [index, started] of fixture.runs.entries()) {
          const runPayload = yield* encodePayload({
            startedAt: started === null ? null : minute(started),
            userMessageId: fixture.id === "restarted" ? "r2" : fixture.messages[index]?.[0],
          });
          yield* sql`
            INSERT INTO orchestration_v2_projection_runs (
              run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
              completed_at, payload_json
            ) VALUES (
              ${`${fixture.id}-${index}`}, ${fixture.id}, ${index + 1}, 'codex', NULL, 'completed',
              ${minute(0)}, NULL, ${runPayload}
            )
          `;
        }
      }
      // A start whose prompt never reached a thread names none.
      yield* sql`
        INSERT INTO issue_playbook_starts (message_id, issue_key, playbook)
        VALUES ('lost', ${issueKey}, 'fix')
      `;

      const returns = yield* (yield* IssueThreadLinks.IssueThreadLinksRepository).returns;

      expect([...returns.keys()]).toEqual([issueKey]);
      expect(Object.fromEntries(returns.get(issueKey) ?? [])).toEqual({
        fix: { count: 3, lastAt: minute(42) },
        answer: { count: 1, lastAt: minute(61) },
        check: { count: 1, lastAt: minute(71) },
      });
    }).pipe(
      Effect.provide(
        IssueThreadLinks.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
);
