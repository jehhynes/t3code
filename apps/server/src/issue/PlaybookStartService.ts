// Fork-only: Start launches a playbook's thread for a board issue (jehhynes/t3code#6).
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  IssueOperationError,
  MessageId,
  type IssuePlaybookStartInput,
  type IssuePlaybookStartResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../orchestration-v2/Orchestrator.ts";
import type { ThreadManagementProviderInstanceDisabledError } from "../orchestration-v2/ThreadManagementService.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { renderPlaybookPrompt } from "./playbookPrompt.ts";
import { PLAYBOOKS_FILE, readPlaybooksFile } from "./playbookSelection.ts";

export class PlaybookStartService extends Context.Service<
  PlaybookStartService,
  {
    /** Launches the playbook's thread in the issue's project, then links it to the issue. */
    readonly start: (
      input: IssuePlaybookStartInput,
    ) => Effect.Effect<IssuePlaybookStartResult, IssueOperationError>;
  }
>()("t3/issue/PlaybookStartService") {}

const isAboveCeilingError = Schema.is(OrchestratorRuntimeModeAboveCeilingError);

function launchFailure(
  error: ThreadLaunchService.ThreadLaunchError | ThreadManagementProviderInstanceDisabledError,
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
  const random = yield* SecureRandom.SecureRandom;
  const playbooksPath = path.join(path.dirname(config.settingsPath), PLAYBOOKS_FILE);

  const fail = (detail: string, cause?: unknown) =>
    new IssueOperationError({
      operation: "startPlaybook",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const start: PlaybookStartService["Service"]["start"] = Effect.fn("PlaybookStartService.start")(
    function* ({ playbook: name, entry }) {
      const { playbooks } = yield* readPlaybooksFile(playbooksPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const playbook = playbooks.find(
        (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
      );
      if (playbook === undefined) {
        return yield* fail(`Playbook ${name} is not in ${PLAYBOOKS_FILE}, or it has a mistake.`);
      }
      const projectId = entry.projectId;
      if (projectId === null) {
        return yield* fail(`No T3 Code project is for ${entry.scope}.`);
      }
      const project = Option.getOrUndefined(
        yield* projects
          .getById(projectId)
          .pipe(Effect.mapError((cause) => fail("The project could not be read.", cause))),
      );
      if (project === undefined) return yield* fail("The issue's project no longer exists.");
      const open = yield* threadLinks.listOpen.pipe(
        Effect.mapError((cause) => fail("The issue's threads could not be read.", cause)),
      );
      if (open.has(IssueThreadLinks.issueThreadKey(entry))) {
        return yield* fail("This issue already has an open thread.");
      }

      // What a new thread in the project would take, as the MCP launch resolves it.
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) => fail("The server settings could not be read.", cause)),
        ),
        projectId,
        project,
      ).settings;
      const modelSelection =
        playbook.modelSelection ??
        resolveNewThreadModelSelection({
          defaultSelection: settings.defaultModelSelection,
          fallbackSelection: settings.fallbackModelSelection,
          providers: yield* providers.getProviders,
          settings,
          projectId,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        }).selection;
      if (modelSelection === null) {
        return yield* fail(
          `The project has no default model, so playbook ${playbook.name} must name a modelSelection.`,
        );
      }

      const id = yield* random.uuidV4();
      const frameId = Buffer.from(yield* random.randomBytes(6)).toString("hex");
      const { threadId } = yield* launches
        .launch({
          commandId: CommandId.make(`issue-playbook:${id}`),
          projectId,
          title: `${entry.displayKey} ${entry.title}`,
          modelSelection,
          runtimeMode: playbook.runtimeMode ?? settings.defaultRuntimeMode,
          interactionMode: playbook.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`issue-playbook-message:${id}`),
            text: renderPlaybookPrompt(playbook.prompt, entry, frameId),
            attachments: [],
          },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError((cause) => fail(launchFailure(cause), cause)));
      yield* threadIssues
        .link({
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
        })
        .pipe(
          Effect.mapError((cause) =>
            fail("The thread started but could not be linked to the issue.", cause),
          ),
        );
      return { threadId };
    },
  );

  return PlaybookStartService.of({ start });
});

export const layer = Layer.effect(PlaybookStartService, make);
