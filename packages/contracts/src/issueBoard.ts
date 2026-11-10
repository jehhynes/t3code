import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IssueSummary } from "./issue.ts";

/** A GitHub Projects board read as one issue source, named in `settings.json`. */
export const GitHubBoardConfig = Schema.Struct({
  /** The user or organization login that owns the board. */
  owner: TrimmedNonEmptyString,
  number: PositiveInt,
  /** The single-select field that holds each issue's board status. */
  statusField: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("Status"))),
});
export type GitHubBoardConfig = typeof GitHubBoardConfig.Type;

/** An open issue that blocks a board issue. */
export const IssueBoardBlocker = Schema.Struct({
  scope: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
  displayKey: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type IssueBoardBlocker = typeof IssueBoardBlocker.Type;

/** One open issue on a board, with the T3 Code project for its repository, or none. */
export const IssueBoardEntry = Schema.Struct({
  ...IssueSummary.fields,
  /** The board's status for the issue; null when the issue has none. */
  status: Schema.NullOr(TrimmedNonEmptyString),
  blockers: Schema.Array(IssueBoardBlocker),
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueBoardEntry = typeof IssueBoardEntry.Type;

export const IssueBoard = Schema.Struct({
  owner: TrimmedNonEmptyString,
  number: PositiveInt,
  statusField: TrimmedNonEmptyString,
  entries: Schema.Array(IssueBoardEntry),
  /** Why the board could not be read; its entries are then empty. */
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueBoard = typeof IssueBoard.Type;

export const IssueBoardResult = Schema.Struct({
  boards: Schema.Array(IssueBoard),
});
export type IssueBoardResult = typeof IssueBoardResult.Type;
