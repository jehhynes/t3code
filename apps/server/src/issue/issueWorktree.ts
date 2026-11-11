// Fork-only: the folder a playbook's new thread runs in (jehhynes/t3code#31), and the names of an
// issue's new worktree (jehhynes/t3code#44).
import type { IssueBoardEntry, IssueWorktreeConfig, Project } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ThreadLaunchWorkspaceStrategy } from "../orchestration-v2/ThreadLaunchService.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { IssueWorktreeError, IssueWorktrees, type DraftWorktreeNames } from "./IssueWorktrees.ts";
import { hasWorktreeField, renderWorktreeName } from "./issueWorktreeNames.ts";

const MAX_BRANCH_BYTES = 200;
const MAX_LEAF_BYTES = 100;

/** The project's `issueWorktrees` entry for the issue's repository, matched as GitHub matches it. */
export function issueWorktreeConfig(
  settings: { readonly issueWorktrees: Readonly<Record<string, IssueWorktreeConfig>> },
  repository: string,
): IssueWorktreeConfig {
  const key = repository.toLowerCase();
  const found = Object.entries(settings.issueWorktrees).find(
    ([name]) => name.toLowerCase() === key,
  );
  return found?.[1] ?? {};
}

export const makeIssueWorkspace = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadLinks = yield* IssueThreadLinks.IssueThreadLinksRepository;
  const folders = yield* IssueWorktrees;

  const refExists = (cwd: string, revision: string) =>
    git.resolveCommit({ cwd, revision }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  // As `resolveScheduledTaskBaseRef` in `mcp/OrchestratorMcpService.ts` picks a scheduled task's base.
  const defaultBaseRef = Effect.fn("IssueWorkspace.defaultBaseRef")(function* (cwd: string) {
    const remoteName = yield* git
      .resolvePrimaryRemoteName(cwd)
      .pipe(Effect.orElseSucceed(() => null));
    const conventional = ["main", "master"];
    if (remoteName !== null) {
      const remoteDefault = yield* git
        .resolveDefaultBranchName(cwd, remoteName)
        .pipe(Effect.orElseSucceed(() => null));
      for (const branch of remoteDefault === null
        ? conventional
        : [remoteDefault, ...conventional]) {
        if (yield* refExists(cwd, `refs/remotes/${remoteName}/${branch}`)) {
          return `${remoteName}/${branch}`;
        }
      }
    }
    for (const branch of conventional) {
      if (yield* refExists(cwd, `refs/heads/${branch}`)) return branch;
    }
    return "main";
  });

  const real = (path: string) => fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));

  /** The issue's worktree while git still lists it in the project, compared by real path. */
  const liveWorktree = Effect.fn("IssueWorkspace.liveWorktree")(function* (
    issueKey: string,
    project: Project,
  ) {
    const worktree = yield* threadLinks.latestWorktree(issueKey, project.id);
    if (worktree === null) return null;
    const listed = yield* git
      .listWorktreePaths(project.workspaceRoot)
      .pipe(Effect.flatMap((paths) => Effect.forEach(paths, real)));
    return listed.includes(yield* real(worktree.worktreePath)) ? worktree : null;
  });

  const strategy = Effect.fn("IssueWorkspace.strategy")(function* (input: {
    readonly issueKey: string;
    readonly project: Project;
    readonly requiresWorktree: boolean;
    readonly startFromOrigin: boolean;
    readonly baseBranch?: string | undefined;
  }) {
    const worktree = yield* liveWorktree(input.issueKey, input.project);
    if (worktree !== null) {
      return {
        type: "existing_worktree",
        worktreePath: worktree.worktreePath,
        ...(worktree.branch === null ? {} : { branch: worktree.branch }),
      } satisfies ThreadLaunchWorkspaceStrategy;
    }
    if (!input.requiresWorktree) return { type: "root" } satisfies ThreadLaunchWorkspaceStrategy;
    return {
      type: "worktree",
      baseRef: input.baseBranch ?? (yield* defaultBaseRef(input.project.workspaceRoot)),
      startFromOrigin: input.startFromOrigin,
    } satisfies ThreadLaunchWorkspaceStrategy;
  });

  /** The branch and folder the project's settings give the issue's new worktree, both still free. */
  const names = Effect.fn("IssueWorkspace.names")(function* (input: {
    readonly entry: IssueBoardEntry;
    readonly project: Project;
    readonly config: IssueWorktreeConfig;
  }) {
    const { entry, project, config } = input;
    const fail = (detail: string) => new IssueWorktreeError({ detail });
    const render = (template: string) => {
      const rendered = renderWorktreeName(template, entry, config.types);
      return rendered.ok ? Effect.succeed(rendered.value) : Effect.fail(fail(rendered.error));
    };
    let named: DraftWorktreeNames = {};
    if (config.branch !== undefined) {
      const branch = yield* render(config.branch);
      if (Buffer.byteLength(branch) > MAX_BRANCH_BYTES) {
        return yield* fail(`The branch name "${branch}" is longer than ${MAX_BRANCH_BYTES} bytes.`);
      }
      if (isTemporaryWorktreeBranch(branch)) {
        return yield* fail(`The branch name "${branch}" looks like T3 Code's temporary names.`);
      }
      const valid =
        !branch.startsWith("-") &&
        (yield* git
          .execute({
            operation: "IssueWorkspace.names",
            cwd: project.workspaceRoot,
            args: ["check-ref-format", "--branch", branch],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) => result.exitCode === 0),
            Effect.orElseSucceed(() => false),
          ));
      if (!valid) return yield* fail(`Git does not accept "${branch}" as a branch name.`);
      if (yield* refExists(project.workspaceRoot, `refs/heads/${branch}`)) {
        return yield* fail(`The branch ${branch} already exists.`);
      }
      named = { ...named, branch };
    }
    if (config.folder !== undefined) {
      const template = expandHomePath(config.folder, yield* HostProcess.HomeDirectory);
      const parent = path.dirname(template);
      if (hasWorktreeField(parent)) {
        return yield* fail(
          `The folder "${config.folder}" may name issue fields only in its last part.`,
        );
      }
      const leaf = yield* render(path.basename(template));
      if (
        leaf === "" ||
        leaf === "." ||
        leaf === ".." ||
        leaf.includes("/") ||
        leaf.includes("\\") ||
        Buffer.byteLength(leaf) > MAX_LEAF_BYTES
      ) {
        return yield* fail(`"${leaf}" cannot be the last part of a worktree folder.`);
      }
      const worktreePath = path.join(path.resolve(project.workspaceRoot, parent), leaf);
      yield* folders.checkFolder({ workspaceRoot: project.workspaceRoot, worktreePath });
      named = { ...named, worktreePath };
    }
    return named;
  });

  return { strategy, names };
});
