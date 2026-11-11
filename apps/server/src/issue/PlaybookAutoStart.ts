// Fork-only: playbooks that start by themselves, with the boards read on a timer
// (jehhynes/t3code#10).
import {
  DEFAULT_GITHUB_BOARD_READ_INTERVAL,
  type GitHubBoardConfig,
  heldByBlockers,
  type IssueBoardEntry,
  type IssueBoardResult,
  type IssuePlaybook,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import { issueThreadKey } from "../persistence/IssueThreadLinks.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueService from "./IssueService.ts";
import * as PlaybookStartService from "./PlaybookStartService.ts";
import { selfStartingPlaybooks, snoozedUntil } from "./playbookEntries.ts";
import { PLAYBOOKS_FILE, readPlaybooksFile } from "./playbookSelection.ts";

const MIN_BOARD_READ_INTERVAL = Duration.seconds(10);

export interface AutoStart {
  readonly playbook: string;
  readonly entry: IssueBoardEntry;
}

/**
 * The waiting issues to start by themselves: self-starting and untried, or queued (#65); with a
 * project, no open blocker on a board that waits for them, and no snooze past `now` (#86). None
 * while any playbook cannot select. Oldest wait first, a pre-#76 record first, then board order.
 */
export function autoStartEntries(input: {
  readonly result: IssueBoardResult;
  readonly playbooks: ReadonlyArray<IssuePlaybook>;
  readonly rows: ReadonlyMap<string, IssuePlaybookEntries.PlaybookEntryRow>;
  /** A UTC ISO time. */
  readonly now: string;
}): ReadonlyArray<AutoStart> {
  if (input.result.playbookErrors.length > 0) return [];
  const selfStarting = selfStartingPlaybooks(input.playbooks);
  const starts: Array<AutoStart & { readonly waitingSince: string }> = [];
  for (const board of input.result.boards) {
    if (!board.enabled || board.error !== null) continue;
    for (const entry of board.entries) {
      const playbook = entry.waitingPlaybook ?? null;
      if (playbook === null) continue;
      // It waits with that reason until its repository has a project.
      if (entry.projectId === null) continue;
      // Held until a read shows no open blocker; the hold is no try.
      if (heldByBlockers(board, entry)) continue;
      const row = input.rows.get(issueThreadKey(entry));
      // Held until its wake; the snooze is no try, and a queued start stays queued.
      if (snoozedUntil(row, input.now) !== null) continue;
      const untried = selfStarting.has(playbook.toLowerCase()) && row?.autoTried === false;
      if (!untried && row?.startQueued !== true) continue;
      starts.push({ playbook, entry, waitingSince: row?.waitingSince ?? "" });
    }
  }
  // Stable, and ISO times order as strings.
  return starts
    .toSorted((a, b) =>
      a.waitingSince < b.waitingSince ? -1 : a.waitingSince > b.waitingSince ? 1 : 0,
    )
    .map(({ playbook, entry }) => ({ playbook, entry }));
}

const run = Effect.gen(function* () {
  const issues = yield* IssueService.IssueService;
  const starts = yield* PlaybookStartService.PlaybookStartService;
  const entries = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const playbooksPath = path.join(path.dirname(config.settingsPath), PLAYBOOKS_FILE);

  // One pass at a time, so a board read's pass and a freed slot's pass do not race.
  const passes = yield* Semaphore.make(1);
  const startWaiting = Effect.fn("PlaybookAutoStart.startWaiting")(function* (
    result: IssueBoardResult,
  ) {
    const { playbooks } = yield* readPlaybooksFile(playbooksPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    const rows = yield* entries.list;
    const now = DateTime.formatIso(yield* DateTime.now);
    for (const candidate of autoStartEntries({ result, playbooks, rows, now })) {
      const key = issueThreadKey(candidate.entry);
      // Start checks again, against the latest read, that the issue still waits.
      const started = yield* starts.start(candidate, { auto: true }).pipe(
        Effect.tap(({ threadId }) =>
          threadId === null
            ? Effect.void
            : Effect.logInfo("A playbook started by itself", {
                issue: key,
                playbook: candidate.playbook,
                threadId,
              }),
        ),
        Effect.map(({ threadId }) => threadId !== null),
        // The issue waits for Start; nothing tries it again by itself.
        Effect.catch((error) =>
          Effect.logWarning("A playbook could not start by itself", {
            issue: key,
            playbook: candidate.playbook,
            detail: error.detail,
          }).pipe(Effect.as(true)),
        ),
      );
      // No slot is free; the rest wait their turn (jehhynes/t3code#76).
      if (!started) return;
    }
  }, passes.withPermits(1));

  // A value meant as minutes or seconds would read GitHub without pause and use up its limit.
  const effectiveInterval = (setting: Duration.Duration) =>
    Duration.isPositive(setting)
      ? Duration.max(setting, MIN_BOARD_READ_INTERVAL)
      : DEFAULT_GITHUB_BOARD_READ_INTERVAL;
  const readBoardList = settings.getSettings.pipe(
    Effect.map((current) => current.githubBoards),
    Effect.orElseSucceed(() => undefined),
  );
  // Subscribed before the settings are read, so a change in between is not missed; a new interval
  // ends the old wait, and so does a board list other than the one the last read began with
  // (jehhynes/t3code#85), so an added or removed board reaches the Issues page at once.
  const waitForNextRead = Effect.fn("PlaybookAutoStart.waitForNextRead")(function* (
    readWith: ReadonlyArray<GitHubBoardConfig> | undefined,
  ) {
    const changes = yield* settings.subscribeChanges;
    const boardsChanged = (next: { readonly githubBoards: ReadonlyArray<GitHubBoardConfig> }) =>
      readWith !== undefined && !Equal.equals(next.githubBoards, readWith);
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isSome(current) && boardsChanged(current.value)) return;
    const wait = effectiveInterval(
      Option.match(current, {
        onNone: () => DEFAULT_GITHUB_BOARD_READ_INTERVAL,
        onSome: (value) => value.githubBoardReadInterval,
      }),
    );
    yield* changes.pipe(
      Stream.filter(
        (next) =>
          !Duration.equals(effectiveInterval(next.githubBoardReadInterval), wait) ||
          boardsChanged(next),
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.void }),
    );
  }, Effect.scoped);

  // Waits for startup recovery, as scheduled work does, so it never races a recovering turn.
  yield* forkParked(
    issues.boardChanges.pipe(
      Stream.runForEach((result) => startWaiting(result).pipe(Effect.ignoreCause({ log: true }))),
    ),
  );
  yield* forkParked(
    Effect.forever(
      readBoardList.pipe(
        Effect.flatMap((readWith) =>
          issues.board.pipe(
            Effect.ignoreCause({ log: true }),
            Effect.andThen(waitForNextRead(readWith)),
          ),
        ),
      ),
    ),
  );
  // Fork-only (jehhynes/t3code#76): a freed slot starts what waits for one without a board read.
  // The latest read is copied out first, because a start takes the board's lock itself.
  yield* forkParked(
    Effect.forever(
      starts.awaitFreedSlot.pipe(
        Effect.andThen(issues.withLatestBoard(Effect.succeed)),
        Effect.flatMap((latest) => (latest === null ? Effect.void : startWaiting(latest))),
        Effect.ignoreCause({ log: true }),
      ),
    ),
  );
});

/** Reads every board that is on, whether or not a client is connected, and starts what waits. */
export const layer = Layer.effectDiscard(run);
