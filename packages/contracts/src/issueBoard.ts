import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { IssueSummary } from "./issue.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** A GitHub Projects board read as one issue source, named in `settings.json`. */
export const GitHubBoardConfig = Schema.Struct({
  /** The user or organization login that owns the board. */
  owner: TrimmedNonEmptyString,
  number: PositiveInt,
  /** The single-select field that holds each issue's board status. */
  statusField: TrimmedNonEmptyString.pipe(Schema.withDecodingDefault(Effect.succeed("Status"))),
  /** Holds each issue's start while it has an open blocker (jehhynes/t3code#65). */
  waitForBlockers: Schema.optionalKey(Schema.Boolean),
});
export type GitHubBoardConfig = typeof GitHubBoardConfig.Type;

/**
 * How a project names an issue's new worktree, keyed in `settings.json` by the issue's repository
 * (jehhynes/t3code#44). Each field left out keeps T3 Code's own behavior for it.
 */
export const IssueWorktreeConfig = Schema.Struct({
  /** A branch name with `{{issue.type}}`, `{{issue.number}}` and `{{issue.slug}}`. */
  branch: Schema.optionalKey(TrimmedNonEmptyString),
  /** Absolute, `~/…` or relative to the project's folder; fields only in its last part. */
  folder: Schema.optionalKey(TrimmedNonEmptyString),
  baseBranch: Schema.optionalKey(TrimmedNonEmptyString),
  /** Label to `{{issue.type}}`; the first label it names wins, else `feat`. */
  types: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString)),
});
export type IssueWorktreeConfig = typeof IssueWorktreeConfig.Type;

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
  /**
   * Whether Start on the issue was queued until its blockers close (jehhynes/t3code#65). Absent
   * from a server older than this.
   */
  startQueued: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether the server starts the waiting issue by itself once no open blocker is left: it was
   * queued, or its playbook starts by itself and has not tried it. Absent from an older server.
   */
  startsBySelf: Schema.optionalKey(Schema.Boolean),
  /**
   * Until when the waiting issue is snoozed, as a UTC ISO time; nothing starts it before then
   * (jehhynes/t3code#86). A time that has passed no longer holds it. Absent from an older server.
   */
  snoozedUntil: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * The triage playbook whose classifier chose `waitingPlaybook`, or none (jehhynes/t3code#93).
   * Absent from an older server.
   */
  triagedBy: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * When the first turn of the issue's earlier thread started, as a UTC ISO time, when the
   * classifier found no comment by anyone else newer: the issue waits for Start
   * (jehhynes/t3code#100). Absent from an older server.
   */
  nothingNewSince: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /**
   * How many threads for the issue the playbook it waits with started and that ran a turn, and
   * when the first turn of the latest of them started, as a UTC ISO time; none when there are
   * none (jehhynes/t3code#102). Absent from an older server.
   */
  returned: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ count: PositiveInt, lastAt: Schema.String })),
  ),
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
  /**
   * Makes this a triage playbook (jehhynes/t3code#93): a classifier picks one of these playbooks
   * for each issue it selects, with `prompt` as its instructions and `modelSelection` as its model.
   */
  choices: Schema.optionalKey(PlaybookNames),
  /** The classifier's one line for a playbook a triage playbook chooses; such a playbook has no rules. */
  description: Schema.optionalKey(TrimmedNonEmptyString),
});
export type IssuePlaybook = typeof IssuePlaybook.Type;

export const IssueBoard = Schema.Struct({
  owner: TrimmedNonEmptyString,
  number: PositiveInt,
  statusField: TrimmedNonEmptyString,
  /** Whether the board is read; a board is off, with no entries, until it is turned on. */
  enabled: Schema.Boolean,
  /** Whether an issue with an open blocker waits to start; absent from an older server. */
  waitForBlockers: Schema.optionalKey(Schema.Boolean),
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
   * Absent from a server older than this.
   */
  playbooks: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /**
   * The names of the triage playbooks among `playbooks` (jehhynes/t3code#93): an issue waiting with
   * one is still being classified. Absent from an older server.
   */
  triagePlaybooks: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type IssueBoardResult = typeof IssueBoardResult.Type;

/** Turns a board that settings name on or off; the server keeps this, not `settings.json`. */
export const IssueBoardSetEnabledInput = Schema.Struct({
  owner: TrimmedNonEmptyString,
  number: PositiveInt,
  enabled: Schema.Boolean,
});
export type IssueBoardSetEnabledInput = typeof IssueBoardSetEnabledInput.Type;

/**
 * Starts the named playbook's thread for a board issue, as the board listed it, or queues the start
 * while the issue has an open blocker; takes a queued start back; or snoozes the waiting issue until
 * `until`, or wakes it with null.
 */
export const IssuePlaybookStartInput = Schema.Union([
  Schema.Struct({
    /** The playbook whose selection the issue waits in; the start claims that entry. */
    playbook: TrimmedNonEmptyString,
    entry: IssueBoardEntry,
  }),
  // No `entry` key, so a server older than jehhynes/t3code#65 refuses it rather than start it.
  Schema.Struct({ playbook: TrimmedNonEmptyString, cancelQueued: IssueBoardEntry }),
  // Neither key either, so a server older than jehhynes/t3code#86 refuses it too.
  Schema.Struct({
    playbook: TrimmedNonEmptyString,
    snooze: IssueBoardEntry,
    until: Schema.NullOr(IsoDateTime),
  }),
]);
export type IssuePlaybookStartInput = typeof IssuePlaybookStartInput.Type;

/** The started thread; null when the start was queued, taken back, or the issue was snoozed. */
export const IssuePlaybookStartResult = Schema.Struct({ threadId: Schema.NullOr(ThreadId) });
export type IssuePlaybookStartResult = typeof IssuePlaybookStartResult.Type;

/** What a draft thread for a board issue holds before I send it, as Start would launch it. */
export const IssuePlaybookDraftInput = Schema.Struct({
  /** The playbook whose selection the issue waits in. */
  playbook: TrimmedNonEmptyString,
  entry: IssueBoardEntry,
  /** Another playbook whose prompt and settings the draft takes. */
  use: Schema.optionalKey(TrimmedNonEmptyString),
});
export type IssuePlaybookDraftInput = typeof IssuePlaybookDraftInput.Type;

/**
 * Whether the issue is held: its board waits for blockers and it has an open one
 * (jehhynes/t3code#65).
 */
export const heldByBlockers = (
  board: Pick<IssueBoard, "waitForBlockers">,
  entry: Pick<IssueBoardEntry, "blockers">,
): boolean => board.waitForBlockers === true && entry.blockers.length > 0;

/** The prompt is rendered with the issue's fields, its free text framed as untrusted data. */
export const IssuePlaybookDraft = Schema.Union([
  /** The issue's open thread takes the prompt in its composer and keeps its own settings. */
  Schema.Struct({ prompt: Schema.String, threadId: ThreadId }),
  /** A new draft, with the settings and folder Start would launch with. */
  Schema.Struct({
    prompt: Schema.String,
    threadId: Schema.Null,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
    workspace: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  }),
]);
export type IssuePlaybookDraft = typeof IssuePlaybookDraft.Type;

/** My next new message accepted on `threadId` starts the issue's entry in `playbook`'s selection. */
export const IssuePlaybookStartOnSendInput = Schema.Struct({
  playbook: TrimmedNonEmptyString,
  entry: IssueBoardEntry,
  threadId: ThreadId,
  /** Another playbook whose prompt the draft took (jehhynes/t3code#102). */
  use: Schema.optionalKey(TrimmedNonEmptyString),
});
export type IssuePlaybookStartOnSendInput = typeof IssuePlaybookStartOnSendInput.Type;
