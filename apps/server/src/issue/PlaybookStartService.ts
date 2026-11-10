// Fork-only: Start runs a playbook for a board issue that waits (jehhynes/t3code#6, #7).
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IssueOperationError,
  MessageId,
  type IssueBoardEntry,
  type IssuePlaybook,
  type IssuePlaybookStartInput,
  type IssuePlaybookStartResult,
  type Project,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueService from "./IssueService.ts";
import { entryWaitingIn } from "./playbookEntries.ts";
import { renderPlaybookPrompt } from "./playbookPrompt.ts";
import { PLAYBOOKS_FILE, readPlaybooksFile } from "./playbookSelection.ts";

export class PlaybookStartService extends Context.Service<
  PlaybookStartService,
  {
    /**
     * Sends the playbook's prompt to the issue's open thread, or launches the playbook's thread in
     * the issue's project and links it to the issue. Only an issue waiting with that playbook.
     */
    readonly start: (
      input: IssuePlaybookStartInput,
      options?: {
        /**
         * A start by the server itself: only a playbook that starts by itself while
         * `playbooks.json` has no mistake, and only an entry not tried before.
         */
        readonly auto?: boolean;
      },
    ) => Effect.Effect<IssuePlaybookStartResult, IssueOperationError>;
  }
>()("t3/issue/PlaybookStartService") {}

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

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
  const playbooksPath = path.join(path.dirname(config.settingsPath), PLAYBOOKS_FILE);

  const fail = (detail: string, cause?: unknown) =>
    new IssueOperationError({
      operation: "startPlaybook",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const sendOrLaunch = Effect.fn("PlaybookStartService.sendOrLaunch")(function* (
    playbook: IssuePlaybook,
    entry: IssueBoardEntry,
    project: Project,
    id: string,
  ) {
    const open = yield* threadLinks.listOpen.pipe(
      Effect.mapError((cause) => fail("The issue's threads could not be read.", cause)),
    );
    const frameId = Buffer.from(yield* random.randomBytes(6)).toString("hex");
    const commandId = CommandId.make(`issue-playbook:${id}`);
    const messageId = MessageId.make(`issue-playbook-message:${id}`);
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
        );
      return { threadId: thread.threadId };
    }

    // What a new thread in the project would take, as the MCP launch resolves it.
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

    const { threadId } = yield* launches
      .launch({
        commandId,
        projectId: project.id,
        title: `${entry.displayKey} ${entry.title}`,
        modelSelection,
        runtimeMode: playbook.runtimeMode ?? settings.defaultRuntimeMode,
        interactionMode: playbook.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId, text, attachments: [] },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError((cause) => fail(launchFailure(cause), cause)));
    yield* threadIssues
      .link({
        threadId,
        ref: {
          projectId: project.id,
          tracker: entry.tracker,
          host: entry.host,
          scope: entry.scope,
          key: entry.key,
        },
        url: entry.url,
        source: "manual",
      })
      .pipe(
        Effect.mapError((cause) =>
          fail("The thread started but could not be linked to the issue.", cause),
        ),
      );
    return { threadId };
  });

  const start: PlaybookStartService["Service"]["start"] = Effect.fn("PlaybookStartService.start")(
    function* ({ playbook: name, entry: requested }, options) {
      const auto = options?.auto === true;
      const { playbooks, errors } = yield* readPlaybooksFile(playbooksPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const playbook = playbooks.find(
        (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
      );
      if (playbook === undefined) {
        return yield* fail(`Playbook ${name} is not in ${PLAYBOOKS_FILE}, or it has a mistake.`);
      }
      // A mistake can hand a playbook issues that are not its own, so nothing starts by itself.
      if (auto && (errors.length > 0 || playbook.autoStart !== true)) {
        return yield* fail(`Playbook ${playbook.name} does not start by itself now.`);
      }
      if (requested.projectId === null) {
        return yield* fail(`No T3 Code project is for ${requested.scope}.`);
      }

      // Claiming the entry makes a second Start of it, from any client, refuse. Every step that
      // can fail comes after it, so a failed start by the server itself counts as its one try.
      const id = yield* random.uuidV4();
      const claim = {
        issueKey: IssueThreadLinks.issueThreadKey(requested),
        startedBy: `issue-playbook:${id}`,
      };
      const claimEntry = entries
        .claim({ ...claim, playbook: playbook.name, auto })
        .pipe(
          Effect.mapError((cause) =>
            fail("Which issues wait for Start could not be saved.", cause),
          ),
        );
      // By itself, only while the latest read still lists the issue waiting: a newer read may have
      // found a mistake, an unreadable account, or the board off or failed.
      const claimed: Effect.Effect<IssueBoardEntry | null, IssueOperationError> = auto
        ? issues.withLatestBoard((latest) => {
            const current = entryWaitingIn(latest, claim.issueKey, playbook.name);
            return current === undefined || current.projectId === null
              ? Effect.succeed(null)
              : claimEntry.pipe(Effect.map((ok) => (ok ? current : null)));
          })
        : claimEntry.pipe(Effect.map((ok) => (ok ? requested : null)));
      // Acquired uninterruptibly, so an interrupted Start cannot keep a claim it never used.
      return yield* Effect.acquireUseRelease(
        claimed,
        (entry) =>
          entry !== null && entry.projectId !== null
            ? projects.getById(entry.projectId).pipe(
                Effect.mapError((cause) => fail("The project could not be read.", cause)),
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(fail("The issue's project no longer exists.")),
                    onSome: (project) => sendOrLaunch(playbook, entry, project, id),
                  }),
                ),
              )
            : Effect.fail(
                fail(
                  `This issue is not waiting for playbook ${playbook.name}; refresh the Issues page.`,
                ),
              ),
        // A Start that fails or is interrupted leaves the issue waiting. Either way every client
        // is shown the entry as it now is before Start answers.
        (entry, exit) =>
          entry === null
            ? Effect.void
            : (Exit.isFailure(exit)
                ? entries.release(claim).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError("A failed Start left its issue started", {
                        ...claim,
                        cause,
                      }),
                    ),
                  )
                : Effect.void
              ).pipe(Effect.andThen(issues.refreshWaiting.pipe(Effect.ignoreCause({ log: true })))),
      );
    },
  );

  return PlaybookStartService.of({ start });
});

export const layer = Layer.effect(PlaybookStartService, make);
