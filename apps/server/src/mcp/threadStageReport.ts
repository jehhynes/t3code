// Fork-only (jehhynes/t3code#75): `t3_thread_update`'s `set_stage` binds the stage to the running run.
import {
  type CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadMetadataMcpUpdateInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type ReportedThreadStage = NonNullable<OrchestrationV2AppThread["reportedStage"]>;

/** The run a tool call executes in; the shell names none while the thread has no running turn. */
export const forInput = (
  input: ThreadMetadataMcpUpdateInput,
  shell: Pick<OrchestrationV2ThreadShell, "id" | "activeRunId">,
): Effect.Effect<ReportedThreadStage | undefined, OrchestratorMcpFailure> =>
  input.action !== "set_stage" || input.stage === undefined
    ? Effect.undefined
    : shell.activeRunId === null
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "run_not_found",
            message: `Thread ${shell.id} has no running turn; a stage shows only while a turn runs.`,
          }),
        )
      : Effect.succeed({ runId: shell.activeRunId, text: input.stage });

export const command = (input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly reportedStage?: ReportedThreadStage | undefined;
}): Extract<OrchestrationV2Command, { readonly type: "thread.metadata.update" }> => ({
  type: "thread.metadata.update",
  commandId: input.commandId,
  threadId: input.threadId,
  ...(input.reportedStage === undefined ? {} : { reportedStage: input.reportedStage }),
});
