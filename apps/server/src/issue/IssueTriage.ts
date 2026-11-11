// Fork-only: a triage playbook's classifier picks each issue's playbook (jehhynes/t3code#93).
import {
  type IssueBoardEntry,
  type IssueBoardResult,
  type IssuePlaybook,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import { issueThreadKey } from "../persistence/IssueThreadLinks.ts";
import { hasClaudeManagedMcpConfig } from "../provider/Drivers/ClaudeHome.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as IssueService from "./IssueService.ts";
import { snoozedUntil } from "./playbookEntries.ts";
import { PLAYBOOKS_FILE, readPlaybooksFile, triagePlaybookNamed } from "./playbookSelection.ts";
import { buildTriagePrompt, matchChoice } from "./triagePrompt.ts";

/** At most this many classifications run at once, each a paid model call. */
const CONCURRENT_CALLS = 2;

const FAILURE_TEXT = {
  unsupported:
    "Choosing a playbook needs a Claude model or a text generator API: set modelSelection on the triage playbook to a Claude model.",
  settings: "The server settings could not be read, so no playbook was chosen.",
  "issue-read": "The issue could not be read from GitHub, so no playbook was chosen.",
  timeout: "The classifier did not answer in time.",
  unlisted: "The classifier's answer named no listed playbook.",
  unanswered: "The classifier could not answer.",
  unsaved: "The chosen playbook could not be saved.",
} as const;

/**
 * Why a classification failed, by category only: its text is fixed, so no model or provider text
 * ever reaches the issue's row or the logs.
 */
export class IssueTriageFailure extends Schema.TaggedError<IssueTriageFailure>()(
  "IssueTriageFailure",
  {
    reason: Schema.Literals(Object.keys(FAILURE_TEXT) as Array<keyof typeof FAILURE_TEXT>),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return FAILURE_TEXT[this.reason];
  }
}

export class IssueTriage extends Context.Service<
  IssueTriage,
  {
    /**
     * Retry: the issue's entry, waiting unclassified in the triage playbook `playbook`, is
     * classified again at the next pass; answers whether it still waits so.
     */
    readonly retry: (input: {
      readonly playbook: string;
      readonly entry: IssueBoardEntry;
    }) => Effect.Effect<boolean, IssuePlaybookEntries.IssuePlaybookEntriesRepositoryError>;
  }
>()("t3/issue/IssueTriage") {}

export interface TriageCandidate {
  readonly triage: IssuePlaybook;
  readonly entry: IssueBoardEntry;
  readonly waitingSince: string | null;
}

/**
 * The issues to classify: waiting unclassified and unstarted with a triage playbook on a board
 * that is on and was read, with a project, no recorded failure and no snooze past `now`. None
 * while any playbook cannot select.
 */
export function triageCandidates(input: {
  readonly result: IssueBoardResult;
  readonly playbooks: ReadonlyArray<IssuePlaybook>;
  readonly rows: ReadonlyMap<string, IssuePlaybookEntries.PlaybookEntryRow>;
  /** A UTC ISO time. */
  readonly now: string;
}): ReadonlyArray<TriageCandidate> {
  if (input.result.playbookErrors.length > 0) return [];
  const candidates = new Map<string, TriageCandidate>();
  for (const board of input.result.boards) {
    if (!board.enabled || board.error !== null) continue;
    for (const entry of board.entries) {
      const triage = triagePlaybookNamed(input.playbooks, entry.waitingPlaybook ?? null);
      if (triage === undefined || entry.projectId === null) continue;
      const key = issueThreadKey(entry);
      const row = input.rows.get(key);
      if (
        row === undefined ||
        row.triage !== null ||
        row.startedBy !== null ||
        row.startFailure !== null ||
        snoozedUntil(row, input.now) !== null ||
        candidates.has(key)
      ) {
        continue;
      }
      candidates.set(key, { triage, entry, waitingSince: row.waitingSince });
    }
  }
  return [...candidates.values()];
}

/**
 * The classified, unstarted issues whose triage playbook no longer offers their choice, on a board
 * that is on and was read; none while any playbook cannot select.
 */
function droppedChoices(input: {
  readonly result: IssueBoardResult;
  readonly playbooks: ReadonlyArray<IssuePlaybook>;
  readonly rows: ReadonlyMap<string, IssuePlaybookEntries.PlaybookEntryRow>;
}): ReadonlyArray<IssuePlaybookEntries.PlaybookEntryRow> {
  if (input.result.playbookErrors.length > 0) return [];
  const dropped = new Map<string, IssuePlaybookEntries.PlaybookEntryRow>();
  for (const board of input.result.boards) {
    if (!board.enabled || board.error !== null) continue;
    for (const entry of board.entries) {
      const row = input.rows.get(issueThreadKey(entry));
      if (row?.triage == null || row.playbook === null || row.startedBy !== null) continue;
      const triage = triagePlaybookNamed(input.playbooks, row.triage);
      if (triage?.choices && matchChoice(row.playbook, triage.choices) !== null) continue;
      dropped.set(row.issueKey, row);
    }
  }
  return [...dropped.values()];
}

/** A classification in flight, or one that failed, until Retry or a new entry. */
interface Latch {
  readonly waitingSince: string | null;
  /** Set once it failed; `recorded` once the failure is on the issue's record. */
  readonly failure?: IssueTriageFailure;
  readonly recorded?: boolean;
}

const failed = (latch: Latch): latch is Latch & { readonly failure: IssueTriageFailure } =>
  latch.failure !== undefined;

const mapGenerationError = (error: TextGenerationError) =>
  new IssueTriageFailure({
    reason: /timed out/i.test(error.detail)
      ? "timeout"
      : /structured output|output format/i.test(error.detail)
        ? "unlisted"
        : "unanswered",
    cause: error,
  });

const make = Effect.gen(function* () {
  const issues = yield* IssueService.IssueService;
  const entries = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGenerators = yield* TextGenerators.TextGenerators;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const playbooksPath = path.join(path.dirname(config.settingsPath), PLAYBOOKS_FILE);
  const readPlaybooks = readPlaybooksFile(playbooksPath).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
  );
  const calls = yield* Semaphore.make(CONCURRENT_CALLS);
  const latches = new Map<string, Latch>();
  const scope = yield* Effect.scope;

  /** The selected model's text generation, only where it runs with no tools. */
  const toolFree = Effect.fn("IssueTriage.toolFree")(function* (selection: ModelSelection) {
    const runner = yield* textGenerators.runner(selection.instanceId);
    // A model API's request carries no tools.
    if (runner !== undefined) return TextGenerationOperations.fromRunner("TextGenerator", runner);
    const instance = yield* registry.getInstance(selection.instanceId);
    // Claude runs text generation with `--tools ""` and strict MCP, which a managed MCP config
    // overrides; Codex and OpenCode keep read tools, so they are refused.
    const managedMcp = yield* hasClaudeManagedMcpConfig().pipe(Effect.orElseSucceed(() => true));
    if (instance === undefined || instance.driverKind !== "claudeAgent" || managedMcp) {
      return yield* new IssueTriageFailure({ reason: "unsupported" });
    }
    return instance.textGeneration satisfies ProviderTextGeneration;
  });

  const classify = Effect.fn("IssueTriage.classify")(function* (
    candidate: TriageCandidate,
    playbooks: ReadonlyArray<IssuePlaybook>,
  ) {
    const { entry, triage } = candidate;
    if (entry.projectId === null) return yield* new IssueTriageFailure({ reason: "issue-read" });
    const detail = yield* issues
      .detail({
        projectId: entry.projectId,
        tracker: entry.tracker,
        host: entry.host,
        scope: entry.scope,
        key: entry.key,
      })
      .pipe(Effect.mapError((cause) => new IssueTriageFailure({ reason: "issue-read", cause })));
    const current = yield* settings.getSettings.pipe(
      Effect.mapError((cause) => new IssueTriageFailure({ reason: "settings", cause })),
    );
    const modelSelection = triage.modelSelection ?? current.textGenerationModelSelection;
    const generation = yield* toolFree(modelSelection);
    // No checkout in reach: the classifier only reads its prompt.
    const cwd = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-issue-triage-" })
      .pipe(Effect.mapError((cause) => new IssueTriageFailure({ reason: "unanswered", cause })));
    const choices = (triage.choices ?? []).flatMap((name) => {
      const chosen = playbooks.find(
        (playbook) => playbook.name.toLowerCase() === name.toLowerCase(),
      );
      return chosen === undefined ? [] : [chosen];
    });
    const prompt = buildTriagePrompt({
      triage,
      choices,
      issue: {
        entry,
        title: detail.title,
        body: detail.body,
        comments: detail.comments,
      },
      now: DateTime.formatIso(yield* DateTime.now),
      frameId: Buffer.from(yield* random.randomBytes(6)).toString("hex"),
    });
    const answer = yield* generation
      .generateTranscriptionPostProcessing({ cwd, prompt, modelSelection })
      .pipe(Effect.mapError(mapGenerationError));
    const chosen = matchChoice(answer.transcription, triage.choices ?? []);
    if (chosen === null) return yield* new IssueTriageFailure({ reason: "unlisted" });
    return chosen;
  }, Effect.scoped);

  const publish = issues.refreshWaiting.pipe(Effect.ignoreCause({ log: true }));

  // Each call owns the latch it set; a later entry's call may replace it, and then the earlier
  // call's outcome must not touch it.
  const owns = (issueKey: string, latch: Latch) => latches.get(issueKey) === latch;
  const release = (issueKey: string, latch: Latch) => {
    if (owns(issueKey, latch)) latches.delete(issueKey);
  };
  const replace = <L extends Latch>(issueKey: string, latch: Latch, next: L): L => {
    if (owns(issueKey, latch)) latches.set(issueKey, next);
    return next;
  };

  /** Writes a failure kept in a latch; a write that fails is tried again by the next pass. */
  const recordFailure = Effect.fn("IssueTriage.recordFailure")(function* (
    issueKey: string,
    triage: string,
    latch: Latch & { readonly failure: IssueTriageFailure },
  ) {
    const written = yield* entries
      .setTriage({
        issueKey,
        triage,
        waitingSince: latch.waitingSince,
        failure: latch.failure.message,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("A classification's failure could not be saved", {
            issue: issueKey,
            cause: cause._tag,
          }).pipe(Effect.as(null)),
        ),
      );
    if (written === null) return;
    if (written) {
      replace(issueKey, latch, { ...latch, recorded: true });
      yield* publish;
    } else {
      release(issueKey, latch);
    }
  });

  const fail = (issueKey: string, triage: string, latch: Latch, failure: IssueTriageFailure) =>
    Effect.logWarning("A triage playbook could not choose a playbook", {
      issue: issueKey,
      triage,
      reason: failure.reason,
    }).pipe(
      Effect.andThen(
        recordFailure(
          issueKey,
          triage,
          replace(issueKey, latch, { waitingSince: latch.waitingSince, failure }),
        ),
      ),
    );

  const run = Effect.fn("IssueTriage.run")(function* (queued: TriageCandidate, latch: Latch) {
    const issueKey = issueThreadKey(queued.entry);
    // Checked again once a call may start, against the file and the boards as they are now, so a
    // queued call spends nothing on an issue that moved and uses the triage playbook as it is.
    const { playbooks, errors } = yield* readPlaybooks;
    const rows = yield* entries.list;
    const now = DateTime.formatIso(yield* DateTime.now);
    const latest = yield* issues.withLatestBoard(Effect.succeed);
    const candidate =
      latest === null || errors.length > 0
        ? undefined
        : triageCandidates({ result: latest, playbooks, rows, now }).find(
            (current) =>
              issueThreadKey(current.entry) === issueKey &&
              current.waitingSince === latch.waitingSince &&
              current.triage.name.toLowerCase() === queued.triage.name.toLowerCase(),
          );
    if (candidate === undefined || !owns(issueKey, latch)) {
      release(issueKey, latch);
      return;
    }
    const triage = candidate.triage.name;
    const outcome = yield* classify(candidate, playbooks).pipe(
      // A defect's text could be the model's or the provider's, so only its category is kept.
      Effect.catchDefect(() => Effect.fail(new IssueTriageFailure({ reason: "unanswered" }))),
      Effect.result,
    );
    if (outcome._tag === "Failure") return yield* fail(issueKey, triage, latch, outcome.failure);
    // The file may have changed during the call: the choice counts only if it is still offered.
    const reread = yield* readPlaybooks;
    const offered = triagePlaybookNamed(reread.playbooks, triage)?.choices ?? [];
    const named = reread.errors.length === 0 ? matchChoice(outcome.success, offered) : null;
    const chosen =
      reread.playbooks.find((playbook) => playbook.name.toLowerCase() === named?.toLowerCase())
        ?.name ?? null;
    if (chosen === null) {
      release(issueKey, latch);
      // Published, so the next pass classifies it under the file as it is now.
      return yield* publish;
    }
    const written = yield* entries
      .setTriage({ issueKey, triage, waitingSince: latch.waitingSince, chosen })
      .pipe(Effect.result);
    if (written._tag === "Failure") {
      const failure = new IssueTriageFailure({ reason: "unsaved", cause: written.failure });
      return yield* fail(issueKey, triage, latch, failure);
    }
    release(issueKey, latch);
    // Another entry of the issue began during the call; the next pass classifies that one.
    if (!written.success) return yield* publish;
    yield* Effect.logInfo("A triage playbook chose a playbook", {
      issue: issueKey,
      triage,
      playbook: chosen,
    });
    yield* publish;
  });

  const pass = Effect.fn("IssueTriage.pass")(function* (result: IssueBoardResult) {
    if (result.playbookErrors.length > 0) return;
    const { playbooks, errors } = yield* readPlaybooks;
    if (errors.length > 0) return;
    const rows = yield* entries.list;
    const now = DateTime.formatIso(yield* DateTime.now);

    for (const [issueKey, latch] of latches) {
      const row = rows.get(issueKey);
      const sameEntry =
        row !== undefined &&
        row.triage === null &&
        row.startedBy === null &&
        row.waitingSince === latch.waitingSince;
      if (!sameEntry) {
        latches.delete(issueKey);
      } else if (failed(latch) && latch.recorded !== true && row.playbook !== null) {
        // The latch itself, so recording it marks the one the map holds.
        yield* recordFailure(issueKey, row.playbook, latch);
      }
    }

    let reset = false;
    for (const row of droppedChoices({ result, playbooks, rows })) {
      if (row.triage === null || row.playbook === null) continue;
      reset =
        (yield* entries.resetTriage({
          issueKey: row.issueKey,
          triage: row.triage,
          playbook: row.playbook,
          waitingSince: row.waitingSince,
        })) || reset;
    }
    if (reset) {
      // Published, so the next pass classifies them again.
      yield* publish;
      return;
    }

    for (const candidate of triageCandidates({ result, playbooks, rows, now })) {
      const issueKey = issueThreadKey(candidate.entry);
      if (latches.has(issueKey)) continue;
      const latch: Latch = { waitingSince: candidate.waitingSince };
      latches.set(issueKey, latch);
      yield* run(candidate, latch).pipe(
        calls.withPermits(1),
        // Only the record's and the board's own errors reach here; the call's are handled in
        // `run`. The latch keeps a fixed failure, so no paid call repeats until Retry.
        Effect.catchCause(() =>
          Effect.logError("A classification stopped", { issue: issueKey }).pipe(
            Effect.andThen(
              Effect.sync(() =>
                replace(issueKey, latch, {
                  waitingSince: latch.waitingSince,
                  failure: new IssueTriageFailure({ reason: "unanswered" }),
                }),
              ),
            ),
          ),
        ),
        Effect.forkIn(scope),
      );
    }
  });

  // Waits for startup recovery, as the board timer does.
  yield* forkParked(
    issues.boardChanges.pipe(
      Stream.runForEach((result) => pass(result).pipe(Effect.ignoreCause({ log: true }))),
    ),
  );

  const retry: IssueTriage["Service"]["retry"] = Effect.fn("IssueTriage.retry")(function* ({
    playbook,
    entry,
  }) {
    const issueKey = issueThreadKey(entry);
    const row = (yield* entries.list).get(issueKey);
    if (row === undefined) return false;
    const cleared = yield* entries.setTriage({
      issueKey,
      triage: playbook,
      waitingSince: row.waitingSince,
      failure: null,
    });
    // A call still running keeps its latch; a failure's latch gives way to the next pass.
    if (cleared && latches.get(issueKey)?.failure !== undefined) latches.delete(issueKey);
    return cleared;
  });

  return IssueTriage.of({ retry });
});

export const layer = Layer.effect(IssueTriage, make);
