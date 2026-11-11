// Fork-only: where an issue's new worktree may be made, and a draft's names for it (jehhynes/t3code#44).
import type { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";

const FIELD = /\{\{[^{}]*\}\}/;
const GITHUB_PREFIX = "github.com/";

export class IssueWorktreeError extends Schema.TaggedError<IssueWorktreeError>()(
  "IssueWorktreeError",
  {
    detail: Schema.String,
    worktreePath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** What a draft's new worktree is named; absent fields keep T3 Code's own. */
export interface DraftWorktreeNames {
  readonly branch?: string;
  readonly worktreePath?: string;
}

export class IssueWorktrees extends Context.Service<
  IssueWorktrees,
  {
    /**
     * Fails unless nothing exists at the folder and its parent is a folder that `issueWorktrees`
     * names for the project's own repository, or the fork's origin of it, as boards map issues.
     */
    readonly checkFolder: (input: {
      readonly workspaceRoot: string;
      readonly worktreePath: string;
    }) => Effect.Effect<void, IssueWorktreeError>;
    /** Names the draft's new worktree when the draft is sent, worked out then and kept once they hold. */
    readonly recordDraft: (
      threadId: ThreadId,
      names: (input: ThreadLaunchInput) => Effect.Effect<DraftWorktreeNames, IssueWorktreeError>,
    ) => Effect.Effect<void>;
    readonly forgetDraft: (threadId: ThreadId) => Effect.Effect<void>;
    /** A launch's input with a recorded draft's names, for a new worktree it does not name. */
    readonly nameDraft: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<ThreadLaunchInput, IssueWorktreeError>;
  }
>()("t3/issue/IssueWorktrees") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const drafts = yield* Ref.make(
    new Map<
      ThreadId,
      (input: ThreadLaunchInput) => Effect.Effect<DraftWorktreeNames, IssueWorktreeError>
    >(),
  );

  const fail = (detail: string, worktreePath?: string) =>
    new IssueWorktreeError({ detail, ...(worktreePath === undefined ? {} : { worktreePath }) });

  // Git's location for a path: the nearest real ancestor plus the components still missing.
  // Untraced: it recurses once per missing path component.
  const realLocation = (target: string): Effect.Effect<string> =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(target)));
      }),
    );

  const occupied = Effect.fn("IssueWorktrees.occupied")((target: string) =>
    Effect.all([
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true)),
      // A dangling symlink is not `exists`, but git would follow it.
      fileSystem.readLink(target).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    ]).pipe(Effect.map(([exists, link]) => exists || link)),
  );

  const checkFolder = Effect.fn("IssueWorktrees.checkFolder")(function* (input: {
    readonly workspaceRoot: string;
    readonly worktreePath: string;
  }) {
    const { worktreePath } = input;
    const leaf = path.basename(worktreePath);
    if (
      !path.isAbsolute(worktreePath) ||
      path.resolve(worktreePath) !== worktreePath ||
      leaf === "" ||
      leaf === "." ||
      leaf === ".."
    ) {
      return yield* fail(
        `The worktree folder "${worktreePath}" is not a normalized absolute path.`,
        worktreePath,
      );
    }
    if (yield* occupied(worktreePath)) {
      return yield* fail(`The worktree folder "${worktreePath}" already exists.`, worktreePath);
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new IssueWorktreeError({ detail: "The server settings could not be read.", cause }),
      ),
    );
    const home = yield* HostProcess.HomeDirectory;
    const identity = yield* repositories.resolve(input.workspaceRoot);
    const scopes = new Set(
      [identity?.canonicalKey, identity?.origin?.canonicalKey].flatMap((key) =>
        key?.toLowerCase().startsWith(GITHUB_PREFIX) === true
          ? [key.slice(GITHUB_PREFIX.length).toLowerCase()]
          : [],
      ),
    );
    const own = Object.entries(settings.issueWorktrees).flatMap(([repository, config]) =>
      scopes.has(repository.toLowerCase()) ? [config] : [],
    );
    const parents = own.flatMap((config) => {
      if (config.folder === undefined) return [];
      const parent = path.dirname(expandHomePath(config.folder, home));
      return FIELD.test(parent) ? [] : [path.resolve(input.workspaceRoot, parent)];
    });
    const real = yield* realLocation(path.dirname(worktreePath));
    // A filesystem root is never a worktrees folder, however a setting reaches it.
    if (path.dirname(real) !== real) {
      for (const parent of parents) {
        if ((yield* realLocation(parent)) === real) return;
      }
    }
    return yield* fail(
      `The worktree folder "${worktreePath}" is not in a folder that issueWorktrees in settings.json names.`,
      worktreePath,
    );
  });

  const recordDraft = Effect.fn("IssueWorktrees.recordDraft")(
    (
      threadId: ThreadId,
      names: (input: ThreadLaunchInput) => Effect.Effect<DraftWorktreeNames, IssueWorktreeError>,
    ) => Ref.update(drafts, (current) => new Map(current).set(threadId, names)),
  );

  const forgetDraft = Effect.fn("IssueWorktrees.forgetDraft")((threadId: ThreadId) =>
    Ref.update(drafts, (current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    }),
  );

  const nameDraft = Effect.fn("IssueWorktrees.nameDraft")(function* (input: ThreadLaunchInput) {
    const { threadId, workspaceStrategy: strategy } = input;
    if (
      threadId === undefined ||
      strategy.type !== "worktree" ||
      strategy.branch !== undefined ||
      strategy.worktreePath !== undefined
    ) {
      return input;
    }
    const names = Option.fromNullishOr((yield* Ref.get(drafts)).get(threadId));
    if (Option.isNone(names)) return input;
    const named = yield* names.value(input);
    // A replayed launch finds its folder made, so the checks must not run again.
    yield* Ref.update(drafts, (current) =>
      new Map(current).set(threadId, () => Effect.succeed(named)),
    );
    return { ...input, workspaceStrategy: { ...strategy, ...named } } satisfies ThreadLaunchInput;
  });

  return IssueWorktrees.of({ checkFolder, recordDraft, forgetDraft, nameDraft });
});

export const layer = Layer.effect(IssueWorktrees, make);
