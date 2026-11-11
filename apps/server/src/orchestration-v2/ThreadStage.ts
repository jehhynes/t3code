/**
 * Fork-only (jehhynes/t3code#73, #75): a thread's stage, the one its agent reported for a run that
 * is still active, else the in-progress item of the latest todo list its running turn keeps. The
 * SQL column and the in-memory form apply the same rule.
 */
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

type Run = OrchestrationV2ThreadProjection["runs"][number];

const ACTIVITY_STATUSES: ReadonlySet<Run["status"]> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * The todo item of thread alias `t`. Plan ids do not order lists, so a list's turn item ordinal does,
 * and only the latest list's running step counts.
 */
const todoColumn = (
  sql: SqlClient.SqlClient,
  isSilentRun: (alias: string) => Statement.Fragment,
) => sql`(
  SELECT json_extract(step.value, '$.text')
  FROM (
    SELECT plan.payload_json
    FROM orchestration_v2_projection_plans plan
    WHERE plan.run_id = (
        SELECT r.run_id
        FROM orchestration_v2_projection_runs r
        WHERE r.thread_id = t.thread_id
          AND r.status IN ('preparing', 'starting', 'running', 'waiting')
          AND NOT ${isSilentRun("r")}
        ORDER BY r.ordinal DESC, r.run_id DESC
        LIMIT 1
      )
      AND plan.thread_id = t.thread_id
      AND plan.kind = 'todo_list' AND plan.status <> 'superseded'
    ORDER BY (
        SELECT MAX(list_item.ordinal)
        FROM orchestration_v2_projection_turn_items list_item
        WHERE list_item.node_id = plan.node_id AND list_item.type = 'todo_list'
      ) DESC, plan.plan_id DESC
    LIMIT 1
  ) latest
  CROSS JOIN json_each(latest.payload_json, '$.steps') step
  WHERE json_extract(step.value, '$.status') = 'running'
  ORDER BY step.key ASC
  LIMIT 1
)`;

/** The stage of thread alias `t`. */
export const column = (
  sql: SqlClient.SqlClient,
  isSilentRun: (alias: string) => Statement.Fragment,
) => sql`COALESCE(
  (
    SELECT json_extract(t.payload_json, '$.reportedStage.text')
    FROM orchestration_v2_projection_runs reported
    WHERE reported.run_id = json_extract(t.payload_json, '$.reportedStage.runId')
      AND reported.thread_id = t.thread_id
      AND reported.status IN ('preparing', 'starting', 'running', 'waiting')
      AND NOT ${isSilentRun("reported")}
  ),
  ${todoColumn(sql, isSilentRun)}
)`;

/** `runs` are the shell's runs, silent ones already left out. */
export function ofProjection(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "plans" | "turnItems">,
  runs: ReadonlyArray<Run>,
): string | null {
  const reported = projection.thread.reportedStage;
  if (
    reported !== undefined &&
    runs.some(
      (candidate) => candidate.id === reported.runId && ACTIVITY_STATUSES.has(candidate.status),
    )
  ) {
    return reported.text;
  }
  const run = runs
    .filter((candidate) => ACTIVITY_STATUSES.has(candidate.status))
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  if (run === undefined) return null;
  const listedAt = (nodeId: string) =>
    Math.max(
      Number.NEGATIVE_INFINITY,
      ...projection.turnItems
        .filter((item) => item.nodeId === nodeId && item.type === "todo_list")
        .map((item) => item.ordinal),
    );
  const latest = projection.plans
    .filter(
      (plan) => plan.runId === run.id && plan.kind === "todo_list" && plan.status !== "superseded",
    )
    .toSorted(
      (left, right) =>
        listedAt(right.nodeId) - listedAt(left.nodeId) ||
        (right.id > left.id ? 1 : right.id < left.id ? -1 : 0),
    )[0];
  if (latest?.kind !== "todo_list") return null;
  return latest.steps.find((step) => step.status === "running")?.text ?? null;
}

export const field = (stage: string | null): Pick<OrchestrationV2ThreadShell, "stage"> =>
  stage === null ? {} : { stage };
