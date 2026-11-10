// Fork-only: GitHub boards read as issue sources (jehhynes/t3code#2).
import * as Effect from "effect/Effect";
import {
  IssueTrackerKind,
  type GitHubBoardConfig,
  type IssueBoard,
  type ProjectId,
  type RepositoryOrigin,
} from "@t3tools/contracts";
import type { IssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";

import { boardSourceKey } from "../persistence/IssueBoardSources.ts";

const GITHUB = IssueTrackerKind.make("github");
const GITHUB_HOST = "github.com";
const BOARD_CONCURRENCY = 2;

/** A project and the tracker scope its repository resolves to. */
export interface BoardProjectScope {
  readonly project: { readonly id: ProjectId; readonly title: string };
  readonly tracker: IssueTrackerKind;
  readonly host: string;
  readonly scope: string;
  /** A fork checkout resolves to its upstream; `origin` is the fork, whose issues are its own. */
  readonly origin: RepositoryOrigin | null;
}

function originScope(origin: RepositoryOrigin | null): string | null {
  const prefix = `${GITHUB_HOST}/`;
  return origin?.canonicalKey.toLowerCase().startsWith(prefix) === true
    ? origin.canonicalKey.slice(prefix.length)
    : null;
}

/**
 * Each board's open issues, each under the first project whose repository it is in, as the
 * listing serves a repository from its first project, else the first whose origin it is. A
 * board that cannot be read carries why, and the other boards still list. A board that is off
 * is not read.
 */
export const readBoards = Effect.fn("IssueService.readBoards")(function* (input: {
  readonly boards: ReadonlyArray<GitHubBoardConfig>;
  /** The `boardSourceKey` of each board that is on. */
  readonly enabled: ReadonlySet<string>;
  readonly api: IssueTrackerApi | null;
  readonly projects: ReadonlyArray<BoardProjectScope>;
}) {
  const byRepository = new Map<string, BoardProjectScope["project"]>();
  const github = input.projects.filter(
    (candidate) => candidate.tracker === GITHUB && candidate.host === GITHUB_HOST,
  );
  // Own repositories first, so a fork's origin never takes a repository from its own project.
  const scopes = [
    ...github.map((candidate) => [candidate.scope, candidate.project] as const),
    ...github.map((candidate) => [originScope(candidate.origin), candidate.project] as const),
  ];
  for (const [scope, project] of scopes) {
    const key = scope?.toLowerCase();
    if (key !== undefined && !byRepository.has(key)) byRepository.set(key, project);
  }
  const listBoard = input.api?.listBoard;

  const boards = yield* Effect.forEach(
    input.boards,
    (board): Effect.Effect<IssueBoard> => {
      if (!input.enabled.has(boardSourceKey(board))) {
        return Effect.succeed({ ...board, enabled: false, entries: [], error: null });
      }
      const unread = (error: string): IssueBoard => ({
        ...board,
        enabled: true,
        entries: [],
        error,
      });
      if (listBoard === undefined) {
        return Effect.succeed(unread("GitHub boards cannot be read by this server."));
      }
      return listBoard({ ...board, host: GITHUB_HOST }).pipe(
        Effect.map((issues): IssueBoard => ({
          ...board,
          enabled: true,
          error: null,
          entries: issues.map((issue) => {
            const project = byRepository.get(issue.scope.toLowerCase()) ?? null;
            return {
              ...issue,
              tracker: GITHUB,
              host: GITHUB_HOST,
              projectId: project?.id ?? null,
              projectTitle: project?.title ?? null,
              playbook: null,
              hasOpenThread: false,
            };
          }),
        })),
        Effect.catch((error) =>
          Effect.succeed(unread(error.detail.trim() || "The board could not be read.")),
        ),
      );
    },
    { concurrency: BOARD_CONCURRENCY },
  );
  return { boards };
});
