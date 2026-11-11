import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubAppSignIn from "@t3tools/source-control-github/server/GitHubAppSignIn";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as GitHubQuota from "@t3tools/source-control-github/server/GitHubQuota";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as GitHubIssueTracker from "@t3tools/source-control-github/server/GitHubIssueTracker";
import {
  type GitHubBoardConfig,
  type IssueBoardResult,
  IssueTrackerKind,
  type IssueTrackerProjectBinding,
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerApi,
  type StandaloneIssueTrackerApi,
  type TrackerIssueDetail,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as IssueBoardSources from "../persistence/IssueBoardSources.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as IssueService from "./IssueService.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const GITHUB = IssueTrackerKind.make("github");
const LINEAR = IssueTrackerKind.make("linear");

/** A standalone tracker shaped like Linear: its own host, team keys for scopes, `ENG-1` keys. */
function fakeStandaloneTracker(
  overrides: Partial<IssueTrackerApi> = {},
): StandaloneIssueTrackerApi {
  return {
    ...fakeTracker({
      getViewer: () => Effect.succeed("usr_julius"),
      getIssue: (input) =>
        Effect.succeed({ ...issue(input.key), displayKey: input.key, viewer: "usr_julius" }),
      ...overrides,
    }),
    kind: LINEAR,
    standalone: {
      tracker: LINEAR,
      displayName: "Linear",
      host: "linear.app",
      scopeNoun: "team",
      credential: { label: "Personal API key", helpUrl: null },
    },
    probeCredential: () => Effect.succeed({ account: "julius", scopes: [] }),
  };
}

function project(input: {
  readonly id: string;
  readonly repository?: string;
  readonly provider?: string;
  readonly host?: string;
}): OrchestrationProjectShell {
  const host = input.host ?? "github.com";
  return {
    id: input.id as ProjectId,
    title: input.id,
    workspaceRoot: `/w/${input.id}`,
    ...(input.repository
      ? {
          repositoryIdentity: {
            canonicalKey: normalizeGitRemoteUrl(`https://${host}/${input.repository}.git`),
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${host}/${input.repository}.git`,
            },
            provider: SourceControlProviderKind.make(input.provider ?? "github"),
            displayName: input.repository,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
  };
}

function issue(key: string, updatedAt = "2026-07-02T00:00:00Z"): TrackerIssueDetail {
  return {
    key,
    displayKey: `#${key}`,
    title: `Issue ${key}`,
    url: `https://github.com/acme/web/issues/${key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    body: "",
    viewer: "julius",
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  };
}

function fakeTracker(overrides: Partial<IssueTrackerApi> = {}): IssueTrackerApi {
  return {
    kind: GITHUB,
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: true,
      events: true,
      search: true,
      states: [
        { category: "open", name: "open" },
        { category: "closed", name: "closed" },
      ],
      closeReasons: ["completed"],
    },
    getViewer: () => Effect.succeed("julius"),
    listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
    getIssue: (input) => Effect.succeed(issue(input.key)),
    getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
    comment: () => Effect.void,
    update: () => Effect.void,
    setState: () => Effect.void,
    ...overrides,
  };
}

function makeService(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly trackers: ReadonlyArray<IssueTrackerApi>;
  readonly bindings?: Record<string, IssueTrackerProjectBinding>;
  readonly boards?: ReadonlyArray<GitHubBoardConfig>;
  /** The board store's keys; the service turns boards on and off in it. */
  readonly enabledBoards?: Set<string>;
  /** The text of `playbooks.json`; no file when left out. */
  readonly playbooks?: string;
  /** The T3 home, for a test that edits `userdata/playbooks.json` between reads. */
  readonly baseDir?: string;
  /** The `issueThreadKey` of each issue with an open thread. */
  readonly openIssueKeys?: ReadonlyArray<string>;
  /** The entries store, for a test that starts entries; else a fresh one. */
  readonly playbookEntries?: IssuePlaybookEntries.IssuePlaybookEntriesRepository["Service"];
}) {
  const enabledBoards = input.enabledBoards ?? new Set<string>();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir =
      input.baseDir ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3code-issue-service-" }));
    if (input.playbooks !== undefined) {
      yield* fs.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fs.writeFileString(`${baseDir}/userdata/playbooks.json`, input.playbooks);
    }
    // Built in the test's scope, so the database outlives the service's construction.
    const playbookEntries =
      input.playbookEntries ??
      Context.get(
        yield* Layer.build(
          IssuePlaybookEntries.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        ),
        IssuePlaybookEntries.IssuePlaybookEntriesRepository,
      );
    return yield* makeServiceIn(baseDir, input, enabledBoards, playbookEntries);
  }).pipe(Effect.provide(NodeServices.layer));
}

function makeServiceIn(
  baseDir: string,
  input: Parameters<typeof makeService>[0],
  enabledBoards: Set<string>,
  playbookEntries: IssuePlaybookEntries.IssuePlaybookEntriesRepository["Service"],
) {
  // Built in the caller's scope: the service forks its board reads into its own.
  return Layer.build(
    IssueService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
            list: Effect.succeed(
              new Map(
                Object.entries(input.bindings ?? {}).map(([id, binding]) => [
                  id as ProjectId,
                  binding,
                ]),
              ),
            ),
          }),
          Layer.mock(IssueThreadLinks.IssueThreadLinksRepository)({
            listOpen: Effect.sync(
              () =>
                new Map(
                  (input.openIssueKeys ?? []).map((key) => [
                    key,
                    { threadId: ThreadId.make(`thread ${key}`), projectId: ProjectId.make("p") },
                  ]),
                ),
            ),
          }),
          Layer.succeed(IssuePlaybookEntries.IssuePlaybookEntriesRepository, playbookEntries),
          Layer.mock(IssueBoardSources.IssueBoardSourcesRepository)({
            listEnabled: Effect.sync(() => new Set(enabledBoards)),
            set: (board) =>
              Effect.sync(() => {
                const key = IssueBoardSources.boardSourceKey(board);
                if (board.enabled) enabledBoards.add(key);
                else enabledBoards.delete(key);
              }),
          }),
          Layer.succeed(
            IssueTrackerRegistry.IssueTrackerRegistry,
            IssueTrackerRegistry.fromTrackers(input.trackers),
          ),
          Layer.mock(ProjectService.ProjectService)({
            listShells: () => Effect.succeed(input.projects),
            getShell: (projectId) =>
              Effect.succeed(Option.fromNullishOr(input.projects.find((p) => p.id === projectId))),
          }),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () => Effect.succeed(null),
          }),
          ServerSettings.ServerSettingsService.layerTest({
            githubBoards: [...(input.boards ?? [])],
          }),
          ServerConfig.layerTest(process.cwd(), baseDir).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
  ).pipe(Effect.map((context) => Context.get(context, IssueService.IssueService)));
}

describe("resolveGitHostBinding", () => {
  it("scopes Azure DevOps work items to the project rather than the repository", () => {
    expect(
      IssueService.resolveGitHostBinding(
        project({
          id: "p",
          provider: "azure-devops",
          host: "dev.azure.com",
          repository: "acme/Web App/_git/web",
        }),
      ),
    ).toEqual({
      canonicalKey: "dev.azure.com/acme/web app",
      tracker: "azure-devops",
      host: "dev.azure.com",
      scope: "acme/Web App",
    });
    expect(
      IssueService.resolveGitHostBinding(
        project({ id: "p", provider: "azure-devops", host: "dev.azure.com", repository: "web" }),
      ),
    ).toBeNull();
  });
});

describe("IssueService", () => {
  it.effect("reads another repository on the same host but refuses to write to it", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            comment: (input) =>
              Effect.sync(() => {
                writes.push(`${input.scope}#${input.key}`);
              }),
          }),
        ],
      });
      const own = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };
      const external = { ...own, scope: "other/backend", key: "7" };

      expect((yield* service.detail(own)).writable).toBe(true);
      // The external issue is served by the project's checkout and credentials, read-only.
      const detail = yield* service.detail(external);
      expect(detail).toMatchObject({ writable: false, scope: "other/backend", key: "7" });

      yield* service.comment({ ...own, body: "ok" });
      const refused = yield* service.comment({ ...external, body: "no" }).pipe(Effect.result);
      expect(refused).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "IssueOperationError", reason: "read-only" },
      });
      expect(writes).toEqual(["acme/web#1"]);

      // Another host is not reachable through this project's credentials at all.
      const elsewhere = yield* Effect.flip(service.detail({ ...own, host: "ghe.example.test" }));
      expect(elsewhere).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });
    }),
  );

  it.effect("posts a comment while background requests to GitHub are paused", () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
      const key = { provider: SourceControlProviderKind.make("github"), host: "github.com" };
      yield* limits
        .recordRateLimit({ ...key, lease: 0 })
        .pipe(Effect.provideService(SourceControlRateLimit.CredentialScope, "test"));
      const tracker = yield* GitHubIssueTracker.make;
      expect(
        yield* Effect.flip(tracker.getViewer({ cwd: "/w/web", host: key.host })),
      ).toMatchObject({ reason: "rate-limited" });
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [tracker],
      });
      yield* service.comment({
        projectId: "web" as ProjectId,
        tracker: GITHUB,
        scope: "acme/web",
        key: "42",
        body: "Repro attached.",
      });
      expect(requests).toEqual([
        "POST https://api.github.com/graphql",
        "POST https://api.github.com/repos/acme/web/issues/42/comments",
      ]);
    }).pipe(
      Effect.provide(
        GitHubRest.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              SourceControlRateLimit.layer,
              GitHubQuota.layer,
              Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
                enabled: false,
                token: () => Effect.succeedNone,
                invalidate: () => Effect.void,
              }),
              Layer.mock(GitHubCredentials.GitHubCredentials)({
                saved: () => Effect.succeedNone,
                get: (host) =>
                  Effect.succeed({
                    host,
                    token: Redacted.make("test-token"),
                    source: "gh" as const,
                    fingerprint: "test",
                  }),
              }),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) => {
                  requests.push(`${request.method} ${request.url}`);
                  const body = request.url.endsWith("/graphql")
                    ? JSON.stringify({ data: { repository: { issue: { id: "I_42" } } } })
                    : "{}";
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      new Response(body, { headers: { "content-type": "application/json" } }),
                    ),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("refuses what the tracker did not declare before calling it", () =>
    Effect.gen(function* () {
      let calls = 0;
      const service = yield* makeService({
        projects: [project({ id: "web", repository: "acme/web" })],
        trackers: [
          fakeTracker({
            setState: () =>
              Effect.sync(() => {
                calls += 1;
              }),
            setReaction: () =>
              Effect.sync(() => {
                calls += 1;
              }),
          }),
        ],
      });
      const ref = { projectId: "web" as ProjectId, tracker: GITHUB, scope: "acme/web", key: "1" };

      yield* service.setState({ ...ref, state: "closed", closeReason: "completed" });
      const unknownState = yield* Effect.flip(service.setState({ ...ref, state: "In Review" }));
      expect(unknownState._tag).toBe("IssueOperationError");
      const unknownReason = yield* Effect.flip(
        service.setState({ ...ref, state: "closed", closeReason: "not-planned" }),
      );
      expect(unknownReason._tag).toBe("IssueOperationError");
      const reaction = yield* Effect.flip(
        service.react({ ...ref, content: "heart", reacted: true }),
      );
      expect(reaction._tag).toBe("IssueOperationError");
      expect(calls).toBe(1);
    }),
  );

  it.effect("deduplicates and pages repositories despite partial failures", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      let failContinuation = true;
      const service = yield* makeService({
        projects: [
          project({ id: "web", repository: "Acme/Web" }),
          project({ id: "web-worktree", repository: "acme/web" }),
          project({ id: "api", repository: "acme/api" }),
          project({ id: "docs", repository: "acme/docs" }),
          project({
            id: "gitlab",
            repository: "acme/gl",
            provider: "gitlab",
            host: "gitlab.com",
          }),
          project({ id: "plain" }),
        ],
        trackers: [
          fakeTracker({
            listIssues: (input) =>
              Effect.gen(function* () {
                listed.push(input.scope);
                if (input.scope === "acme/api")
                  return yield* new IssueTrackerError({
                    tracker: GITHUB,
                    operation: "listIssues",
                    reason: "failed",
                    // A tracker may fail without a detail; the wire error still needs one.
                    detail: " ",
                  });
                if (input.scope === "acme/docs")
                  return { items: [issue("3", "2026-07-04T00:00:00Z")], nextCursor: null };
                if (input.cursor === "next" && failContinuation) {
                  failContinuation = false;
                  return yield* new IssueTrackerError({
                    tracker: GITHUB,
                    operation: "listIssues",
                    reason: "failed",
                    detail: "try again",
                  });
                }
                if (input.cursor === "next")
                  return { items: [issue("4", "2026-07-01T00:00:00Z")], nextCursor: null };
                return {
                  items: [issue("1"), issue("2", "2026-07-05T00:00:00Z")],
                  nextCursor: "next",
                };
              }),
          }),
        ],
      });
      const result = yield* service.list({ state: "open" });
      expect(listed.sort()).toEqual(["Acme/Web", "acme/api", "acme/docs"]);
      expect(result.entries.map((entry) => [entry.projectId, entry.key])).toEqual([
        ["web", "2"],
        ["docs", "3"],
        ["web", "1"],
      ]);
      expect(
        result.entries.filter((entry) => entry.projectId === "web").map((entry) => entry.scope),
      ).toEqual(["Acme/Web", "Acme/Web"]);
      expect(result.nextCursors).toEqual({ "github.com Acme/Web": "next" });
      expect(result.errors).toEqual([
        { projectId: "api", projectTitle: "api", message: "The issue tracker request failed." },
      ]);
      expect(result.viewers).toEqual({ "github.com": "julius" });
      expect(result.trackers).toEqual([
        expect.objectContaining({ host: "github.com", projectCount: 4, configured: true }),
        expect.objectContaining({
          host: "gitlab.com",
          tracker: "gitlab",
          projectCount: 1,
          configured: false,
          capabilities: null,
        }),
      ]);

      // A continuation only reads the scopes it names.
      listed.length = 0;
      const failed = yield* service.list({
        state: "open",
        cursors: result.nextCursors,
      });
      expect(listed).toEqual(["Acme/Web"]);
      expect(failed.nextCursors).toEqual(result.nextCursors);
      expect(failed.errors).toEqual([
        { projectId: "web", projectTitle: "web", message: "try again" },
      ]);
      const next = yield* service.list({ state: "open", cursors: failed.nextCursors });
      expect(next.entries.map((entry) => [entry.projectId, entry.key])).toEqual([["web", "4"]]);
      expect(next.nextCursors).toEqual({});
      expect(next.errors).toEqual([]);
    }),
  );

  it.effect("lists each board's issues under the project for their repository, or none", () =>
    Effect.gen(function* () {
      const boardIssue = (key: string, scope: string, status: string, assignee: string) => ({
        ...issue(key),
        scope,
        status,
        assignees: [{ login: assignee, name: null, avatarUrl: null }],
        blockers: [],
      });
      const forkOf = (id: string, upstream: string, origin: string) => {
        const shell = project({ id, repository: upstream });
        return {
          ...shell,
          repositoryIdentity: {
            ...shell.repositoryIdentity!,
            origin: { canonicalKey: `github.com/${origin}`, displayName: origin },
          },
        };
      };
      const asked: string[] = [];
      let viewerReads = 0;
      const service = yield* makeService({
        playbooks: JSON.stringify([
          {
            name: "develop",
            rules: { status: ["Ready", "In progress"], assignee: "me" },
            prompt: "p",
          },
          { name: "ship", rules: { status: ["In review"] }, prompt: "p" },
          { name: "other", prompt: "p" },
        ]),
        // Keys compare as thread links store them, whatever the board's letter case.
        openIssueKeys: ["github github.com acme/web 1"],
        projects: [
          // Its origin is acme/web, but the project whose own repository is acme/web wins.
          forkOf("other-fork", "acme/other", "acme/web"),
          project({ id: "web", repository: "acme/web" }),
          // A second checkout of the same repository; the first project serves it.
          project({ id: "web-worktree", repository: "acme/web" }),
          // A fork checkout resolves to its upstream; its origin's issues are its own.
          forkOf("app-fork", "upstream/app", "me/app"),
        ],
        boards: [
          { owner: "acme", number: 1, statusField: "Status" },
          { owner: "acme", number: 2, statusField: "Stage" },
          // Never turned on: listed as off and never read.
          { owner: "acme", number: 3, statusField: "Status" },
        ],
        trackers: [
          fakeTracker({
            getViewer: () =>
              Effect.sync(() => {
                viewerReads += 1;
                return "Julius";
              }),
            listBoard: (input) => {
              asked.push(`${input.host} ${input.owner}/${input.number} ${input.statusField}`);
              return input.number === 1
                ? Effect.succeed([
                    boardIssue("1", "Acme/Web", "Ready", "julius"),
                    boardIssue("2", "acme/api", "In review", "julius"),
                    boardIssue("3", "me/app", "Ready", "jessy"),
                  ])
                : Effect.fail(
                    new IssueTrackerError({
                      tracker: GITHUB,
                      operation: "listBoard",
                      reason: "failed",
                      detail: 'Project acme/2 has no field named "Stage".',
                    }),
                  );
            },
          }),
        ],
      });

      yield* service.setBoardEnabled({ owner: "Acme", number: 1, enabled: true });
      yield* service.setBoardEnabled({ owner: "acme", number: 2, enabled: true });
      // Each switch read the boards; count only the read below.
      asked.length = 0;
      viewerReads = 0;
      const { boards, playbookErrors } = yield* service.board;

      expect(playbookErrors).toEqual([]);
      expect(viewerReads).toBe(1);
      expect(asked.toSorted()).toEqual(["github.com acme/1 Status", "github.com acme/2 Stage"]);
      expect(boards).toHaveLength(3);
      expect(boards[0]).toMatchObject({ owner: "acme", number: 1, enabled: true, error: null });
      expect(
        boards[0]?.entries.map((entry) => [
          entry.scope,
          entry.key,
          entry.projectId,
          entry.projectTitle,
          entry.playbook,
          entry.hasOpenThread,
          entry.waitingPlaybook,
        ]),
      ).toEqual([
        // First seen with an open thread, so it counts as started.
        ["Acme/Web", "1", "web", "web", "develop", true, null],
        ["acme/api", "2", null, null, "ship", false, "ship"],
        ["me/app", "3", "app-fork", "app-fork", "other", false, "other"],
      ]);
      expect(boards[0]?.entries[0]).toMatchObject({ tracker: "github", host: "github.com" });
      expect(boards[1]).toEqual({
        owner: "acme",
        number: 2,
        statusField: "Stage",
        enabled: true,
        entries: [],
        error: 'Project acme/2 has no field named "Stage".',
      });
      expect(boards[2]).toEqual({
        owner: "acme",
        number: 3,
        statusField: "Status",
        enabled: false,
        entries: [],
        error: null,
      });

      const unconfigured = yield* makeService({ projects: [], trackers: [fakeTracker()] });
      expect(yield* unconfigured.board).toEqual({ boards: [], playbookErrors: [] });
    }),
  );

  it.effect("reads a board only while it is turned on, and only a board that settings name", () =>
    Effect.gen(function* () {
      let reads = 0;
      const enabledBoards = new Set<string>();
      const service = yield* makeService({
        projects: [],
        enabledBoards,
        boards: [{ owner: "acme", number: 1, statusField: "Status" }],
        trackers: [
          fakeTracker({
            listBoard: () =>
              Effect.sync(() => {
                reads += 1;
                return [{ ...issue("1"), scope: "acme/web", status: null, blockers: [] }];
              }),
          }),
        ],
      });
      const entryKeys = Effect.map(service.board, ({ boards }) =>
        boards.map((board) => [board.enabled, board.entries.map((entry) => entry.key)]),
      );

      expect(yield* entryKeys).toEqual([[false, []]]);
      // Turning a board on reads the boards before it answers.
      yield* service.setBoardEnabled({ owner: "acme", number: 1, enabled: true });
      expect(reads).toBe(1);
      expect(yield* entryKeys).toEqual([[true, ["1"]]]);
      expect(reads).toBe(2);
      yield* service.setBoardEnabled({ owner: "ACME", number: 1, enabled: false });
      expect(yield* entryKeys).toEqual([[false, []]]);
      expect(reads).toBe(2);

      const refused = yield* Effect.flip(
        service.setBoardEnabled({ owner: "acme", number: 2, enabled: true }),
      );
      expect(refused).toMatchObject({
        detail: "GitHub board acme/2 is not named in the server's settings.",
      });
      expect([...enabledBoards]).toEqual([]);
    }),
  );

  it.effect("still lists the boards when playbooks.json has a mistake, and says what it is", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-issue-service-" });
      yield* fs.makeDirectory(`${baseDir}/userdata`);
      let viewer: Effect.Effect<string, IssueTrackerError> = Effect.succeed("julius");
      let viewerReads = 0;
      const service = yield* makeService({
        projects: [],
        baseDir,
        enabledBoards: new Set(["acme/1"]),
        boards: [{ owner: "acme", number: 1, statusField: "Status" }],
        trackers: [
          fakeTracker({
            getViewer: () => Effect.suspend(() => ((viewerReads += 1), viewer)),
            listBoard: () =>
              Effect.succeed([{ ...issue("1"), scope: "acme/web", status: "Ready", blockers: [] }]),
          }),
        ],
      });
      const read = (playbooks: string) =>
        fs.writeFileString(`${baseDir}/userdata/playbooks.json`, playbooks).pipe(
          Effect.andThen(service.board),
          Effect.map(({ boards, playbookErrors }) => ({
            playbooks: boards.flatMap((board) => board.entries.map((entry) => entry.playbook)),
            playbookErrors,
          })),
        );

      const broken = yield* read('[{ "name": "develop" ');
      expect(broken.playbooks).toEqual([null]);
      expect(broken.playbookErrors).toHaveLength(1);
      expect(broken.playbookErrors[0]).toMatch(/^playbooks\.json is not valid JSON: /);

      expect(
        yield* read(
          JSON.stringify([
            { name: "develop", rules: { stauts: ["Ready"] }, prompt: "p" },
            { name: "other", rules: { status: ["ready"] }, prompt: "p" },
          ]),
        ),
      ).toEqual({
        playbooks: ["other"],
        playbookErrors: ["Playbook 1 (develop): Expected no excess property at rules.stauts"],
      });
      expect(viewerReads).toBe(0);

      const assigned = JSON.stringify([
        { name: "develop", rules: { assignee: "nobody" }, prompt: "p" },
        { name: "other", prompt: "p" },
      ]);
      expect(yield* read(assigned)).toEqual({ playbooks: ["develop"], playbookErrors: [] });
      viewer = Effect.fail(
        new IssueTrackerError({
          tracker: GITHUB,
          operation: "getViewer",
          reason: "failed",
          detail: "Bad credentials",
        }),
      );
      expect(yield* read(assigned)).toEqual({
        playbooks: [null],
        playbookErrors: [
          "Your GitHub account could not be read, so no playbook applies: Bad credentials",
        ],
      });
      expect(viewerReads).toBe(2);

      const unconfigured = yield* makeService({
        projects: [],
        trackers: [fakeTracker()],
        playbooks: "[1]",
      });
      expect(yield* unconfigured.board).toEqual({
        boards: [],
        playbookErrors: ["Playbook 1: Expected object"],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "an issue waits once each time it enters a selection, and nothing changes while selection cannot be trusted",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-issue-service-" });
        yield* fs.makeDirectory(`${baseDir}/userdata`);
        const playbooks = JSON.stringify([
          { name: "develop", rules: { status: ["Ready"] }, prompt: "p" },
          { name: "ship", rules: { status: ["In review"] }, prompt: "p" },
          // Needs the GitHub account, so a failed account read stops every playbook.
          { name: "mine", rules: { status: ["Mine"], assignee: "me" }, prompt: "p" },
        ]);
        yield* fs.writeFileString(`${baseDir}/userdata/playbooks.json`, playbooks);
        const statuses = new Map([
          ["1", "Ready"],
          ["2", "Ready"],
        ]);
        let boardFails = false;
        let viewerFails = false;
        // The issues each read is asked to confirm if its search leaves them out.
        let recorded: ReadonlyArray<{ scope: string; key: string }> | undefined;
        const openIssueKeys = ["github github.com acme/web 2"];
        const store = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
        const service = yield* makeService({
          projects: [],
          baseDir,
          enabledBoards: new Set(["acme/1"]),
          boards: [{ owner: "acme", number: 1, statusField: "Status" }],
          openIssueKeys,
          playbookEntries: store,
          trackers: [
            fakeTracker({
              getViewer: () =>
                viewerFails
                  ? Effect.fail(
                      new IssueTrackerError({
                        tracker: GITHUB,
                        operation: "getViewer",
                        reason: "failed",
                        detail: "Bad credentials",
                      }),
                    )
                  : Effect.succeed("julius"),
              listBoard: (input) =>
                boardFails
                  ? Effect.fail(
                      new IssueTrackerError({
                        tracker: GITHUB,
                        operation: "listBoard",
                        reason: "failed",
                        detail: "Bad credentials",
                      }),
                    )
                  : Effect.sync(() => {
                      recorded = input.recorded;
                      return [...statuses].map(([key, status]) => ({
                        ...issue(key),
                        scope: "acme/web",
                        status,
                        blockers: [],
                      }));
                    }),
            }),
          ],
        });
        const waiting = service.board.pipe(
          Effect.map(({ boards }) =>
            boards.flatMap((board) =>
              board.entries.map((entry) => [entry.key, entry.waitingPlaybook]),
            ),
          ),
        );

        // #2 already had an open thread when first seen.
        expect(yield* waiting).toEqual([
          ["1", "develop"],
          ["2", null],
        ]);
        expect(
          yield* store.claim({
            issueKey: "github github.com acme/web 1",
            playbook: "develop",
            startedBy: "issue-playbook:1",
          }),
        ).toBe(true);
        statuses.set("3", "Ready");
        // #2's thread is settled; it entered with it open, so it still does not wait.
        openIssueKeys.length = 0;
        const before = [
          ["1", null],
          ["2", null],
          ["3", "develop"],
        ];
        expect(yield* waiting).toEqual(before);

        boardFails = true;
        expect(yield* waiting).toEqual([]);
        boardFails = false;
        expect(yield* waiting).toEqual(before);

        yield* fs.writeFileString(`${baseDir}/userdata/playbooks.json`, '[{ "name": ');
        statuses.set("3", "Backlog");
        expect(yield* waiting).toEqual(before);
        viewerFails = true;
        yield* fs.writeFileString(`${baseDir}/userdata/playbooks.json`, playbooks);
        expect(yield* waiting).toEqual(before);
        viewerFails = false;
        statuses.set("3", "Ready");
        expect(yield* waiting).toEqual(before);

        yield* service.setBoardEnabled({ owner: "acme", number: 1, enabled: false });
        statuses.set("3", "Backlog");
        expect(yield* waiting).toEqual([]);
        statuses.set("3", "Ready");
        yield* service.setBoardEnabled({ owner: "acme", number: 1, enabled: true });
        expect(yield* waiting).toEqual(before);

        // Moving to another selection waits with it; leaving and coming back waits again.
        statuses.set("1", "In review");
        statuses.set("2", "Backlog");
        expect(yield* waiting).toEqual([
          ["1", "ship"],
          ["2", null],
          ["3", "develop"],
        ]);
        expect(recorded).toEqual([
          { scope: "acme/web", key: "1" },
          { scope: "acme/web", key: "2" },
          { scope: "acme/web", key: "3" },
        ]);
        statuses.set("2", "Ready");
        expect(yield* waiting).toEqual([
          ["1", "ship"],
          ["2", "develop"],
          ["3", "develop"],
        ]);
        // #2 had left every selection, so that read did not ask to confirm it.
        expect(recorded).toEqual([
          { scope: "acme/web", key: "1" },
          { scope: "acme/web", key: "3" },
        ]);
      }).pipe(
        Effect.provide(
          Layer.merge(
            IssuePlaybookEntries.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            NodeServices.layer,
          ),
        ),
      ),
  );

  it.effect("a board read asked for while one runs shares it, and every result is published", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let reads = 0;
      const store = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
      const service = yield* makeService({
        projects: [],
        enabledBoards: new Set(["acme/1"]),
        boards: [{ owner: "acme", number: 1, statusField: "Status" }],
        playbooks: JSON.stringify([{ name: "develop", rules: { status: ["Ready"] }, prompt: "p" }]),
        playbookEntries: store,
        trackers: [
          fakeTracker({
            listBoard: () => {
              reads += 1;
              const listed = [{ ...issue("1"), scope: "acme/web", status: "Ready", blockers: [] }];
              return reads === 1
                ? Deferred.succeed(held, undefined).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                    Effect.as(listed),
                  )
                : Effect.succeed(listed);
            },
          }),
        ],
      });
      const waiting = (result: IssueBoardResult) =>
        result.boards.flatMap((board) =>
          board.entries.map((entry) => [entry.waitingPlaybook, entry.startFailure]),
        );

      // A subscriber with nothing published yet starts the first read.
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Effect.forkChild(
        service.subscribeBoard.pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(3),
          Stream.runCollect,
        ),
      );
      yield* Deferred.await(held);
      const joined = yield* Effect.forkChild(service.board, { startImmediately: true });
      yield* Deferred.succeed(proceed, undefined);
      const first = yield* Fiber.join(joined);
      expect(reads).toBe(1);
      expect(waiting(first)).toEqual([["develop", null]]);

      // A Start's claim reaches subscribers without another GitHub read.
      yield* Deferred.await(subscribed);
      expect(
        yield* store.claim({
          issueKey: "github github.com acme/web 1",
          playbook: "develop",
          startedBy: "issue-playbook:1",
        }),
      ).toBe(true);
      yield* service.refreshWaiting;
      yield* store.release({
        issueKey: "github github.com acme/web 1",
        startedBy: "issue-playbook:1",
        failure: "The launch failed.",
      });
      yield* service.refreshWaiting;
      const results = [...(yield* Fiber.join(published))];
      expect(results.map(waiting)).toEqual([
        [["develop", null]],
        [[null, null]],
        [["develop", "The launch failed."]],
      ]);
      expect(reads).toBe(1);
    }).pipe(
      Effect.provide(
        Layer.merge(
          IssuePlaybookEntries.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          NodeServices.layer,
        ),
      ),
    ),
  );

  it.effect("a subscriber reads the boards again only when the latest read is over 30 s old", () =>
    Effect.gen(function* () {
      let reads = 0;
      const service = yield* makeService({
        projects: [],
        enabledBoards: new Set(["acme/1"]),
        boards: [{ owner: "acme", number: 1, statusField: "Status" }],
        trackers: [
          fakeTracker({
            listBoard: () =>
              Effect.sync(() => {
                reads += 1;
                const status = reads === 1 ? "Ready" : "In review";
                return [{ ...issue("1"), scope: "acme/web", status, blockers: [] }];
              }),
          }),
        ],
      });
      const statuses = (result: IssueBoardResult) =>
        result.boards.flatMap((board) => board.entries.map((entry) => entry.status));

      yield* service.board;
      yield* TestClock.adjust("30 seconds");
      // Republishing who waits is not a read of GitHub and keeps the read's age.
      yield* service.refreshWaiting;
      const fresh = yield* service.subscribeBoard.pipe(Stream.take(1), Stream.runCollect);
      expect([...fresh].map(statuses)).toEqual([["Ready"]]);
      expect(reads).toBe(1);

      yield* TestClock.adjust("1 second");
      // The latest result at once, then the new read's.
      const stale = yield* service.subscribeBoard.pipe(Stream.take(2), Stream.runCollect);
      expect([...stale].map(statuses)).toEqual([["Ready"], ["In review"]]);
      expect(reads).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a board turned on while a read runs is read again once that read ends", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let reads = 0;
      const enabledBoards = new Set(["acme/1"]);
      const service = yield* makeService({
        projects: [],
        enabledBoards,
        boards: [
          { owner: "acme", number: 1, statusField: "Status" },
          { owner: "acme", number: 2, statusField: "Status" },
        ],
        trackers: [
          fakeTracker({
            listBoard: () => {
              reads += 1;
              const listed = [{ ...issue("1"), scope: "acme/web", status: null, blockers: [] }];
              return reads === 1
                ? Deferred.succeed(held, undefined).pipe(
                    Effect.andThen(Deferred.await(proceed)),
                    Effect.as(listed),
                  )
                : Effect.succeed(listed);
            },
          }),
        ],
      });

      const before = yield* Effect.forkChild(service.board);
      yield* Deferred.await(held);
      const toggled = yield* Effect.forkChild(
        service.setBoardEnabled({ owner: "acme", number: 2, enabled: true }),
        { startImmediately: true },
      );
      yield* Deferred.succeed(proceed, undefined);
      yield* Fiber.join(before);
      yield* Fiber.join(toggled);

      const latest = yield* service.subscribeBoard.pipe(Stream.take(1), Stream.runCollect);
      expect([...latest][0]?.boards.map((board) => board.enabled)).toEqual([true, true]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("IssueService with a standalone tracker", () => {
  it.effect("lists a bound project's standalone scope beside its git host and serves both", () =>
    Effect.gen(function* () {
      const listed: string[] = [];
      const record = (tracker: IssueTrackerKind): Partial<IssueTrackerApi> => ({
        listIssues: (input) =>
          Effect.sync(() => {
            listed.push(`${tracker} ${input.host} ${input.scope}`);
            return { items: [issue(tracker === LINEAR ? "ENG-1" : "1")], nextCursor: null };
          }),
      });
      const projects = [project({ id: "web", repository: "acme/web" }), project({ id: "notes" })];
      const trackers = [fakeTracker(record(GITHUB)), fakeStandaloneTracker(record(LINEAR))];
      const bound = yield* makeService({
        projects,
        trackers,
        bindings: { ["web" as ProjectId]: { tracker: LINEAR, scope: "ENG" } },
      });

      const result = yield* bound.list({ state: "open" });
      expect(listed.sort()).toEqual(["github github.com acme/web", "linear linear.app ENG"]);
      expect(result.entries.map((entry) => [entry.tracker, entry.scope, entry.key]).sort()).toEqual(
        [
          ["github", "acme/web", "1"],
          ["linear", "ENG", "ENG-1"],
        ],
      );
      expect(result.trackers.map((tracker) => [tracker.tracker, tracker.host]).sort()).toEqual([
        ["github", "github.com"],
        ["linear", "linear.app"],
      ]);
      // A reference picks the project's tracker by kind; both are the project's own, so writable.
      const linearRef = {
        projectId: "web" as ProjectId,
        tracker: LINEAR,
        scope: "ENG",
        key: "ENG-1",
      };
      expect(yield* bound.detail(linearRef)).toMatchObject({ host: "linear.app", writable: true });
      expect(
        yield* bound.detail({
          projectId: "web" as ProjectId,
          tracker: GITHUB,
          scope: "acme/web",
          key: "1",
        }),
      ).toMatchObject({ host: "github.com", writable: true });

      // Unbound, the standalone scope is gone and its references are unsupported.
      listed.length = 0;
      const unbound = yield* makeService({ projects, trackers });
      const after = yield* unbound.list({ state: "open" });
      expect(listed).toEqual(["github github.com acme/web"]);
      expect(after.trackers.map((tracker) => tracker.tracker)).toEqual(["github"]);
      const refused = yield* Effect.flip(unbound.detail(linearRef));
      expect(refused).toMatchObject({
        _tag: "IssueUnavailableError",
        reason: "tracker-unsupported",
      });

      // A project with no remote at all can still be bound, and then has only the standalone one.
      const standaloneOnly = yield* makeService({
        projects,
        trackers,
        bindings: { ["notes" as ProjectId]: { tracker: LINEAR, scope: "OPS" } },
      });
      const notes = yield* standaloneOnly.list({ state: "open", projectId: "notes" as ProjectId });
      expect(notes.entries.map((entry) => [entry.projectId, entry.scope])).toEqual([
        ["notes", "OPS"],
      ]);
    }),
  );
});
