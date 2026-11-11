import * as Effect from "effect/Effect";
import { IssueTrackerKind, type GitHubBoardConfig } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type TrackerBoardIssue,
} from "@t3tools/issue-tracker-core/server/IssueTracker";

import type * as Board from "./board.graphql.ts";
import { toSummary } from "./gitHubIssueJson.ts";

const KIND = IssueTrackerKind.make("github");
const OPERATION = "listBoard";
/** GitHub search answers at most this many results, however many pages are read. */
const SEARCH_LIMIT = 1_000;

export interface BoardQueries {
  readonly fields: (
    variables: Board.BoardFields.Variables,
  ) => Effect.Effect<Board.BoardFields.Result, IssueTrackerError>;
  readonly issues: (
    variables: Board.BoardIssues.Variables,
  ) => Effect.Effect<Board.BoardIssues.Result, IssueTrackerError>;
  /** Answers `{ repository: null }` for a missing repository or issue. */
  readonly issue: (
    variables: Board.BoardIssue.Variables,
  ) => Effect.Effect<Board.BoardIssue.Result, IssueTrackerError>;
}

const failure = (detail: string) =>
  new IssueTrackerError({ tracker: KIND, operation: OPERATION, reason: "failed", detail });

const sameLogin = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const issueId = (issue: { readonly scope: string; readonly key: string }) =>
  `${issue.scope.toLowerCase()}#${issue.key}`;

function boardLabel(board: GitHubBoardConfig): string {
  return `${board.owner}/${board.number}`;
}

/** Why the board's status field cannot hold a status, or null when it is a single-select field. */
function fieldProblem(board: GitHubBoardConfig, result: Board.BoardFields.Result): string | null {
  const owner = result.repositoryOwner;
  const project = owner !== null && "projectV2" in owner ? owner.projectV2 : null;
  if (project === null) return missingBoard(board);
  const field = (project.fields.nodes ?? []).find(
    (node) => node !== null && "name" in node && node.name === board.statusField,
  );
  if (field == null) {
    return `Project ${boardLabel(board)} has no field named "${board.statusField}".`;
  }
  return field.__typename === "ProjectV2SingleSelectField"
    ? null
    : `The "${board.statusField}" field on project ${boardLabel(board)} is a ${field.__typename}, not a single-select field.`;
}

function missingBoard(board: GitHubBoardConfig): string {
  return `GitHub has no project ${boardLabel(board)} that this account can read.`;
}

type BoardNode = Board.BoardIssueNode & {
  readonly projectItems: {
    readonly nodes: ReadonlyArray<Board.BoardProjectItem | null> | null;
  } | null;
};

function boardItem(board: GitHubBoardConfig, node: BoardNode): Board.BoardProjectItem | undefined {
  return (node.projectItems?.nodes ?? []).find(
    (entry): entry is Board.BoardProjectItem =>
      entry !== null &&
      entry.project.number === board.number &&
      "login" in entry.project.owner &&
      sameLogin(entry.project.owner.login, board.owner),
  );
}

function toBoardIssue(board: GitHubBoardConfig, node: BoardNode): TrackerBoardIssue {
  const value = boardItem(board, node)?.fieldValueByName;
  const status = value != null && "name" in value ? value.name?.trim() || null : null;
  const scope = node.repository.nameWithOwner;
  return {
    ...toSummary(node),
    scope,
    status,
    blockers: (node.blockedBy.nodes ?? []).flatMap((blocker) =>
      blocker === null || blocker.state !== "OPEN"
        ? []
        : [
            {
              scope: blocker.repository.nameWithOwner,
              key: String(blocker.number),
              displayKey: sameLogin(blocker.repository.nameWithOwner, scope)
                ? `#${blocker.number}`
                : `${blocker.repository.nameWithOwner}#${blocker.number}`,
              title: blocker.title,
              url: blocker.url,
            },
          ],
    ),
  };
}

/**
 * Each recorded issue the search left out that a read of its own finds open and on the board.
 * Search can succeed with an incomplete result, so a recorded issue counts as gone only on that
 * read's word, and a read that cannot tell fails the board.
 */
const confirmLeftOut = Effect.fn("GitHubBoard.confirmLeftOut")(function* (
  queries: BoardQueries,
  board: GitHubBoardConfig,
  leftOut: ReadonlyArray<{ readonly scope: string; readonly key: string }>,
) {
  const found = yield* Effect.forEach(
    leftOut,
    (issue) => {
      const unconfirmed = (detail: string) =>
        failure(
          `Could not confirm that ${issue.scope}#${issue.key} left project ${boardLabel(board)}: ${detail}`,
        );
      const [owner = "", name = ""] = issue.scope.split("/");
      const number = Number(issue.key);
      if (!Number.isSafeInteger(number) || number <= 0) {
        return Effect.fail(unconfirmed("it is not a GitHub issue number."));
      }
      return queries.issue({ owner, name, number, status: board.statusField }).pipe(
        Effect.mapError((error) => unconfirmed(error.detail.trim() || "No reason was given.")),
        Effect.flatMap(
          ({ repository }): Effect.Effect<TrackerBoardIssue | null, IssueTrackerError> => {
            const node = repository?.issue ?? null;
            if (node === null || node.state !== "OPEN") return Effect.succeed(null);
            if (node.projectItems?.nodes == null) {
              return Effect.fail(unconfirmed("GitHub did not say which projects it is on."));
            }
            if (boardItem(board, node) !== undefined) {
              return Effect.succeed(toBoardIssue(board, node));
            }
            return node.projectItems.pageInfo.hasNextPage
              ? Effect.fail(unconfirmed("it is on more projects than one read lists."))
              : Effect.succeed(null);
          },
        ),
      );
    },
    // Unbounded, so the resolver batches them into shared requests.
    { concurrency: "unbounded" },
  );
  return found.filter((issue) => issue !== null);
});

/**
 * Every open issue on the board, across its repositories, in one search scoped by the board,
 * with each `recorded` issue the search left out that its own read finds still on it. The status
 * field is checked first, because a field that cannot hold a status would read every issue as
 * having none.
 */
export const readBoard = Effect.fn("GitHubBoard.readBoard")(function* (
  queries: BoardQueries,
  board: GitHubBoardConfig,
  recorded: ReadonlyArray<{ readonly scope: string; readonly key: string }> = [],
) {
  const fields = yield* queries.fields({ owner: board.owner, number: board.number }).pipe(
    Effect.catchIf(
      (error) => error.reason === "not-found",
      () => Effect.fail(failure(missingBoard(board))),
    ),
  );
  const problem = fieldProblem(board, fields);
  if (problem !== null) return yield* failure(problem);

  const q = `is:issue is:open project:${boardLabel(board)}`;
  const issues: TrackerBoardIssue[] = [];
  let cursor: string | null = null;
  while (true) {
    const { search }: Board.BoardIssues.Result = yield* queries.issues({
      q,
      status: board.statusField,
      cursor,
    });
    if (search.issueCount > SEARCH_LIMIT) {
      return yield* failure(
        `Project ${boardLabel(board)} has more than ${SEARCH_LIMIT.toLocaleString("en-US")} open issues, which GitHub search cannot list.`,
      );
    }
    for (const node of search.nodes ?? []) {
      if (node !== null && node.__typename === "Issue") issues.push(toBoardIssue(board, node));
    }
    if (!search.pageInfo.hasNextPage) {
      const listed = new Set(issues.map((issue) => issueId(issue)));
      const leftOut = recorded.filter((issue) => !listed.has(issueId(issue)));
      if (leftOut.length === 0) return issues;
      return [...issues, ...(yield* confirmLeftOut(queries, board, leftOut))];
    }
    if (search.pageInfo.endCursor === null || search.pageInfo.endCursor === cursor) {
      return yield* failure(`GitHub did not return the rest of project ${boardLabel(board)}.`);
    }
    cursor = search.pageInfo.endCursor;
  }
});
