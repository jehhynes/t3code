// Fork-only: playbooks that start by themselves, with the boards read on a timer
// (jehhynes/t3code#10).
import {
  DEFAULT_GITHUB_BOARD_READ_INTERVAL,
  heldByBlockers,
  type IssueBoardEntry,
  type IssueBoardResult,
  type IssuePlaybook,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as IssuePlaybookEntries from "../persistence/IssuePlaybookEntries.ts";
import { issueThreadKey } from "../persistence/IssueThreadLinks.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueService from "./IssueService.ts";
import * as PlaybookStartService from "./PlaybookStartService.ts";
import { selfStartingPlaybooks } from "./playbookEntries.ts";
import { PLAYBOOKS_FILE, readPlaybooksFile } from "./playbookSelection.ts";

const MIN_BOARD_READ_INTERVAL = Duration.seconds(10);

export interface AutoStart {
  readonly playbook: string;
  readonly entry: IssueBoardEntry;
}

/**
 * The issues to start by themselves: each waits with a playbook that starts by itself and was not
 * tried yet, or was queued by Start (jehhynes/t3code#65); has a project; and has no open blocker
 * on a board that waits for blockers. None while any playbook cannot select.
 */
export function autoStartEntries(input: {
  readonly result: IssueBoardResult;
  readonly playbooks: ReadonlyArray<IssuePlaybook>;
  readonly rows: ReadonlyMap<string, IssuePlaybookEntries.PlaybookEntryRow>;
}): ReadonlyArray<AutoStart> {
  if (input.result.playbookErrors.length > 0) return [];
  const selfStarting = selfStartingPlaybooks(input.playbooks);
  const starts: AutoStart[] = [];
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
      const untried = selfStarting.has(playbook.toLowerCase()) && row?.autoTried === false;
      if (!untried && row?.startQueued !== true) continue;
      starts.push({ playbook, entry });
    }
  }
  return starts;
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

  const startWaiting = Effect.fn("PlaybookAutoStart.startWaiting")(function* (
    result: IssueBoardResult,
  ) {
    const { playbooks } = yield* readPlaybooksFile(playbooksPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    const rows = yield* entries.list;
    for (const candidate of autoStartEntries({ result, playbooks, rows })) {
      const key = issueThreadKey(candidate.entry);
      // Start checks again, against the latest read, that the issue still waits.
      yield* starts.start(candidate, { auto: true }).pipe(
        Effect.tap(({ threadId }) =>
          Effect.logInfo("A playbook started by itself", {
            issue: key,
            playbook: candidate.playbook,
            threadId,
          }),
        ),
        // The issue waits for Start; nothing tries it again by itself.
        Effect.catch((error) =>
          Effect.logWarning("A playbook could not start by itself", {
            issue: key,
            playbook: candidate.playbook,
            detail: error.detail,
          }),
        ),
      );
    }
  });

  // A value meant as minutes or seconds would read GitHub without pause and use up its limit.
  const effectiveInterval = (setting: Duration.Duration) =>
    Duration.isPositive(setting)
      ? Duration.max(setting, MIN_BOARD_READ_INTERVAL)
      : DEFAULT_GITHUB_BOARD_READ_INTERVAL;
  // Subscribed before the interval is read, so a change in between is not missed; a new interval
  // ends the old wait.
  const waitForNextRead = Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* settings.subscribeChanges;
      const wait = effectiveInterval(
        yield* settings.getSettings.pipe(
          Effect.map((current) => current.githubBoardReadInterval),
          Effect.orElseSucceed(() => DEFAULT_GITHUB_BOARD_READ_INTERVAL),
        ),
      );
      yield* changes.pipe(
        Stream.filter(
          (current) => !Duration.equals(effectiveInterval(current.githubBoardReadInterval), wait),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.void }),
      );
    }),
  );

  // Waits for startup recovery, as scheduled work does, so it never races a recovering turn.
  yield* forkParked(
    issues.boardChanges.pipe(
      Stream.runForEach((result) => startWaiting(result).pipe(Effect.ignoreCause({ log: true }))),
    ),
  );
  yield* forkParked(
    Effect.forever(
      issues.board.pipe(Effect.ignoreCause({ log: true }), Effect.andThen(waitForNextRead)),
    ),
  );
});

/** Reads every board that is on, whether or not a client is connected, and starts what waits. */
export const layer = Layer.effectDiscard(run);
