// Fork-only (jehhynes/t3code#73)
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  MessageId,
  NodeId,
  type OrchestrationV2PlanStep,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("claudeAgent");

type StoreEvent = Parameters<ProjectionStore.ProjectionStoreV2Shape["apply"]>[0];
type EventWithoutMeta<E = StoreEvent> = E extends unknown ? Omit<E, "id" | "occurredAt"> : never;

const step = (text: string, status: OrchestrationV2PlanStep["status"]) => ({
  id: text,
  text,
  status,
});

it.layer(layerTest)("thread stage", (it) => {
  it.effect("is the in-progress item of the running turn's latest todo list", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:stage");
      let eventCount = 0;
      const apply = (event: EventWithoutMeta) =>
        store.apply({
          ...event,
          id: EventId.make(`event:stage:${++eventCount}`),
          occurredAt: now,
        });

      const thread = {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:stage"),
        title: "Stage",
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      } satisfies OrchestrationV2AppThread;
      yield* apply({ type: "thread.created", threadId, payload: thread });
      // Fork-only (jehhynes/t3code#75): an agent's report rides on the thread's metadata event.
      const report = (run: number, text: string) =>
        apply({
          type: "thread.metadata-updated",
          threadId,
          payload: { ...thread, reportedStage: { runId: RunId.make(`run:stage:${run}`), text } },
        });

      const run = (
        ordinal: number,
        status: "running" | "waiting" | "completed",
        userMessageId: string,
        type: "run.created" | "run.updated" = status === "running" ? "run.created" : "run.updated",
      ) => {
        const runId = RunId.make(`run:stage:${ordinal}`);
        const payload = {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(userMessageId),
          rootNodeId: null,
          activeAttemptId: null,
          status,
          requestedAt: now,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const common = {
          threadId,
          runId,
          nodeId: NodeId.make(`node:stage:root:${ordinal}`),
          driver,
        };
        return apply(
          type === "run.created"
            ? { ...common, type: "run.created", payload }
            : { ...common, type: "run.updated", payload },
        );
      };

      const list = (input: {
        readonly run: number;
        readonly plan: string;
        readonly ordinal: number;
        readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
        readonly status?: "active" | "superseded";
        readonly withTurnItem?: boolean;
      }) =>
        Effect.gen(function* () {
          const runId = RunId.make(`run:stage:${input.run}`);
          const planId = PlanId.make(input.plan);
          const nodeId = NodeId.make(`node:${input.plan}`);
          yield* apply({
            type: "plan.updated",
            threadId,
            runId,
            nodeId,
            payload: {
              id: planId,
              threadId,
              runId,
              nodeId,
              kind: "todo_list",
              status: input.status ?? "active",
              steps: [...input.steps],
            },
          });
          if (input.withTurnItem === false) return;
          yield* apply({
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId,
            driver,
            payload: {
              id: TurnItemId.make(`item:${input.plan}`),
              threadId,
              runId,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "todo_list",
              planId,
              steps: [...input.steps],
            },
          });
        });

      // The SQL shell and the in-memory shell agree on every stage.
      const stage = Effect.gen(function* () {
        const sqlShell = yield* store.getThreadShell(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(
          yield* store.getThreadProjection(threadId),
        );
        assert.strictEqual(sqlShell?.stage, memoryShell.stage);
        assert.strictEqual("stage" in memoryShell, memoryShell.stage !== undefined);
        return sqlShell?.stage;
      });

      assert.isUndefined(yield* stage);

      yield* run(1, "running", "message:stage:1");
      assert.isUndefined(yield* stage, "a running turn without a todo list has no stage");

      yield* list({
        run: 1,
        plan: "plan:m",
        ordinal: 1,
        steps: [step("Read the code", "completed"), step("Fix tests", "running")],
      });
      assert.strictEqual(yield* stage, "Fix tests");

      yield* list({
        run: 1,
        plan: "plan:m",
        ordinal: 1,
        steps: [
          step("Fix tests", "completed"),
          step("Write the fix", "running"),
          step("Also running", "running"),
        ],
      });
      assert.strictEqual(
        yield* stage,
        "Write the fix",
        "the first item in progress, in list order",
      );

      yield* list({
        run: 1,
        plan: "plan:m",
        ordinal: 1,
        steps: [step("Read the code", "completed"), step("Fix tests", "completed")],
      });
      assert.isUndefined(yield* stage, "a list with no item in progress has no stage");

      // A newer list whose plan id sorts lower still wins: plan ids do not order lists.
      yield* list({
        run: 1,
        plan: "plan:a",
        ordinal: 2,
        steps: [step("Write docs", "running"), step("Ship", "pending")],
      });
      assert.strictEqual(yield* stage, "Write docs");

      // The latest list decides even when an older list still has an item in progress.
      yield* list({
        run: 1,
        plan: "plan:m",
        ordinal: 1,
        steps: [step("Fix tests", "running")],
      });
      assert.strictEqual(yield* stage, "Write docs");
      yield* list({
        run: 1,
        plan: "plan:z",
        ordinal: 3,
        steps: [step("Ship", "pending")],
      });
      assert.isUndefined(yield* stage);

      // A superseded list is not the latest.
      yield* list({
        run: 1,
        plan: "plan:z",
        ordinal: 3,
        steps: [step("Ship", "running")],
        status: "superseded",
      });
      assert.strictEqual(yield* stage, "Write docs");

      // Lists at the same ordinal fall back to plan id; a list without a turn item comes last.
      yield* list({ run: 1, plan: "plan:y", ordinal: 2, steps: [step("Tie", "running")] });
      assert.strictEqual(yield* stage, "Tie");
      yield* list({
        run: 1,
        plan: "plan:zz",
        ordinal: 0,
        steps: [step("No item", "running")],
        withTurnItem: false,
      });
      assert.strictEqual(yield* stage, "Tie");

      // A turn waiting on the user keeps its stage.
      yield* run(1, "waiting", "message:stage:1");
      assert.strictEqual(yield* stage, "Tie");

      // T3 Code's own idle compaction run does not hide the user's turn.
      yield* apply({
        type: "message.updated",
        threadId,
        payload: {
          createdBy: "agent",
          creationSource: "server",
          id: MessageId.make("message:stage:compact"),
          threadId,
          runId: RunId.make("run:stage:2"),
          nodeId: null,
          role: "user",
          text: "/compact",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* run(2, "running", "message:stage:compact");
      assert.strictEqual(yield* stage, "Tie");
      yield* run(2, "completed", "message:stage:compact");

      yield* run(1, "completed", "message:stage:1");
      assert.isUndefined(yield* stage, "the stage goes away when the turn ends");

      yield* run(3, "running", "message:stage:3");
      assert.isUndefined(yield* stage, "a later turn does not inherit an earlier turn's list");

      // Of two active turns, the newer one's list counts.
      yield* run(4, "running", "message:stage:4");
      yield* list({ run: 4, plan: "plan:n", ordinal: 10, steps: [step("Newer turn", "running")] });
      yield* list({ run: 3, plan: "plan:o", ordinal: 11, steps: [step("Older turn", "running")] });
      assert.strictEqual(yield* stage, "Newer turn");

      // Fork-only (jehhynes/t3code#75): a reported stage, while its run is active.
      yield* report(4, "2/6 verifying findings");
      assert.strictEqual(
        yield* stage,
        "2/6 verifying findings",
        "a report goes ahead of the todo item",
      );
      yield* report(4, "3/6 fixing tests");
      assert.strictEqual(yield* stage, "3/6 fixing tests", "a new report replaces the last");
      yield* report(3, "Older run's report");
      assert.strictEqual(yield* stage, "Older run's report", "a newer active run does not hide it");
      yield* report(1, "Ended run's report");
      assert.strictEqual(yield* stage, "Newer turn", "a report for an ended run shows nothing");
      yield* report(4, "4/6 waiting on you");
      yield* run(4, "waiting", "message:stage:4");
      assert.strictEqual(yield* stage, "4/6 waiting on you", "a waiting turn keeps its report");
      yield* run(4, "completed", "message:stage:4");
      yield* run(3, "completed", "message:stage:3");
      assert.isUndefined(yield* stage, "the report goes away when the turn ends");
      yield* run(5, "running", "message:stage:5");
      assert.isUndefined(yield* stage, "a later turn does not show an earlier turn's report");
    }),
  );
});
