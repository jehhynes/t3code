// Fork-only: which issues have an open thread (jehhynes/t3code#6, #7).
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
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

export class IssueThreadLinksRepository extends Context.Service<
  IssueThreadLinksRepository,
  {
    /**
     * By `issueThreadKey`, each issue linked to a thread not settled, archived or deleted, with
     * the one of those threads updated last.
     */
    readonly listOpen: Effect.Effect<ReadonlyMap<string, OpenIssueThread>, PersistenceSqlError>;
  }
>()("t3/persistence/IssueThreadLinks/IssueThreadLinksRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return IssueThreadLinksRepository.of({
    // The shell snapshot's `location: "active"` and `unsettledOnly` predicates.
    listOpen: sql<{
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
    `.pipe(
      NodeSqliteClient.readOnly,
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
  });
});

export const layer = Layer.effect(IssueThreadLinksRepository, make);
