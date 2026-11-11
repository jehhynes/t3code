// Fork-only: the folder a playbook's new thread runs in (jehhynes/t3code#31).
import type { Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { ThreadLaunchWorkspaceStrategy } from "../orchestration-v2/ThreadLaunchService.ts";
import * as IssueThreadLinks from "../persistence/IssueThreadLinks.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const makeIssueWorkspace = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadLinks = yield* IssueThreadLinks.IssueThreadLinksRepository;

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

  return Effect.fn("IssueWorkspace.strategy")(function* (input: {
    readonly issueKey: string;
    readonly project: Project;
    readonly requiresWorktree: boolean;
    readonly startFromOrigin: boolean;
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
      baseRef: yield* defaultBaseRef(input.project.workspaceRoot),
      startFromOrigin: input.startFromOrigin,
    } satisfies ThreadLaunchWorkspaceStrategy;
  });
});
