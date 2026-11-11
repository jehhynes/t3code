// Fork-only: an issue waits for Start once each time it enters a selection (jehhynes/t3code#7).
import {
  heldByBlockers,
  type IssueBoard,
  type IssueBoardEntry,
  type IssueBoardResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { boardSourceKey } from "../persistence/IssueBoardSources.ts";
import {
  OPEN_THREAD,
  snoozedPast,
  type PlaybookEntryRow,
} from "../persistence/IssuePlaybookEntries.ts";
import { issueThreadKey } from "../persistence/IssueThreadLinks.ts";

const samePlaybook = (a: string | null, b: string | null) =>
  (a?.toLowerCase() ?? null) === (b?.toLowerCase() ?? null);

/** The playbook an issue waits for Start with: its entry's, until that entry is started. */
export const waitingPlaybook = (row: PlaybookEntryRow | undefined): string | null =>
  row !== undefined && row.startedBy === null ? row.playbook : null;

/** Why the start of the entry the issue waits with last failed, or null (jehhynes/t3code#19). */
export const startFailure = (row: PlaybookEntryRow | undefined): string | null =>
  waitingPlaybook(row) === null ? null : (row?.startFailure ?? null);

/** Until when the waiting entry is snoozed past `now`, or null (jehhynes/t3code#86). */
export const snoozedUntil = (row: PlaybookEntryRow | undefined, now: string): string | null =>
  waitingPlaybook(row) !== null && row !== undefined && snoozedPast(row.snoozedUntil, now)
    ? row.snoozedUntil
    : null;

/**
 * What a board entry shows of its record: the playbook it waits with, its last failure, whether
 * the server starts it by itself once no open blocker is left (jehhynes/t3code#65), and until when
 * it is snoozed (#86), which the client compares with its own clock.
 */
export function waitingFields(
  row: PlaybookEntryRow | undefined,
  /** The lowercased names of the playbooks that start by themselves. */
  selfStarting: ReadonlySet<string>,
) {
  const playbook = waitingPlaybook(row);
  const startQueued = playbook !== null && row?.startQueued === true;
  return {
    waitingPlaybook: playbook,
    startFailure: startFailure(row),
    startQueued,
    startsBySelf:
      startQueued ||
      (playbook !== null && selfStarting.has(playbook.toLowerCase()) && row?.autoTried === false),
    snoozedUntil: playbook === null ? null : (row?.snoozedUntil ?? null),
    triagedBy: playbook === null ? null : (row?.triage ?? null), // Fork-only (jehhynes/t3code#93)
    nothingNewSince: playbook === null ? null : (row?.nothingNewSince ?? null), // Fork-only (jehhynes/t3code#100)
  };
}

/**
 * When a new entry of the issue begins to wait: the read's time, or just after the previous
 * entry's when the clock reads no later, so each entry of an issue has its own time
 * (jehhynes/t3code#93: an answer for an earlier entry must not match a later one).
 */
function nextWaitingSince(row: PlaybookEntryRow, now: string): string {
  if (row.waitingSince === null || row.waitingSince < now) return now;
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(row.waitingSince), { milliseconds: 1 }),
  );
}

/** The lowercased names of the playbooks that start by themselves. */
export const selfStartingPlaybooks = (
  playbooks: ReadonlyArray<{ readonly name: string; readonly autoStart?: boolean }>,
): ReadonlySet<string> =>
  new Set(
    playbooks
      .filter((playbook) => playbook.autoStart === true)
      .map((playbook) => playbook.name.toLowerCase()),
  );

/** A board's read confirms each of these before it leaves one out (jehhynes/t3code#15). */
export function recordedByBoard(
  rows: ReadonlyMap<string, PlaybookEntryRow>,
): ReadonlyMap<string, ReadonlyArray<{ readonly scope: string; readonly key: string }>> {
  const byBoard = new Map<string, Array<{ readonly scope: string; readonly key: string }>>();
  for (const row of rows.values()) {
    if (row.playbook === null) continue;
    const [tracker, host, scope, key, ...rest] = row.issueKey.split(" ");
    if (tracker !== "github" || host !== "github.com" || !scope || !key || rest.length > 0)
      continue;
    const issues = byBoard.get(row.board) ?? [];
    issues.push({ scope, key });
    byBoard.set(row.board, issues);
  }
  return byBoard;
}

/**
 * The issue's entry as `result` lists it waiting with `playbook`, on a board that is on and was
 * read, or undefined; always undefined while any playbook cannot select.
 */
export function entryWaitingIn(
  result: IssueBoardResult | null,
  issueKey: string,
  playbook: string,
): IssueBoardEntry | undefined {
  if (result === null || result.playbookErrors.length > 0) return undefined;
  return waitingIn(result, issueKey, playbook)?.entry;
}

function waitingIn(result: IssueBoardResult | null, issueKey: string, playbook: string) {
  if (result === null) return undefined;
  for (const board of result.boards) {
    if (!board.enabled || board.error !== null) continue;
    const entry = board.entries.find(
      (candidate) =>
        issueThreadKey(candidate) === issueKey &&
        samePlaybook(candidate.waitingPlaybook ?? null, playbook),
    );
    if (entry !== undefined) return { board, entry };
  }
  return undefined;
}

/**
 * The open blockers that hold the issue's start, as `result` lists it waiting with `playbook` on a
 * board that waits for blockers; empty when nothing holds it (jehhynes/t3code#65). A mistake in
 * `playbooks.json` keeps the records and the read's blockers, so it holds them too.
 */
export function heldIn(
  result: IssueBoardResult | null,
  issueKey: string,
  playbook: string,
): IssueBoardEntry["blockers"] {
  const waiting = waitingIn(result, issueKey, playbook);
  return waiting !== undefined && heldByBlockers(waiting.board, waiting.entry)
    ? waiting.entry.blockers
    : [];
}

/**
 * The rows to write so each issue's record follows the boards as read; a row left out is
 * unchanged. Only a board that is on and was read decides, and a row whose own board did not
 * decide is left as it is, so an issue on a board that is off or failed keeps its record. Call it
 * only when every playbook could select.
 */
export function reconcilePlaybookEntries(input: {
  readonly rows: ReadonlyMap<string, PlaybookEntryRow>;
  readonly boards: ReadonlyArray<IssueBoard>;
  /** The read's time, as an ISO string, recorded on each issue that leaves and each new entry. */
  readonly now: string;
}): ReadonlyArray<PlaybookEntryRow> {
  const deciding = new Set(
    input.boards
      .filter((board) => board.enabled && board.error === null)
      .map((board) => boardSourceKey(board)),
  );
  // An issue on two boards follows the first that selects it, else the first that lists it, as
  // the Waiting to start list shows it.
  const listed = new Map<string, { readonly board: string; readonly entry: IssueBoardEntry }>();
  for (const board of input.boards) {
    const boardKey = boardSourceKey(board);
    if (!deciding.has(boardKey)) continue;
    for (const entry of board.entries) {
      const issueKey = issueThreadKey(entry);
      const first = listed.get(issueKey);
      if (first === undefined || (first.entry.playbook === null && entry.playbook !== null)) {
        listed.set(issueKey, { board: boardKey, entry });
      }
    }
  }

  const writes: PlaybookEntryRow[] = [];
  for (const [issueKey, { board, entry }] of listed) {
    const row = input.rows.get(issueKey);
    if (row === undefined) {
      writes.push({
        issueKey,
        board,
        playbook: entry.playbook,
        // An issue already worked on when first seen does not wait.
        startedBy: entry.playbook !== null && entry.hasOpenThread ? OPEN_THREAD : null,
        autoTried: false,
        startFailure: null,
        leftAt: null,
        startQueued: false,
        waitingSince: input.now,
        snoozedUntil: null,
        triage: null,
        nothingNewSince: null,
      });
    } else if (!deciding.has(row.board)) {
      continue;
      // A classified entry stays the triage playbook's entry (jehhynes/t3code#93).
    } else if (!samePlaybook(row.triage ?? row.playbook, entry.playbook)) {
      writes.push({
        issueKey,
        board,
        playbook: entry.playbook,
        startedBy: null,
        autoTried: false,
        startFailure: null,
        leftAt: entry.playbook === null ? input.now : row.leftAt,
        startQueued: false,
        waitingSince: nextWaitingSince(row, input.now),
        snoozedUntil: null,
        triage: null,
        nothingNewSince: null,
      });
    } else if (row.board !== board) {
      writes.push({ ...row, board });
    }
  }
  for (const row of input.rows.values()) {
    if (row.playbook !== null && deciding.has(row.board) && !listed.has(row.issueKey)) {
      writes.push({
        ...row,
        playbook: null,
        startedBy: null,
        autoTried: false,
        startFailure: null,
        leftAt: input.now,
        startQueued: false,
        waitingSince: nextWaitingSince(row, input.now),
        snoozedUntil: null,
        triage: null,
        nothingNewSince: null,
      });
    }
  }
  return writes;
}
