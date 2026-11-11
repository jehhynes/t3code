// Fork-only: Start runs a playbook for a board issue that waits (jehhynes/t3code#6, #7).
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IssueOperationError,
  MessageId,
  type IssueBoardEntry,
  type IssuePlaybook,
  type IssuePlaybookDraft,
  type IssuePlaybookDraftInput,
  type IssuePlaybookStartInput,
  type IssuePlaybookStartOnSendInput,
  type IssuePlaybookStartResult,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type Project,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueThreadSlots from "./IssueThreadSlots.ts";
import { issueWorktreeConfig, makeIssueWorkspace } from "./issueWorktree.ts";
import * as IssueWorktrees from "./IssueWorktrees.ts";
import { entryWaitingIn, heldIn } from "./playbookEntries.ts";
import { renderPlaybookPrompt } from "./playbookPrompt.ts";
import { PLAYBOOKS_FILE, readPlaybooksFile } from "./playbookSelection.ts";

export class PlaybookStartService extends Context.Service<
  PlaybookStartService,
  {
    /**
     * Sends the playbook's prompt to the issue's open thread, or launches its thread, linked to
     * the issue waiting with that playbook. An issue held by an open blocker (jehhynes/t3code#65)
     * or with no free slot (#76) is queued instead; `cancelQueued` takes that back. A start by
     * itself with no free slot answers no thread and spends no try.
     */
    readonly start: (
      input: IssuePlaybookStartInput,
      options?: {
        /**
         * A start by the server itself, while `playbooks.json` has no mistake: only a queued entry,
         * or an entry not tried before of a playbook that starts by itself.
         */
        readonly auto?: boolean;
      },
    ) => Effect.Effect<IssuePlaybookStartResult, IssueOperationError>;
    /** What a draft for the issue holds: the prompt, settings and folder Start would launch with. */
    readonly prepareDraft: (
      input: IssuePlaybookDraftInput,
    ) => Effect.Effect<IssuePlaybookDraft, IssueOperationError>;
    /**
     * My next message accepted on the thread starts the issue's entry, as Start would have, and
     * links the thread. Kept in memory until that message.
     */
    readonly startOnSend: (
      input: IssuePlaybookStartOnSendInput,
    ) => Effect.Effect<void, IssueOperationError>;
    /** Takes each committed domain event; a draft's start runs on a worker. */
    readonly handleEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    /** Waits until a slot may have freed while a start waited for one (jehhynes/t3code#76). */
    readonly awaitFreedSlot: Effect.Effect<void>;
  }
>()("t3/issue/PlaybookStartService") {}

/** A message I sent, not a compaction, approval feedback, a scheduled task's or an agent's. */
export function isComposerMessage(message: OrchestrationV2ConversationMessage): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "user" &&
    message.creationSource !== "server" &&
    message.idleCompaction === undefined &&
    message.scheduledTaskId === undefined &&
    message.senderThreadId === undefined &&
    message.delegatedCompletion === undefined
  );
}

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);
const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);
const isThreadLaunchError = Schema.is(ThreadLaunchService.ThreadLaunchError);
const isSlotsError = Schema.is(IssueThreadSlots.IssueThreadSlotsError);

/** Whether a failed start leaves its issue started, or waiting again with the failure's cause. */
type Decision = "keep" | "release";

interface StartContext {
  readonly id: string;
  readonly entry: IssueBoardEntry;
  readonly projectId: ProjectId;
}

const startIds = (id: string) => ({
  commandId: CommandId.make(`issue-playbook:${id}`),
  messageId: MessageId.make(`issue-playbook-message:${id}`),
});

function launchFailure(
  error:
    | ThreadLaunchService.ThreadLaunchError
    | ThreadManagement.ThreadManagementProviderInstanceDisabledError,
): string {
  if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
    return `Provider instance ${error.instanceId} is turned off for this project.`;
  }
  if (isAboveCeilingError(error.cause)) {
    return `Managed settings allow at most the ${error.cause.maxRuntimeMode} permission mode, so a ${error.cause.runtimeMode} thread cannot start.`;
  }
  return `The thread could not be started; it failed during ${error.operation}.`;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threadIssues = yield* ThreadIssueService.ThreadIssueService;
  const threadLinks = yield* IssueThreadLinks.IssueThreadLinksRepository;
  const entries = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const issues = yield* IssueService.IssueService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const playbooksPath = path.join(path.dirname(config.settingsPath), PLAYBOOKS_FILE);
  const issueWorkspace = yield* makeIssueWorkspace;
  const issueWorktrees = yield* IssueWorktrees.IssueWorktrees;
  const slots = yield* IssueThreadSlots.make;

  const fail = (detail: string, cause?: unknown) =>
    new IssueOperationError({
      operation: "startPlaybook",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const launchedTitle = (entry: IssueBoardEntry) => `${entry.displayKey} ${entry.title}`;

  const linkThread = Effect.fn("PlaybookStartService.linkThread")(function* (
    threadId: ThreadId,
    entry: IssueBoardEntry,
    projectId: ProjectId,
  ) {
    return yield* threadIssues.link({
      threadId,
      ref: {
        projectId,
        tracker: entry.tracker,
        host: entry.host,
        scope: entry.scope,
        key: entry.key,
      },
      url: entry.url,
      source: "manual",
    });
  });

  /**
   * The thread a failed or interrupted start left, read from its command receipts, which commit
   * with their events: the launch's `thread.create` or the send's `message.dispatch`, and whether
   * the start's prompt reached that thread.
   */
  const startedThread = Effect.fn("PlaybookStartService.startedThread")(function* (id: string) {
    const { commandId } = startIds(id);
    const accepted = (commandId: CommandId) =>
      receipts
        .getByCommandId(commandId)
        .pipe(
          Effect.map((receipt) =>
            Option.filter(receipt, (candidate) => candidate.status === "accepted"),
          ),
        );
    const receipt = yield* accepted(commandId);
    if (Option.isNone(receipt)) return null;
    const { threadId, commandType } = receipt.value;
    if (commandType === "message.dispatch") {
      return { threadId, launched: false, promptReached: true };
    }
    if (commandType !== "thread.create") return null;
    const prompt = yield* accepted(CommandId.make(`${commandId}:initial-message`));
    return { threadId, launched: true, promptReached: Option.isSome(prompt) };
  });

  /**
   * Decides a start that failed (`failure`) or was interrupted (null) once its thread may exist. A
   * thread holding the prompt keeps the issue started; an empty one is linked so Retry sends the
   * prompt there, and the issue waits again unless that link fails. Answers Start's failure.
   */
  const settle = Effect.fn("PlaybookStartService.settle")(function* (
    failure: IssueOperationError | null,
    { id, entry, projectId }: StartContext,
  ) {
    // A receipt that cannot be read counts as nothing started, as before (jehhynes/t3code#23).
    const thread = yield* startedThread(id).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A failed Start could not tell whether its thread exists", {
          id,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (thread === null) return { decision: "release" as const, failure };
    const linked = thread.launched
      ? yield* linkThread(thread.threadId, entry, projectId).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("A failed Start could not link its thread", { id, cause }).pipe(
              Effect.as(false),
            ),
          ),
        )
      : true;
    const launchError = isThreadLaunchError(failure?.cause) ? failure.cause : undefined;
    // After an interruption the launch may have scheduled the run's preparation; leave it alone.
    if (failure !== null && launchError !== undefined && thread.launched && thread.promptReached) {
      yield* failStrandedRun(thread.threadId, startIds(id), failure.detail);
    }
    const decision: Decision = thread.promptReached || !linked ? "keep" : "release";
    if (failure === null) return { decision, failure };
    const title = thread.launched
      ? launchedTitle(entry)
      : ((yield* threads.getThreadShell(thread.threadId).pipe(Effect.orElseSucceed(() => null)))
          ?.title ?? "the issue's open thread");
    const detail = !thread.launched
      ? `The prompt reached thread "${title}", but its answer could not be read.`
      : thread.promptReached
        ? `Thread "${title}" started, but its start failed during ${launchError?.operation ?? "its launch"}.`
        : linked
          ? `Thread "${title}" was created, but the prompt could not be sent to it; Retry sends it there.`
          : `Thread "${title}" was created, but the prompt could not be sent to it, and it could not be linked to the issue.`;
    return { decision, failure: fail(detail, failure.cause) };
  });

  const settleFailure = Effect.fn("PlaybookStartService.settleFailure")(function* (
    error: IssueOperationError,
    context: StartContext & { readonly decided: Ref.Ref<Decision | null> },
  ) {
    // Whole, so an interruption cannot leave a known failure half settled.
    const { decision, failure } = yield* Effect.uninterruptible(settle(error, context));
    yield* Ref.set(context.decided, decision);
    return yield* failure ?? error;
  });

  /** Fails the run a launch left preparing with no preparation scheduled, so its thread shows it. */
  const failStrandedRun = Effect.fn("PlaybookStartService.failStrandedRun")(function* (
    threadId: ThreadId,
    { commandId, messageId }: ReturnType<typeof startIds>,
    detail: string,
  ) {
    yield* threads.getThreadRecords(threadId, ["messages"], { messageIds: [messageId] }).pipe(
      Effect.flatMap(({ messages }) => {
        const runId = messages.find((message) => message.id === messageId)?.runId ?? null;
        return runId === null
          ? Effect.void
          : threads.dispatch({
              type: "prepared-run.fail",
              commandId: CommandId.make(`${commandId}:start-failed`),
              threadId,
              runId,
              failure: makeProviderFailure({
                message: detail,
                class: "unknown",
                retryable: true,
              }),
            });
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("A failed Start could not fail its thread's run", { threadId, cause }),
      ),
    );
  });

  /** What a new thread for the issue launches with, as the MCP launch resolves a project's. */
  const launchSettings = Effect.fn("PlaybookStartService.launchSettings")(function* (
    playbook: IssuePlaybook,
    entry: IssueBoardEntry,
    project: Project,
    onSeveral: "fail" | "root",
  ) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => fail("The server settings could not be read.", cause)),
      ),
      project.id,
      project,
    ).settings;
    const modelSelection =
      playbook.modelSelection ??
      resolveNewThreadModelSelection({
        defaultSelection: settings.defaultModelSelection,
        fallbackSelection: settings.fallbackModelSelection,
        providers: yield* providers.getProviders,
        settings,
        projectId: project.id,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      }).selection;
    if (modelSelection === null) {
      return yield* fail(
        `The project has no default model, so playbook ${playbook.name} must name a modelSelection.`,
      );
    }
    const worktreeConfig = issueWorktreeConfig(settings, entry.scope);
    const workspaceStrategy = yield* issueWorkspace
      .strategy({
        entry,
        project,
        requiresWorktree: playbook.requiresWorktree === true,
        startFromOrigin: settings.newWorktreesStartFromOrigin,
        baseBranch: worktreeConfig.baseBranch,
        onSeveral,
      })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "IssueWorktreeError"
            ? fail(cause.detail, cause)
            : fail("The issue's worktree could not be checked.", cause),
        ),
      );
    return {
      modelSelection,
      runtimeMode: playbook.runtimeMode ?? settings.defaultRuntimeMode,
      interactionMode: playbook.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      workspaceStrategy,
      worktreeConfig,
    };
  });

  const sendOrLaunch = Effect.fn("PlaybookStartService.sendOrLaunch")(function* (
    playbook: IssuePlaybook,
    entry: IssueBoardEntry,
    project: Project,
    id: string,
    decided: Ref.Ref<Decision | null>,
  ) {
    const open = yield* threadLinks.listOpen.pipe(
      Effect.mapError((cause) => fail("The issue's threads could not be read.", cause)),
    );
    const frameId = Buffer.from(yield* random.randomBytes(6)).toString("hex");
    const { commandId, messageId } = startIds(id);
    const text = renderPlaybookPrompt(playbook.prompt, entry, frameId);

    const thread = open.get(IssueThreadLinks.issueThreadKey(entry));
    if (thread !== undefined) {
      // The thread keeps its own model and modes; a running turn finishes first.
      yield* threads
        .sendToThread({
          projectId: thread.projectId,
          commandId,
          threadId: thread.threadId,
          messageId,
          text,
          attachments: [],
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError((cause) =>
            fail("The prompt could not be sent to the issue's open thread.", cause),
          ),
          Effect.catch((error) =>
            settleFailure(error, { id, entry, projectId: project.id, decided }),
          ),
        );
      return { threadId: thread.threadId };
    }

    const settings = yield* launchSettings(playbook, entry, project, "fail");
    const { modelSelection, runtimeMode, interactionMode } = settings;
    // The issue's new worktree takes the project's names, checked before anything is made.
    const workspaceStrategy =
      settings.workspaceStrategy.type === "worktree"
        ? {
            ...settings.workspaceStrategy,
            ...(yield* issueWorkspace
              .names({ entry, project, config: settings.worktreeConfig })
              .pipe(Effect.mapError((cause) => fail(cause.detail, cause)))),
          }
        : settings.workspaceStrategy;
    yield* launches
      .checkWorktreeBase({ projectId: project.id, workspaceStrategy })
      .pipe(Effect.mapError((cause) => fail(cause.message, cause)));

    const { threadId } = yield* launches
      .launch({
        commandId,
        projectId: project.id,
        title: `${entry.displayKey} ${entry.title}`,
        modelSelection,
        runtimeMode,
        interactionMode,
        workspaceStrategy,
        initialMessage: { messageId, text, attachments: [] },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError((cause) => fail(launchFailure(cause), cause)),
        Effect.catch((error) =>
          settleFailure(error, { id, entry, projectId: project.id, decided }),
        ),
      );
    // The thread holds the prompt, so the issue stays started even when it cannot be linked.
    yield* linkThread(threadId, entry, project.id).pipe(
      Effect.tapError(() => Ref.set(decided, "keep")),
      Effect.mapError((cause) =>
        fail(
          `Thread "${launchedTitle(entry)}" started, but it could not be linked to the issue.`,
          cause,
        ),
      ),
    );
    return { threadId };
  });

  const findPlaybook = Effect.fn("PlaybookStartService.findPlaybook")(function* (name: string) {
    const { playbooks, errors } = yield* readPlaybooksFile(playbooksPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    const playbook = playbooks.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (playbook === undefined) {
      return yield* fail(`Playbook ${name} is not in ${PLAYBOOKS_FILE}, or it has a mistake.`);
    }
    return { playbook, errors };
  });

  const projectOf = Effect.fn("PlaybookStartService.projectOf")(function* (entry: IssueBoardEntry) {
    if (entry.projectId === null) return yield* fail(`No T3 Code project is for ${entry.scope}.`);
    const project = yield* projects
      .getById(entry.projectId)
      .pipe(Effect.mapError((cause) => fail("The project could not be read.", cause)));
    if (Option.isNone(project)) return yield* fail("The issue's project no longer exists.");
    return project.value;
  });

  // The hold is decided from the server's own latest read; after a restart, read the boards first.
  const latestRead = Effect.gen(function* () {
    const latest = yield* issues.withLatestBoard(Effect.succeed);
    if (latest !== null) return latest;
    return yield* issues.board.pipe(
      Effect.mapError((cause) => fail("The boards could not be read.", cause)),
    );
  });

  const heldFailure = (entry: IssueBoardEntry, blockers: IssueBoardEntry["blockers"]) =>
    fail(
      `${entry.displayKey} waits for ${blockers.map((blocker) => blocker.displayKey).join(", ")} to close, so it cannot start before then.`,
    );

  /** Refuses a start the issue's board holds for an open blocker (jehhynes/t3code#65). */
  const refuseHeld = Effect.fn("PlaybookStartService.refuseHeld")(function* (
    playbook: string,
    entry: IssueBoardEntry,
  ) {
    const blockers = heldIn(yield* latestRead, IssueThreadLinks.issueThreadKey(entry), playbook);
    if (blockers.length > 0) return yield* heldFailure(entry, blockers);
  });

  const cancelQueued = Effect.fn("PlaybookStartService.cancelQueued")(function* (
    playbook: string,
    entry: IssueBoardEntry,
  ) {
    const cancelled = yield* entries
      .setQueued({
        issueKey: IssueThreadLinks.issueThreadKey(entry),
        playbook,
        queued: false,
        now: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        Effect.mapError((cause) => fail("Which issues wait for Start could not be saved.", cause)),
      );
    if (!cancelled) {
      return yield* fail(
        `This issue is not waiting for playbook ${playbook}; refresh the Issues page.`,
      );
    }
    yield* issues.refreshWaiting.pipe(Effect.ignoreCause({ log: true }));
    return { threadId: null };
  });

  const start: PlaybookStartService["Service"]["start"] = Effect.fn("PlaybookStartService.start")(
    function* (input, options) {
      if ("cancelQueued" in input) return yield* cancelQueued(input.playbook, input.cancelQueued);
      const { playbook: selection, entry: requested } = input;
      const auto = options?.auto === true;
      const { playbook, errors } = yield* findPlaybook(selection);
      // A mistake can hand a playbook issues that are not its own, so nothing starts by itself.
      if (auto && errors.length > 0) {
        return yield* fail(`Playbook ${playbook.name} does not start by itself now.`);
      }
      if (requested.projectId === null) {
        return yield* fail(`No T3 Code project is for ${requested.scope}.`);
      }
      if (!auto) yield* latestRead;
      // Fork-only (jehhynes/t3code#76): every start but a draft's waits for a free slot.
      return yield* slots
        .whenFree((free) => startWithSlot(playbook, requested, auto, free))
        .pipe(
          Effect.mapError((error) =>
            isSlotsError(error)
              ? fail("Which issue threads are running could not be read.", error.cause)
              : error,
          ),
        );
    },
  );

  const startWithSlot = Effect.fn("PlaybookStartService.startWithSlot")(function* (
    playbook: IssuePlaybook,
    requested: IssueBoardEntry,
    auto: boolean,
    free: boolean,
  ) {
    // Claiming the entry makes a second Start of it, from any client, refuse. Every step that
    // can fail comes after it, so a failed start by the server itself counts as its one try.
    const id = yield* random.uuidV4();
    const decided = yield* Ref.make<Decision | null>(null);
    const claim = {
      issueKey: IssueThreadLinks.issueThreadKey(requested),
      startedBy: `issue-playbook:${id}`,
    };
    const saveError = (cause: unknown) =>
      fail("Which issues wait for Start could not be saved.", cause);
    const claimEntry = entries
      .claim({
        ...claim,
        playbook: playbook.name,
        auto,
        selfStarting: playbook.autoStart === true,
      })
      .pipe(Effect.mapError(saveError));
    // Decided against the latest read under its lock, so no read publishes in between. By
    // itself, only while that read still lists the issue waiting, unheld: a newer read may have
    // found a mistake, an unreadable account, an open blocker, or the board off or failed.
    // "waits": a start by itself found no free slot, and nothing changed (jehhynes/t3code#76).
    type Claimed = IssueBoardEntry | "queued" | "waits" | null;
    const now = DateTime.formatIso(yield* DateTime.now);
    const claimed = issues.withLatestBoard(
      (latest): Effect.Effect<Claimed, IssueOperationError> => {
        const held = heldIn(latest, claim.issueKey, playbook.name).length > 0;
        if (auto) {
          const current = entryWaitingIn(latest, claim.issueKey, playbook.name);
          if (current === undefined || current.projectId === null || held) {
            return Effect.succeed(null);
          }
          // No try is spent: it starts once a slot frees.
          if (!free) return Effect.succeed("waits");
          return claimEntry.pipe(Effect.map((ok) => (ok ? current : null)));
        }
        // A held issue starts by itself once its blockers close, or once a slot frees.
        if (held || !free) {
          return entries
            .setQueued({ issueKey: claim.issueKey, playbook: playbook.name, queued: true, now })
            .pipe(
              Effect.mapError(saveError),
              Effect.map((ok) => (ok ? ("queued" as const) : null)),
            );
        }
        return claimEntry.pipe(Effect.map((ok) => (ok ? requested : null)));
      },
    );
    // Acquired uninterruptibly, so an interrupted Start cannot keep a claim it never used.
    return yield* Effect.acquireUseRelease(
      claimed,
      (entry): Effect.Effect<IssuePlaybookStartResult, IssueOperationError> =>
        entry === "queued" || entry === "waits"
          ? Effect.succeed({ threadId: null })
          : entry !== null && entry.projectId !== null
            ? projects.getById(entry.projectId).pipe(
                Effect.mapError((cause) => fail("The project could not be read.", cause)),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(fail("The issue's project no longer exists.")),
                    onSome: (project) => sendOrLaunch(playbook, entry, project, id, decided),
                  }),
                ),
              )
            : Effect.fail(
                fail(
                  `This issue is not waiting for playbook ${playbook.name}; refresh the Issues page.`,
                ),
              ),
      // A Start that fails or is interrupted before its thread holds the prompt leaves the issue
      // waiting, with the failure's cause. Either way every client is shown the entry as it now
      // is before Start answers.
      (entry, exit) =>
        entry === null || entry === "waits"
          ? Effect.void
          : (Exit.isFailure(exit) && entry !== "queued"
              ? Effect.gen(function* () {
                  // Set by a failure that settled; an interruption or a defect settles here.
                  const decision =
                    (yield* Ref.get(decided)) ??
                    (entry.projectId === null
                      ? "release"
                      : (yield* settle(null, { id, entry, projectId: entry.projectId })).decision);
                  if (decision === "keep") return;
                  yield* entries
                    .release({
                      ...claim,
                      failure: Cause.findErrorOption(exit.cause).pipe(
                        Option.map((error) => error.detail),
                        Option.getOrNull,
                      ),
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logError("A failed Start left its issue started", {
                          ...claim,
                          cause,
                        }),
                      ),
                    );
                })
              : Effect.void
            ).pipe(Effect.andThen(issues.refreshWaiting.pipe(Effect.ignoreCause({ log: true })))),
    );
  });

  const prepareDraft: PlaybookStartService["Service"]["prepareDraft"] = Effect.fn(
    "PlaybookStartService.prepareDraft",
  )(function* ({ playbook: selection, entry, use }) {
    yield* refuseHeld(selection, entry);
    const { playbook } = yield* findPlaybook(use ?? selection);
    const project = yield* projectOf(entry);
    const open = yield* threadLinks.listOpen.pipe(
      Effect.mapError((cause) => fail("The issue's threads could not be read.", cause)),
    );
    const frameId = Buffer.from(yield* random.randomBytes(6)).toString("hex");
    const prompt = renderPlaybookPrompt(playbook.prompt, entry, frameId);
    // As Start does, the open thread keeps its own model, modes and folder.
    const thread = open.get(IssueThreadLinks.issueThreadKey(entry));
    if (thread !== undefined) return { prompt, threadId: thread.threadId };
    const { modelSelection, runtimeMode, workspaceStrategy } = yield* launchSettings(
      playbook,
      entry,
      project,
      // Several worktrees named for the issue: the draft opens in Local mode, whose branch picker
      // binds the one I pick.
      "root",
    );
    return { prompt, threadId: null, modelSelection, runtimeMode, workspace: workspaceStrategy };
  });

  // Fork-only (jehhynes/t3code#35): the thread whose next composer message starts each issue,
  // with the messages it already had, which an edit or a promotion would update again.
  const startsOnSend = new Map<
    ThreadId,
    { readonly input: IssuePlaybookStartOnSendInput; readonly earlier: ReadonlySet<MessageId> }
  >();

  const startOnSend: PlaybookStartService["Service"]["startOnSend"] = Effect.fn(
    "PlaybookStartService.startOnSend",
  )(function* (input) {
    if (input.entry.projectId === null) {
      return yield* fail(`No T3 Code project is for ${input.entry.scope}.`);
    }
    yield* refuseHeld(input.playbook, input.entry);
    const { messages } = yield* threads
      .getThreadRecords(input.threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(
        // A draft's thread does not exist yet, so it has no messages.
        Effect.catchIf(
          (error) => "cause" in error && isThreadNotFound(error.cause),
          () => Effect.succeed({ messages: [] }),
        ),
        Effect.mapError((cause) => fail("The thread's messages could not be read.", cause)),
      );
    startsOnSend.set(input.threadId, {
      input,
      earlier: new Set(messages.map((message) => message.id)),
    });
    // Worked out when the draft is sent, so the names are free then.
    const entry = input.entry;
    yield* issueWorktrees.recordDraft(input.threadId, (launch) =>
      Effect.gen(function* () {
        const project = yield* projectOf(entry).pipe(
          Effect.mapError(
            (cause) => new IssueWorktrees.IssueWorktreeError({ detail: cause.detail }),
          ),
        );
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            (cause) =>
              new IssueWorktrees.IssueWorktreeError({
                detail: "The server settings could not be read.",
                cause,
              }),
          ),
        );
        const named = yield* issueWorkspace.names({
          entry,
          project,
          config: issueWorktreeConfig(settings, entry.scope),
        });
        // The draft's own base, which I may have changed in the draft, as Start checks its base.
        yield* launches
          .checkWorktreeBase(launch)
          .pipe(
            Effect.mapError(
              (cause) => new IssueWorktrees.IssueWorktreeError({ detail: cause.message, cause }),
            ),
          );
        return named;
      }),
    );
  });

  /** Claims the entry as Start would; a thread sent after another start stays an ordinary thread. */
  const startSent = Effect.fn("PlaybookStartService.startSent")(function* ({
    playbook,
    entry,
    threadId,
  }: IssuePlaybookStartOnSendInput) {
    const issueKey = IssueThreadLinks.issueThreadKey(entry);
    // A draft sent once its issue became held starts nothing for the issue (jehhynes/t3code#65).
    const claimed = yield* issues.withLatestBoard((latest) =>
      heldIn(latest, issueKey, playbook).length > 0
        ? Effect.succeed(false)
        : entries.claim({ issueKey, playbook, startedBy: `issue-playbook-draft:${threadId}` }),
    );
    if (!claimed) {
      return yield* Effect.logInfo(
        "A sent draft's issue was no longer waiting, or waits for its blockers",
        {
          issue: issueKey,
          threadId,
        },
      );
    }
    // The thread holds the prompt, so the issue stays started even when it cannot be linked.
    if (entry.projectId !== null) {
      yield* linkThread(threadId, entry, entry.projectId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A sent draft's thread could not be linked to its issue", {
            issue: issueKey,
            threadId,
            cause,
          }),
        ),
      );
    }
    yield* issues.refreshWaiting.pipe(Effect.ignoreCause({ log: true }));
  });

  const worker = yield* makeDrainableWorker(startSent);

  // Untraced: it sees every domain event, and a match is traced by `startSent`.
  const handleEvent: PlaybookStartService["Service"]["handleEvent"] = Effect.fnUntraced(
    function* (event) {
      yield* slots.observe(event); // Fork-only (jehhynes/t3code#76)
      if (event.type !== "message.updated" || !isComposerMessage(event.payload)) return;
      const pending = startsOnSend.get(event.threadId);
      if (pending === undefined || pending.earlier.has(event.payload.id)) return;
      startsOnSend.delete(event.threadId);
      yield* issueWorktrees.forgetDraft(event.threadId);
      yield* worker.enqueue(pending.input);
    },
  );

  return PlaybookStartService.of({
    start,
    prepareDraft,
    startOnSend,
    handleEvent,
    drain: worker.drain,
    awaitFreedSlot: slots.awaitFreed,
  });
});

export const layer = Layer.effect(PlaybookStartService, make);
