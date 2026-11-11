// Fork-only: which issues have an open thread (jehhynes/t3code#6, #7), their earlier work
// (jehhynes/t3code#100), and the threads each playbook started for them (jehhynes/t3code#102).
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError } from "./Errors.ts";

/** An issue's identity across threads, compared as `threadIssueKeysEqual` compares. */
export const issueThreadKey = (issue: {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
}) =>
  `${issue.tracker} ${issue.host.trim().toLowerCase()} ${issue.scope.trim().toLowerCase()} ${issue.key.trim()}`;

export interface OpenIssueThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export interface IssueWorktree {
  readonly worktreePath: string;
  readonly branch: string | null;
}

/** The threads a playbook started for an issue that ran a turn (jehhynes/t3code#102). */
export interface PlaybookReturns {
  readonly count: number;
  /** When the first turn of the latest of them started, as a UTC ISO time. */
  readonly lastAt: string;
}

/** The issue's earlier thread, and the playbook that started it when recorded. */
export interface EarlierWork {
  /** When its first turn started, as a UTC ISO time. */
  readonly at: string;
  readonly playbook: string | null;
}

export class IssueThreadLinksRepository extends Context.Service<
  IssueThreadLinksRepository,
  {
    /**
     * By `issueThreadKey`, each issue linked to a thread not settled, archived or deleted, with
     * the one of those threads updated last.
     */
    readonly listOpen: Effect.Effect<ReadonlyMap<string, OpenIssueThread>, PersistenceSqlError>;
    /**
     * Every thread not settled, archived or deleted, with the `issueThreadKey` of each issue it
     * links, one pair per link (jehhynes/t3code#76).
     */
    readonly openLinks: Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly issueKey: string }>,
      PersistenceSqlError
    >;
    /**
     * The worktree of the issue's thread in the project updated last among those that have one,
     * settled and archived included, deleted not (jehhynes/t3code#31).
     */
    readonly latestWorktree: (
      issueKey: string,
      projectId: ProjectId,
    ) => Effect.Effect<IssueWorktree | null, PersistenceSqlError>;
    /**
     * When the first turn of the issue's latest thread that ran started, as a UTC ISO time: the
     * latest of its threads' first started turns, settled and archived included, deleted not; null
     * when none ran (jehhynes/t3code#100). With the playbook whose prompt is that thread's first
     * message, when a start recorded one for this issue (jehhynes/t3code#102).
     */
    readonly earlierWork: (
      issueKey: string,
    ) => Effect.Effect<EarlierWork | null, PersistenceSqlError>;
    /**
     * By `issueThreadKey`, then by lowercased playbook name: the issue's threads, not deleted and
     * still linked to it, whose first message is a prompt that playbook's start sent for it, and
     * that ran a turn (jehhynes/t3code#102).
     */
    readonly returns: Effect.Effect<
      ReadonlyMap<string, ReadonlyMap<string, PlaybookReturns>>,
      PersistenceSqlError
    >;
  }
>()("t3/persistence/IssueThreadLinks/IssueThreadLinksRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The shell snapshot's `location: "active"` and `unsettledOnly` predicates.
  const openLinkRows = sql<{
    threadId: ThreadId;
    projectId: ProjectId;
    tracker: string;
    host: string;
    scope: string;
    key: string;
  }>`
    SELECT t.thread_id AS "threadId", t.project_id AS "projectId",
      json_extract(link.value, '$.tracker') AS tracker,
      json_extract(link.value, '$.host') AS host,
      json_extract(link.value, '$.scope') AS scope,
      json_extract(link.value, '$.key') AS key
    FROM orchestration_v2_projection_threads AS t
    JOIN json_each(t.payload_json, '$.issues') AS link
    WHERE t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.archivedAt') IS NULL
      AND json_extract(t.payload_json, '$.settledAt') IS NULL
      AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
    ORDER BY t.updated_at, t.thread_id
  `.pipe(NodeSqliteClient.readOnly);
  return IssueThreadLinksRepository.of({
    listOpen: openLinkRows.pipe(
      // Ordered, so the thread updated last stays.
      Effect.map(
        (rows) =>
          new Map(
            rows.map((row) => [
              issueThreadKey(row),
              { threadId: row.threadId, projectId: row.projectId },
            ]),
          ),
      ),
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "listOpenIssueThreads", cause }),
      ),
      Effect.withSpan("IssueThreadLinksRepository.listOpen"),
    ),
    openLinks: openLinkRows.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ threadId: row.threadId, issueKey: issueThreadKey(row) })),
      ),
      Effect.mapError((cause) => new PersistenceSqlError({ operation: "openIssueLinks", cause })),
      Effect.withSpan("IssueThreadLinksRepository.openLinks"),
    ),
    latestWorktree: Effect.fn("IssueThreadLinksRepository.latestWorktree")(
      function* (issueKey, projectId) {
        const rows = yield* sql<{
          worktreePath: string;
          branch: string | null;
          tracker: string;
          host: string;
          scope: string;
          key: string;
        }>`
          SELECT json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
            json_extract(t.payload_json, '$.branch') AS branch,
            json_extract(link.value, '$.tracker') AS tracker,
            json_extract(link.value, '$.host') AS host,
            json_extract(link.value, '$.scope') AS scope,
            json_extract(link.value, '$.key') AS key
          FROM orchestration_v2_projection_threads AS t
          JOIN json_each(t.payload_json, '$.issues') AS link
          WHERE t.project_id = ${projectId}
            AND t.deleted_at IS NULL
            AND json_extract(t.payload_json, '$.worktreePath') IS NOT NULL
          ORDER BY t.updated_at DESC, t.thread_id DESC
        `.pipe(NodeSqliteClient.readOnly);
        const row = rows.find((candidate) => issueThreadKey(candidate) === issueKey);
        return row === undefined ? null : { worktreePath: row.worktreePath, branch: row.branch };
      },
      Effect.mapError(
        (cause) => new PersistenceSqlError({ operation: "latestIssueWorktree", cause }),
      ),
    ),
    earlierWork: Effect.fn("IssueThreadLinksRepository.earlierWork")(
      function* (issueKey) {
        const key = issueKey.split(" ").at(-1) ?? "";
        const rows = yield* sql<{
          threadId: string;
          startedAt: string;
          tracker: string;
          host: string;
          scope: string;
          key: string;
        }>`
          SELECT t.thread_id AS "threadId",
            json_extract(r.payload_json, '$.startedAt') AS "startedAt",
            json_extract(link.value, '$.tracker') AS tracker,
            json_extract(link.value, '$.host') AS host,
            json_extract(link.value, '$.scope') AS scope,
            json_extract(link.value, '$.key') AS key
          FROM orchestration_v2_projection_threads AS t
          JOIN json_each(t.payload_json, '$.issues') AS link
          JOIN orchestration_v2_projection_runs AS r ON r.thread_id = t.thread_id
          WHERE t.deleted_at IS NULL
            AND trim(json_extract(link.value, '$.key')) = ${key}
            AND json_extract(r.payload_json, '$.startedAt') IS NOT NULL
        `.pipe(NodeSqliteClient.readOnly);
        // Parsed, since stored times need not share one ISO form.
        const firstTurns = new Map<string, number>();
        for (const row of rows) {
          if (issueThreadKey(row) !== issueKey) continue;
          const startedAt = Date.parse(row.startedAt);
          if (Number.isNaN(startedAt)) continue;
          const first = firstTurns.get(row.threadId);
          if (first === undefined || startedAt < first) firstTurns.set(row.threadId, startedAt);
        }
        let latest: { readonly threadId: string; readonly at: number } | undefined;
        for (const [threadId, at] of firstTurns) {
          if (latest === undefined || at > latest.at) latest = { threadId, at };
        }
        if (latest === undefined) return null;
        const [first] = yield* sql<{ playbook: string | null; issueKey: string | null }>`
          SELECT s.playbook AS playbook, s.issue_key AS "issueKey"
          FROM orchestration_v2_projection_messages AS m
          LEFT JOIN issue_playbook_starts AS s ON s.message_id = m.message_id
          WHERE m.thread_id = ${latest.threadId} AND m.role = 'user'
          ORDER BY m.created_at, m.message_id
          LIMIT 1
        `.pipe(NodeSqliteClient.readOnly);
        return {
          at: DateTime.formatIso(DateTime.makeUnsafe(latest.at)),
          playbook: first?.issueKey === issueKey ? first.playbook : null,
        };
      },
      Effect.mapError((cause) => new PersistenceSqlError({ operation: "issueEarlierWork", cause })),
    ),
    returns: sql<{
      issueKey: string;
      playbook: string;
      threadId: string;
      startedAt: string | null;
      tracker: string;
      host: string;
      scope: string;
      key: string;
    }>`
      SELECT s.issue_key AS "issueKey", s.playbook AS playbook, t.thread_id AS "threadId",
        (
          SELECT json_extract(r.payload_json, '$.startedAt')
          FROM orchestration_v2_projection_runs AS r
          WHERE r.thread_id = t.thread_id
            AND json_extract(r.payload_json, '$.startedAt') IS NOT NULL
          ORDER BY r.ordinal
          LIMIT 1
        ) AS "startedAt",
        json_extract(link.value, '$.tracker') AS tracker,
        json_extract(link.value, '$.host') AS host,
        json_extract(link.value, '$.scope') AS scope,
        json_extract(link.value, '$.key') AS key
      FROM issue_playbook_starts AS s
      -- CROSS JOIN keeps the start records outermost, so no board read scans every message.
      CROSS JOIN orchestration_v2_projection_messages AS m ON m.message_id = s.message_id
      CROSS JOIN orchestration_v2_projection_threads AS t ON t.thread_id = m.thread_id
      JOIN json_each(t.payload_json, '$.issues') AS link
      WHERE t.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_messages AS e
          WHERE e.thread_id = m.thread_id AND e.role = 'user'
            AND (e.created_at < m.created_at
              OR (e.created_at = m.created_at AND e.message_id < m.message_id))
        )
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.map((rows) => {
        const threads = new Map<string, Map<string, Map<string, number>>>();
        for (const row of rows) {
          if (row.startedAt === null || issueThreadKey(row) !== row.issueKey) continue;
          const startedAt = Date.parse(row.startedAt);
          if (Number.isNaN(startedAt)) continue;
          const byPlaybook = threads.get(row.issueKey) ?? new Map<string, Map<string, number>>();
          threads.set(row.issueKey, byPlaybook);
          const playbook = row.playbook.toLowerCase();
          const started = byPlaybook.get(playbook) ?? new Map<string, number>();
          byPlaybook.set(playbook, started);
          started.set(row.threadId, startedAt);
        }
        return new Map(
          [...threads].map(([issueKey, byPlaybook]) => [
            issueKey,
            new Map(
              [...byPlaybook].map(([playbook, started]) => [
                playbook,
                {
                  count: started.size,
                  lastAt: DateTime.formatIso(DateTime.makeUnsafe(Math.max(...started.values()))),
                },
              ]),
            ),
          ]),
        );
      }),
      Effect.mapError((cause) => new PersistenceSqlError({ operation: "issueReturns", cause })),
      Effect.withSpan("IssueThreadLinksRepository.returns"),
    ),
  });
});

export const layer = Layer.effect(IssueThreadLinksRepository, make);
