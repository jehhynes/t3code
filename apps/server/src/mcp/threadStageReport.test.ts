// Fork-only (jehhynes/t3code#75)
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for stage reports"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "stage-report" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerTest = ThreadMetadataMcpService.layer.pipe(
  Layer.provideMerge(
    ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const threadId = ThreadId.make("thread:stage-report");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:stage-report"),
  requestNamespace: "thread:stage-report",
  thread: { threadId, providerSessionId: "session:stage-report", providerInstanceId: instanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const withoutStage = ({ stage: _stage, ...rest }: OrchestrationV2ThreadShell) => rest;

it.layer(layerTest)("set_stage", (it) => {
  it.effect("reports the running turn's stage and leaves the thread otherwise as it was", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
      const now = yield* DateTime.now;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-stage-report"),
        threadId,
        projectId: ProjectId.make("project:stage-report"),
        title: "Before",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      // A visited, snoozed thread, so the report could disturb unread and snooze state.
      const created = (yield* projections.getThreadProjection(threadId)).thread;
      yield* projections.apply({
        id: EventId.make("event:stage-report:snooze"),
        type: "thread.snoozed",
        threadId,
        occurredAt: now,
        payload: {
          ...created,
          lastVisitedAt: now,
          snoozedAt: now,
          snoozedUntil: DateTime.addDuration(now, Duration.hours(1)),
        },
      });
      const runId = RunId.make("run:stage-report:1");
      const runPayload = (status: "running" | "completed") => ({
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:stage-report:1"),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      });
      const common = { threadId, runId, nodeId: NodeId.make("node:stage-report"), occurredAt: now };
      yield* projections.apply({
        ...common,
        id: EventId.make("event:stage-report:run"),
        type: "run.created",
        payload: runPayload("running"),
      });

      const before = yield* projections.getThreadShell(threadId);
      assert.ok(before);
      assert.isUndefined(before.stage);
      // A report a minute later must still leave updatedAt where it was.
      yield* TestClock.adjust(Duration.minutes(1));
      const result = yield* service.update(scope, {
        action: "set_stage",
        stage: "2/6 verifying findings",
      });
      assert.strictEqual(result.action, "set_stage");
      const after = yield* projections.getThreadShell(threadId);
      assert.ok(after);
      assert.strictEqual(after.stage, "2/6 verifying findings");
      assert.deepStrictEqual(
        withoutStage(after),
        withoutStage(before),
        "title, updatedAt, unread, settled and snooze state are unchanged",
      );

      // Rename and regenerate_title still work, and keep the stage.
      yield* service.update(scope, { action: "rename", title: "After" });
      const renamed = yield* projections.getThreadShell(threadId);
      assert.strictEqual(renamed?.title, "After");
      assert.strictEqual(renamed?.stage, "2/6 verifying findings");
      const regenerating = yield* service.update(scope, { action: "regenerate_title" });
      assert.isNotNull(regenerating.titleRegeneration);

      yield* projections.apply({
        ...common,
        id: EventId.make("event:stage-report:run-done"),
        type: "run.updated",
        payload: runPayload("completed"),
      });
      assert.isUndefined((yield* projections.getThreadShell(threadId))?.stage);
      const refused = yield* service
        .update(scope, { action: "set_stage", stage: "3/6 fixing tests" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "run_not_found");
      assert.include(refused.message, "has no running turn");
    }),
  );
});
