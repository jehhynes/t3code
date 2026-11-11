// A project bound to a standalone tracker (Linear) in settings lists it beside its git host's.
// References outside the project's canonical repository may be read on the same host,
// but every write must pass through requireWritable.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  IssueOperationError,
  IssueTrackerKind,
  IssueUnavailableError,
  type IssueBoard,
  type IssueBoardResult,
  type IssueBoardSetEnabledInput,
  type IssueCandidates,
  type IssueCommentInput,
  type IssueCommentsPage,
  type IssueCommentsPageInput,
  type IssueCreateInput,
  type IssueCreateResult,
  type IssueDetail,
  type IssueError,
  type IssueListEntry,
  type IssueListInput,
  type IssueListProjectError,
  type IssueListResult,
  type IssueReactionInput,
  type IssueRef,
  type IssueScopeRef,
  type IssueSetStateInput,
  type IssueTemplateList,
  type IssueTrackerSummary,
  type IssueUpdateInput,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";
import {
  IssueTrackerError,
  isStandaloneIssueTracker,
  type IssueTrackerApi,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ServerConfig from "../config.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";
import * as IssueBoardSources from "../persistence/IssueBoardSources.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import { readBoards } from "./issueBoard.ts";
import {
  reconcilePlaybookEntries,
  recordedByBoard,
  selfStartingPlaybooks, // Fork-only (jehhynes/t3code#65)
  waitingFields,
} from "./playbookEntries.ts";
import {
  PLAYBOOKS_FILE,
  needsViewer,
  readPlaybooksFile,
  selectPlaybook,
} from "./playbookSelection.ts";

const DEFAULT_LIST_LIMIT = 50;
/** How old a board read may be when a client subscribes, as the page's query once allowed. */
const BOARD_FRESH_MILLIS = 30_000;
const GITHUB = IssueTrackerKind.make("github");
const GITHUB_HOST = "github.com";
const SCOPE_CONCURRENCY = 4;

const interactive =
  <I, A>(call: (input: I) => Effect.Effect<A, IssueError>) =>
  (input: I) =>
    call(input).pipe(Effect.provideService(SourceControlRateLimit.Interactive, true));

const traced =
  <I, A>(operation: string, call: (input: I) => Effect.Effect<A, IssueError>) =>
  (input: I) =>
    call(input).pipe(Effect.withSpan(`IssueService.${operation}`));

/** A tracker may fail with no detail; the wire errors carry a non-empty one. */
export function trackerDetail(error: IssueTrackerError): string {
  return error.detail.trim() || "The issue tracker request failed.";
}

/** One project's resolved tracker: which driver, where it is served from, and its container. */
interface ProjectTrackerBinding {
  readonly canonicalKey: string;
  readonly tracker: IssueTrackerKind;
  readonly host: string;
  readonly scope: string;
}

/** A project the registry has a tracker for, ready to serve reads and writes. */
interface SupportedProject extends ProjectTrackerBinding {
  readonly project: OrchestrationProjectShell;
  readonly api: IssueTrackerApi;
}

/**
 * Azure work items belong to the project, not the repository, so the scope is
 * `organization/project` out of the remote's `organization/project/_git/repository` path. The
 * source control selector answers only the repository name there, which addresses no work item.
 */
function azureDevOpsProjectScope(displayName: string | undefined): string | null {
  const segments = (displayName ?? "").split("/").filter((part) => part.length > 0);
  const marker = segments.indexOf("_git");
  const [organization, project] = marker === 2 ? segments : [];
  return organization && project ? `${organization}/${project}` : null;
}

/**
 * The git-host path of resolution: the tracker is the host's own, named like the remote's
 * provider kind. Null for a project with no remote or a kind no tracker claims.
 */
export function resolveGitHostBinding(
  project: OrchestrationProjectShell,
): ProjectTrackerBinding | null {
  const identity = project.repositoryIdentity;
  const scope =
    identity?.provider === "azure-devops"
      ? azureDevOpsProjectScope(identity.displayName)
      : sourceControlDefinitions.repositorySelector(identity);
  const kind = identity?.provider;
  if (!identity || kind === undefined || kind === "unknown" || scope === null) return null;
  const host = sourceControlDefinitions.changeRequestHost(identity, kind);
  return {
    // Every repository of an Azure DevOps project shares its work items.
    canonicalKey:
      kind === "azure-devops" ? `${host}/${scope}`.toLowerCase() : identity.canonicalKey,
    tracker: IssueTrackerKind.make(kind),
    host,
    scope,
  };
}

function listCursorKey(host: string, scope: string): string {
  return `${host} ${scope}`;
}

function isTrackerUnusable(error: IssueTrackerError): boolean {
  return error.reason === "missing-tool" || error.reason === "unauthenticated";
}

function toIssueError(operation: string): (error: IssueTrackerError) => IssueError {
  return (error) =>
    isTrackerUnusable(error)
      ? new IssueUnavailableError({
          reason: error.reason === "missing-tool" ? "tool-missing" : "unauthenticated",
          tracker: error.tracker,
          cause: error,
        })
      : new IssueOperationError({
          operation,
          detail: trackerDetail(error),
          ...(error.reason === "not-found" || error.reason === "rate-limited"
            ? { reason: error.reason }
            : {}),
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
          cause: error,
        });
}

const readOnly = (operation: string) =>
  new IssueOperationError({
    operation,
    reason: "read-only",
    detail:
      "This issue belongs to a repository outside the selected project and cannot be changed from here.",
  });

const unsupported = (operation: string, what: string) =>
  new IssueOperationError({ operation, detail: `This tracker does not support ${what}.` });

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    /**
     * Every open issue on each GitHub board named in settings, with its project or none. A call
     * while a read runs shares that read rather than starting another.
     */
    readonly board: Effect.Effect<IssueBoardResult, IssueError>;
    /** The latest board result, then each later one; reads the boards first when none exists. */
    readonly subscribeBoard: Stream.Stream<IssueBoardResult, IssueError>;
    /** Each board result as it is published, from any read; never reads by itself. */
    readonly boardChanges: Stream.Stream<IssueBoardResult>;
    /** Runs `use` with the latest result while no other result can be published. */
    readonly withLatestBoard: <A, E, R>(
      use: (latest: IssueBoardResult | null) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    /** Publishes the latest result again with which issues wait and have threads now. */
    readonly refreshWaiting: Effect.Effect<void, IssueError>;
    /** Turns a board that settings name on or off; the server keeps this, not settings. */
    readonly setBoardEnabled: (input: IssueBoardSetEnabledInput) => Effect.Effect<void, IssueError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueError>;
    readonly comments: (
      input: IssueCommentsPageInput,
    ) => Effect.Effect<IssueCommentsPage, IssueError>;
    readonly templates: (input: IssueScopeRef) => Effect.Effect<IssueTemplateList, IssueError>;
    readonly candidates: (input: IssueScopeRef) => Effect.Effect<IssueCandidates, IssueError>;
    readonly create: (input: IssueCreateInput) => Effect.Effect<IssueCreateResult, IssueError>;
    readonly comment: (input: IssueCommentInput) => Effect.Effect<void, IssueError>;
    readonly update: (input: IssueUpdateInput) => Effect.Effect<void, IssueError>;
    readonly setState: (input: IssueSetStateInput) => Effect.Effect<void, IssueError>;
    readonly react: (input: IssueReactionInput) => Effect.Effect<void, IssueError>;
    /**
     * The reference behind an issue URL: served by the project whose binding is that host and
     * scope, else read-only through any project on the same tracker and host. `preferredProjectId`
     * wins among equals, so a thread's own project serves its own issues.
     */
    readonly resolveUrl: (
      url: string,
      preferredProjectId?: ProjectId,
    ) => Effect.Effect<
      IssueRef & { readonly host: string; readonly writable: boolean },
      IssueError
    >;
  }
>()("t3/issue/IssueService") {}

const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const boardSources = yield* IssueBoardSources.IssueBoardSourcesRepository;
  const threadLinks = yield* IssueThreadLinks.IssueThreadLinksRepository;
  const playbookEntries = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const playbooksPath = path.join(path.dirname(config.settingsPath), PLAYBOOKS_FILE);

  // Read per resolution so a binding saved in Settings applies without a restart.
  const resolveStandaloneBinding = (
    project: OrchestrationProjectShell,
  ): Effect.Effect<ProjectTrackerBinding | null> =>
    bindings.list.pipe(
      Effect.map((bound) => {
        const binding = bound.get(project.id);
        const api = binding === undefined ? null : registry.get(binding.tracker);
        if (binding === undefined || api === null || !isStandaloneIssueTracker(api)) return null;
        return {
          canonicalKey: `${binding.tracker}:${api.standalone.host}/${binding.scope}`.toLowerCase(),
          tracker: binding.tracker,
          host: api.standalone.host,
          scope: binding.scope,
        };
      }),
      Effect.orElseSucceed(() => null),
    );

  /** Where a project's issues live: its git host's tracker, its bound standalone one, or both. */
  const resolveProjectTracker = (
    project: OrchestrationProjectShell,
  ): Effect.Effect<ReadonlyArray<ProjectTrackerBinding>> =>
    Effect.all([
      (project.repositoryIdentity != null
        ? Effect.succeed(project.repositoryIdentity)
        : repositoryIdentities.resolve(project.workspaceRoot)
      ).pipe(
        Effect.map((repositoryIdentity) =>
          resolveGitHostBinding({ ...project, repositoryIdentity }),
        ),
      ),
      resolveStandaloneBinding(project),
    ]).pipe(Effect.map((resolved) => resolved.filter((binding) => binding !== null)));

  const listProjects = (filter: {
    readonly projectId?: IssueListInput["projectId"];
    readonly host?: string | undefined;
  }) =>
    (filter.projectId === undefined
      ? projects.listShells()
      : projects.getShell(filter.projectId).pipe(Effect.map(Option.toArray))
    ).pipe(
      Effect.mapError(
        (cause) =>
          new IssueOperationError({
            operation: "listProjects",
            detail: "The project list could not be read.",
            cause,
          }),
      ),
      Effect.flatMap((shells) =>
        Effect.forEach(
          shells,
          (project) =>
            resolveProjectTracker(project).pipe(
              Effect.map((bindings) => bindings.map((binding) => ({ project, ...binding }))),
            ),
          { concurrency: SCOPE_CONCURRENCY },
        ),
      ),
      Effect.map((bound) => {
        const host = filter.host?.trim().toLowerCase();
        const supported: SupportedProject[] = [];
        const unimplemented = new Map<
          string,
          { tracker: IssueTrackerKind; projectCount: number }
        >();
        for (const candidate of bound.flat()) {
          if (host !== undefined && candidate.host !== host) continue;
          const api = registry.get(candidate.tracker);
          if (api === null) {
            const counted = unimplemented.get(candidate.host);
            if (counted === undefined)
              unimplemented.set(candidate.host, { tracker: candidate.tracker, projectCount: 1 });
            else counted.projectCount += 1;
            continue;
          }
          supported.push({ ...candidate, api });
        }
        return { supported, unimplemented };
      }),
    );

  /**
   * The project whose checkout and credentials serve a reference, and whether the reference is
   * the project's own scope. A reference naming another scope on the same tracker and host is
   * served by the project but marked read-only. A project with two trackers serves the one the
   * reference names.
   */
  const requireProject = (
    ref: IssueScopeRef,
  ): Effect.Effect<SupportedProject & { readonly writable: boolean }, IssueError> =>
    listProjects({ projectId: ref.projectId }).pipe(
      Effect.flatMap(({ supported }) => {
        const own = supported.find((candidate) => candidate.tracker === ref.tracker);
        if (own === undefined) {
          return Effect.fail(new IssueUnavailableError({ reason: "tracker-unsupported" }));
        }
        const host = ref.host?.trim().toLowerCase() ?? own.host;
        if (host !== own.host) {
          return Effect.fail(new IssueUnavailableError({ reason: "tracker-unsupported" }));
        }
        const scope = ref.scope.trim();
        const writable = scope.toLowerCase() === own.scope.toLowerCase();
        return Effect.succeed({ ...own, scope, writable });
      }),
    );

  const requireWritable = (ref: IssueScopeRef, operation: string) =>
    requireProject(ref).pipe(
      Effect.filterOrFail(
        (project) => project.writable,
        () => readOnly(operation),
      ),
    );

  const list: IssueService["Service"]["list"] = Effect.fn("IssueService.list")(function* (input) {
    const { supported, unimplemented } = yield* listProjects(input);
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    // Worktrees of one repository are separate projects; read each scope once.
    const scopes = new Map<string, SupportedProject>();
    for (const project of supported) {
      if (!scopes.has(project.canonicalKey)) scopes.set(project.canonicalKey, project);
    }
    const continuing = input.cursors;
    const viewers = new Map<string, string>();
    const trackers = new Map<string, IssueTrackerSummary>();
    const entries: IssueListEntry[] = [];
    const errors: IssueListProjectError[] = [];
    const nextCursors: Record<string, string> = {};

    const viewerRequests = new Map<string, Effect.Effect<string, IssueTrackerError>>();
    for (const project of scopes.values()) {
      if (viewerRequests.has(project.host)) continue;
      const request = yield* Effect.cached(
        project.api
          .getViewer({ cwd: project.project.workspaceRoot, host: project.host })
          .pipe(Effect.tap((viewer) => Effect.sync(() => viewers.set(project.host, viewer)))),
      );
      viewerRequests.set(project.host, request);
    }

    // Every project counts, including worktrees of a scope read once below.
    for (const project of supported) {
      const existing = trackers.get(project.host);
      trackers.set(
        project.host,
        existing === undefined
          ? {
              tracker: project.tracker,
              host: project.host,
              projectCount: 1,
              capabilities: project.api.capabilities,
              configured: true,
              detail: null,
            }
          : { ...existing, projectCount: existing.projectCount + 1 },
      );
    }
    const recordFailure = (project: SupportedProject, failure: IssueTrackerError) => {
      const existing = trackers.get(project.host);
      if (existing !== undefined && isTrackerUnusable(failure))
        trackers.set(project.host, {
          ...existing,
          configured: false,
          detail: trackerDetail(failure),
        });
    };

    yield* Effect.forEach(
      scopes.values(),
      (project) =>
        Effect.gen(function* () {
          const key = listCursorKey(project.host, project.scope);
          // A continuation names the scopes it wants; one not named has nothing to add.
          if (continuing !== undefined && continuing[key] === undefined) return;
          const cursor = continuing?.[key];
          const page = yield* viewerRequests.get(project.host)!.pipe(
            Effect.flatMap((viewer) =>
              project.api.listIssues({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                state: input.state,
                involvement: input.involvement ?? "all",
                viewer,
                limit,
                query: input.query,
                cursor,
              }),
            ),
            Effect.result,
          );
          if (page._tag === "Failure") {
            if (cursor !== undefined) nextCursors[key] = cursor;
            recordFailure(project, page.failure);
            errors.push({
              projectId: project.project.id,
              projectTitle: project.project.title,
              message: trackerDetail(page.failure),
            });
            return;
          }
          for (const item of page.success.items) {
            entries.push({
              ...item,
              tracker: project.tracker,
              host: project.host,
              scope: project.scope,
              projectId: project.project.id,
              projectTitle: project.project.title,
            });
          }
          if (page.success.nextCursor !== null) nextCursors[key] = page.success.nextCursor;
        }),
      { concurrency: SCOPE_CONCURRENCY, discard: true },
    );

    for (const [host, { tracker, projectCount }] of unimplemented) {
      trackers.set(host, {
        tracker,
        host,
        projectCount,
        capabilities: null,
        configured: false,
        detail: "Issues cannot be browsed for this host yet.",
      });
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      viewers: Object.fromEntries(viewers),
      trackers: [...trackers.values()],
      entries,
      errors,
      nextCursors,
    };
  });

  const readBoardSettings = Effect.fn("IssueService.readBoardSettings")(function* (
    operation: string,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new IssueOperationError({
            operation,
            detail: "The server settings could not be read.",
            cause,
          }),
      ),
    );
    return settings.githubBoards;
  });
  const boardStoreError = (operation: string) => (cause: unknown) =>
    new IssueOperationError({
      operation,
      detail: "Which GitHub boards are on could not be read or saved.",
      cause,
    });

  const readPlaybooks = readPlaybooksFile(playbooksPath).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );

  const entriesError = (cause: unknown) =>
    new IssueOperationError({
      operation: "board",
      detail: "Which issues wait for Start could not be read or saved.",
      cause,
    });
  const readBoardListing = Effect.gen(function* () {
    const boards = yield* readBoardSettings("board");
    if (boards.length === 0) return { boards: [] };
    const enabled = yield* boardSources.listEnabled.pipe(Effect.mapError(boardStoreError("board")));
    if (!boards.some((candidate) => enabled.has(IssueBoardSources.boardSourceKey(candidate)))) {
      return yield* readBoards({ boards, enabled, api: null, projects: [] });
    }
    const rows = yield* playbookEntries.list.pipe(Effect.mapError(entriesError));
    const { supported } = yield* listProjects({});
    const projectScopes = yield* Effect.forEach(
      supported,
      (candidate) =>
        (candidate.project.repositoryIdentity != null
          ? Effect.succeed(candidate.project.repositoryIdentity)
          : repositoryIdentities.resolve(candidate.project.workspaceRoot)
        ).pipe(Effect.map((identity) => ({ ...candidate, origin: identity?.origin ?? null }))),
      { concurrency: SCOPE_CONCURRENCY },
    );
    return yield* readBoards({
      boards,
      enabled,
      recorded: recordedByBoard(rows),
      api: registry.get(GITHUB),
      projects: projectScopes,
    });
  });

  const readOpenThreads = threadLinks.listOpen.pipe(
    Effect.mapError(
      (cause) =>
        new IssueOperationError({
          operation: "board",
          detail: "Which issues have an open thread could not be read.",
          cause,
        }),
    ),
  );
  /** Each entry's open thread and the playbook it waits with, from the records as they are. */
  const withThreads = (
    boards: ReadonlyArray<IssueBoard>,
    open: ReadonlyMap<string, IssueThreadLinks.OpenIssueThread>,
    rows: ReadonlyMap<string, IssuePlaybookEntries.PlaybookEntryRow>,
    selfStarting: ReadonlySet<string>, // Fork-only (jehhynes/t3code#65)
  ): ReadonlyArray<IssueBoard> =>
    boards.map((candidate) => {
      const boardKey = IssueBoardSources.boardSourceKey(candidate);
      return {
        ...candidate,
        entries: candidate.entries.map((entry) => {
          const key = IssueThreadLinks.issueThreadKey(entry);
          const decided = rows.get(key);
          const row = decided?.board === boardKey ? decided : undefined;
          return {
            ...entry,
            hasOpenThread: open.has(key),
            // Only on the board whose read decided it, so Start takes that board's fields.
            ...waitingFields(row, selfStarting), // Fork-only (jehhynes/t3code#65)
          };
        }),
      };
    });

  // Fork-only (jehhynes/t3code#10): the timer and every client share one read at a time, and
  // each result is published, so a client sees a read it did not ask for.
  const latestBoard = yield* SubscriptionRef.make<IssueBoardResult | null>(null);
  // When the latest result's boards were read from GitHub; a `refreshWaiting` publish keeps it.
  let latestReadAt = 0;
  // Orders the local half of a read against `refreshWaiting`, without waiting on GitHub.
  const publishing = yield* Semaphore.make(1);
  const serviceScope = yield* Effect.scope;
  let reading: Deferred.Deferred<IssueBoardResult, IssueError> | undefined;

  const readBoard = Effect.gen(function* () {
    const listing = yield* readBoardListing;
    const readAt = yield* Clock.currentTimeMillis;
    const { playbooks, errors } = yield* readPlaybooks;
    const hasEntries = listing.boards.some((candidate) => candidate.entries.length > 0);
    let viewer: string | null = null;
    let viewerError: string | null = null;
    if (hasEntries && needsViewer(playbooks)) {
      const api = registry.get(GITHUB);
      const read =
        api === null
          ? Effect.fail("GitHub cannot be read by this server.")
          : api
              .getViewer({ cwd: config.cwd, host: GITHUB_HOST })
              .pipe(Effect.mapError((error) => error.detail.trim() || "No reason was given."));
      const viewerRead = yield* Effect.result(read);
      if (viewerRead._tag === "Failure") {
        // An assignee rule cannot decide, and skipping only those playbooks would hand their
        // issues to later ones.
        viewerError = `Your GitHub account could not be read, so no playbook applies: ${viewerRead.failure}`;
      } else {
        viewer = viewerRead.success;
      }
    }
    const playbookErrors = viewerError === null ? errors : [...errors, viewerError];
    const selected = listing.boards.map((candidate) => ({
      ...candidate,
      entries: candidate.entries.map((entry) => ({
        ...entry,
        playbook: viewerError === null ? selectPlaybook(playbooks, entry, viewer) : null,
      })),
    }));

    return yield* Effect.gen(function* () {
      const open = hasEntries
        ? yield* readOpenThreads
        : new Map<string, IssueThreadLinks.OpenIssueThread>();
      const boards = selected.map((candidate) => ({
        ...candidate,
        entries: candidate.entries.map((entry) => ({
          ...entry,
          hasOpenThread: open.has(IssueThreadLinks.issueThreadKey(entry)),
        })),
      }));
      // Entries change only while every playbook can select; otherwise they read as they were.
      const decides = boards.some((candidate) => candidate.enabled && candidate.error === null);
      const rows = !decides
        ? new Map<string, IssuePlaybookEntries.PlaybookEntryRow>()
        : yield* (
            playbookErrors.length === 0
              ? playbookEntries.reconcile((current) =>
                  reconcilePlaybookEntries({
                    rows: current,
                    boards,
                    // Fork-only (jehhynes/t3code#57): when an issue leaves, its threads settle.
                    now: DateTime.formatIso(DateTime.makeUnsafe(readAt)),
                  }),
                )
              : playbookEntries.list
          ).pipe(Effect.mapError(entriesError));
      const result: IssueBoardResult = {
        // Fork-only (jehhynes/t3code#65): which waiting issues start by themselves.
        boards: withThreads(boards, open, rows, selfStartingPlaybooks(playbooks)),
        playbookErrors,
        playbooks: playbooks.map((playbook) => playbook.name),
        triagePlaybooks: playbooks.filter((p) => p.choices !== undefined).map((p) => p.name), // Fork-only (jehhynes/t3code#93)
      };
      latestReadAt = readAt;
      yield* SubscriptionRef.set(latestBoard, result);
      return result;
    }).pipe(publishing.withPermits(1));
  });

  const board: IssueService["Service"]["board"] = Effect.suspend(() => {
    if (reading !== undefined) return Deferred.await(reading);
    const pending = Deferred.makeUnsafe<IssueBoardResult, IssueError>();
    reading = pending;
    // Forked, so a caller that goes away does not cancel a read others wait on.
    return readBoard.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          reading = undefined;
          Deferred.doneUnsafe(pending, exit);
        }),
      ),
      Effect.forkIn(serviceScope),
      Effect.andThen(Deferred.await(pending)),
    );
  }).pipe(Effect.withSpan("IssueService.board"));

  const boardChanges: IssueService["Service"]["boardChanges"] = SubscriptionRef.changes(
    latestBoard,
  ).pipe(Stream.filter((result): result is IssueBoardResult => result !== null));

  // A subscriber gets the latest result at once; when its read is older than a page's own
  // freshness, the boards are read again (or the read in flight joined) and the result pushed.
  const subscribeBoard: IssueService["Service"]["subscribeBoard"] = Stream.unwrap(
    Effect.gen(function* () {
      const latest = yield* SubscriptionRef.get(latestBoard);
      if (latest === null) {
        yield* board;
      } else if ((yield* Clock.currentTimeMillis) - latestReadAt > BOARD_FRESH_MILLIS) {
        yield* board.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(serviceScope));
      }
      return boardChanges;
    }),
  );

  const refreshWaiting: IssueService["Service"]["refreshWaiting"] = Effect.gen(function* () {
    const latest = yield* SubscriptionRef.get(latestBoard);
    if (latest === null) return;
    const open = yield* readOpenThreads;
    const rows = yield* playbookEntries.list.pipe(Effect.mapError(entriesError));
    const { playbooks } = yield* readPlaybooks; // Fork-only (jehhynes/t3code#65)
    yield* SubscriptionRef.set(latestBoard, {
      ...latest,
      boards: withThreads(latest.boards, open, rows, selfStartingPlaybooks(playbooks)),
    });
  }).pipe(publishing.withPermits(1), Effect.withSpan("IssueService.refreshWaiting"));

  const withLatestBoard: IssueService["Service"]["withLatestBoard"] = Effect.fn(
    "IssueService.withLatestBoard",
  )(function* <A, E, R>(use: (latest: IssueBoardResult | null) => Effect.Effect<A, E, R>) {
    return yield* use(yield* SubscriptionRef.get(latestBoard));
  }, publishing.withPermits(1));

  const setBoardEnabled: IssueService["Service"]["setBoardEnabled"] = Effect.fn(
    "IssueService.setBoardEnabled",
  )(function* (input) {
    const boards = yield* readBoardSettings("setBoardEnabled");
    const key = IssueBoardSources.boardSourceKey(input);
    if (!boards.some((candidate) => IssueBoardSources.boardSourceKey(candidate) === key)) {
      return yield* new IssueOperationError({
        operation: "setBoardEnabled",
        reason: "not-found",
        detail: `GitHub board ${input.owner}/${input.number} is not named in the server's settings.`,
      });
    }
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* boardSources
      .set({ owner: input.owner, number: input.number, enabled: input.enabled, at })
      .pipe(Effect.mapError(boardStoreError("setBoardEnabled")));
    // A read already running began before the switch, so read again once it ends. Answering
    // after the read has published lets the client wait for it without reading itself.
    yield* Effect.suspend(() =>
      reading === undefined ? Effect.void : Deferred.await(reading),
    ).pipe(Effect.ignore, Effect.andThen(board));
  });

  const detail: IssueService["Service"]["detail"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getIssue({
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
          })
          .pipe(
            Effect.mapError(toIssueError("detail")),
            Effect.map((issue): IssueDetail => ({
              ...issue,
              tracker: project.tracker,
              host: project.host,
              scope: project.scope,
              projectId: project.project.id,
              projectTitle: project.project.title,
              writable: project.writable,
              capabilities: project.api.capabilities,
            })),
          ),
      ),
    );

  const comments: IssueService["Service"]["comments"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api
          .getComments({
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
            cursor: input.cursor,
          })
          .pipe(Effect.mapError(toIssueError("comments"))),
      ),
    );

  const templates: IssueService["Service"]["templates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listTemplates === undefined || !project.api.capabilities.templates
          ? Effect.fail(unsupported("templates", "issue templates"))
          : project.api
              .listTemplates({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
              })
              .pipe(Effect.mapError(toIssueError("templates"))),
      ),
    );

  const candidates: IssueService["Service"]["candidates"] = (input) =>
    requireProject(input).pipe(
      Effect.flatMap((project) =>
        project.api.listCandidates === undefined ||
        !(project.api.capabilities.labels || project.api.capabilities.assignees)
          ? Effect.fail(unsupported("candidates", "labels or assignees"))
          : project.api
              .listCandidates({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
              })
              .pipe(Effect.mapError(toIssueError("candidates"))),
      ),
    );

  const create: IssueService["Service"]["create"] = (input) =>
    requireWritable(input, "create").pipe(
      Effect.flatMap((project) =>
        project.api.create === undefined || !project.api.capabilities.create
          ? Effect.fail(unsupported("create", "filing issues"))
          : project.api
              .create({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                title: input.title,
                body: input.body,
                labels: input.labels,
                assignees: input.assignees,
              })
              .pipe(Effect.mapError(toIssueError("create"))),
      ),
    );

  const comment: IssueService["Service"]["comment"] = (input) =>
    requireWritable(input, "comment").pipe(
      Effect.flatMap((project) => {
        if (input.body.trim().length === 0) {
          return Effect.fail(
            new IssueOperationError({ operation: "comment", detail: "A comment needs some text." }),
          );
        }
        return project.api.comment === undefined || !project.api.capabilities.comment
          ? Effect.fail(unsupported("comment", "comments"))
          : project.api
              .comment({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                body: input.body,
              })
              .pipe(Effect.mapError(toIssueError("comment")));
      }),
    );

  const update: IssueService["Service"]["update"] = (input) =>
    requireWritable(input, "update").pipe(
      Effect.flatMap((project) => {
        const { capabilities } = project.api;
        const wantsWords = input.title !== undefined || input.body !== undefined;
        if (!wantsWords && input.labels === undefined && input.assignees === undefined) {
          return Effect.fail(
            new IssueOperationError({ operation: "update", detail: "Nothing to change." }),
          );
        }
        if (project.api.update === undefined) return Effect.fail(unsupported("update", "edits"));
        if (wantsWords && !capabilities.edit)
          return Effect.fail(unsupported("update", "editing the title or body"));
        if (input.labels !== undefined && !capabilities.labels)
          return Effect.fail(unsupported("update", "labels"));
        if (input.assignees !== undefined && !capabilities.assignees)
          return Effect.fail(unsupported("update", "assignees"));
        return project.api
          .update({
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
            title: input.title,
            body: input.body,
            labels: input.labels,
            assignees: input.assignees,
          })
          .pipe(Effect.mapError(toIssueError("update")));
      }),
    );

  const setState: IssueService["Service"]["setState"] = (input) =>
    requireWritable(input, "setState").pipe(
      Effect.flatMap((project) => {
        const { capabilities } = project.api;
        const target = capabilities.states.find((state) => state.name === input.state);
        if (project.api.setState === undefined || target === undefined)
          return Effect.fail(unsupported("setState", `the state "${input.state}"`));
        if (
          input.closeReason !== undefined &&
          (target.category !== "closed" || !capabilities.closeReasons.includes(input.closeReason))
        )
          return Effect.fail(unsupported("setState", `the close reason "${input.closeReason}"`));
        return project.api
          .setState({
            cwd: project.project.workspaceRoot,
            host: project.host,
            scope: project.scope,
            key: input.key,
            state: input.state,
            closeReason: input.closeReason,
          })
          .pipe(Effect.mapError(toIssueError("setState")));
      }),
    );

  const react: IssueService["Service"]["react"] = (input) =>
    requireWritable(input, "react").pipe(
      Effect.flatMap((project) =>
        project.api.setReaction === undefined || !project.api.capabilities.reactions
          ? Effect.fail(unsupported("react", "reactions"))
          : project.api
              .setReaction({
                cwd: project.project.workspaceRoot,
                host: project.host,
                scope: project.scope,
                key: input.key,
                subjectId: input.subjectId,
                content: input.content,
                reacted: input.reacted,
              })
              .pipe(Effect.mapError(toIssueError("react"))),
      ),
    );

  const resolveUrl: IssueService["Service"]["resolveUrl"] = Effect.fn("IssueService.resolveUrl")(
    function* (url, preferredProjectId) {
      const parsed = parseIssueUrl(url);
      if (parsed === null) {
        return yield* new IssueOperationError({
          operation: "resolveUrl",
          reason: "not-found",
          detail: "This is not a recognised issue URL.",
        });
      }
      const { supported } = yield* listProjects({ host: parsed.host });
      const onTracker = supported.filter((project) => project.tracker === parsed.tracker);
      const preferFirst = (projects: ReadonlyArray<SupportedProject>) =>
        projects.find((project) => project.project.id === preferredProjectId) ?? projects[0];
      const own = preferFirst(
        onTracker.filter((project) => project.scope.toLowerCase() === parsed.scope),
      );
      const lender = own ?? preferFirst(onTracker);
      if (lender === undefined) {
        return yield* new IssueUnavailableError({ reason: "tracker-unsupported" });
      }
      return {
        projectId: lender.project.id,
        tracker: lender.tracker,
        host: lender.host,
        scope: own === undefined ? parsed.scope : lender.scope,
        key: parsed.key,
        writable: own !== undefined,
      };
    },
  );

  return IssueService.of({
    list,
    board,
    subscribeBoard,
    boardChanges,
    withLatestBoard,
    refreshWaiting,
    setBoardEnabled,
    detail: traced("detail", detail),
    comments: traced("comments", comments),
    templates: traced("templates", templates),
    candidates: interactive(traced("candidates", candidates)),
    create: interactive(traced("create", create)),
    comment: interactive(traced("comment", comment)),
    update: interactive(traced("update", update)),
    setState: interactive(traced("setState", setState)),
    react: interactive(traced("react", react)),
    resolveUrl,
  });
});

export const layer = Layer.effect(IssueService, make);
