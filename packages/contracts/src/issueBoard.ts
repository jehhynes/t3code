import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";
import { IssueSummary } from "./issue.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

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
  /** The first playbook in `playbooks.json` whose rules all match the issue, or none. */
  playbook: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Whether a thread linked to the issue is neither settled, archived nor deleted. */
  hasOpenThread: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * The playbook the issue waits for Start with, or none: an issue waits once each time it enters
   * a playbook's selection, until it is started or leaves. Absent from a server older than this.
   */
  waitingPlaybook: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * Why the last start of the entry the issue waits with failed, or none. Absent from a server
   * older than this.
   */
  startFailure: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type IssueBoardEntry = typeof IssueBoardEntry.Type;

const PlaybookNames = Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1));

/** Rules a board issue must all match; a rule left out matches every issue. */
export const IssuePlaybookRules = Schema.Struct({
  status: Schema.optionalKey(PlaybookNames),
  /** `owner/name`. */
  repository: Schema.optionalKey(PlaybookNames),
  /** The issue has at least one of these labels. */
  labels: Schema.optionalKey(PlaybookNames),
  /** Relative to the GitHub account the server reads boards with. */
  assignee: Schema.optionalKey(
    Schema.Literals(["me", "meAlone", "meAndOthers", "othersOnly", "nobody"]),
  ),
  /** Whether the issue has an open blocker. */
  blocked: Schema.optionalKey(Schema.Boolean),
});
export type IssuePlaybookRules = typeof IssuePlaybookRules.Type;

/** One entry of `playbooks.json`, which lists playbooks in the order they are tried. */
export const IssuePlaybook = Schema.Struct({
  name: TrimmedNonEmptyString,
  rules: IssuePlaybookRules.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  /** The started thread's first message; `{{issue.title}}` and the like name the issue's fields. */
  prompt: TrimmedNonEmptyString,
  /** Each launch setting left out takes what a new thread in the issue's project would. */
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  /** Starts its thread itself when an issue enters its selection, instead of waiting for Start. */
  autoStart: Schema.optionalKey(Schema.Boolean),
  /** Gives an issue without a worktree a new one; an issue's worktree serves its later threads. */
  requiresWorktree: Schema.optionalKey(Schema.Boolean),
});
export type IssuePlaybook = typeof IssuePlaybook.Type;

export const IssueBoard = Schema.Struct({
  owner: TrimmedNonEmptyString,
  number: PositiveInt,
  statusField: TrimmedNonEmptyString,
  /** Whether the board is read; a board is off, with no entries, until it is turned on. */
  enabled: Schema.Boolean,
  entries: Schema.Array(IssueBoardEntry),
  /** Why the board could not be read; its entries are then empty. */
  error: Schema.NullOr(TrimmedNonEmptyString),
});
export type IssueBoard = typeof IssueBoard.Type;

export const IssueBoardResult = Schema.Struct({
  boards: Schema.Array(IssueBoard),
  /** Mistakes in `playbooks.json`; an invalid playbook is left out and the rest still select. */
  playbookErrors: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /**
   * The names of the playbooks in `playbooks.json`, in its order, without those with a mistake.
   * Absent from a server older than this, which ignores a start's `startWith` and `guidance`.
   */
  playbooks: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type IssueBoardResult = typeof IssueBoardResult.Type;

/** Turns a board that settings name on or off; the server keeps this, not `settings.json`. */
export const IssueBoardSetEnabledInput = Schema.Struct({
  owner: TrimmedNonEmptyString,
  number: PositiveInt,
  enabled: Schema.Boolean,
});
export type IssueBoardSetEnabledInput = typeof IssueBoardSetEnabledInput.Type;

/** Starts the named playbook's thread for a board issue, as the board listed it. */
export const IssuePlaybookStartInput = Schema.Struct({
  /** The playbook whose selection the issue waits in; the start claims that entry. */
  playbook: TrimmedNonEmptyString,
  entry: IssueBoardEntry,
  /** Another playbook whose prompt and settings this start alone uses; the entry stays `playbook`'s. */
  startWith: Schema.optionalKey(TrimmedNonEmptyString),
  /** Text added after the prompt and a blank line, as written: no fields are filled in. */
  guidance: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
});
export type IssuePlaybookStartInput = typeof IssuePlaybookStartInput.Type;

export const IssuePlaybookStartResult = Schema.Struct({ threadId: ThreadId });
export type IssuePlaybookStartResult = typeof IssuePlaybookStartResult.Type;
