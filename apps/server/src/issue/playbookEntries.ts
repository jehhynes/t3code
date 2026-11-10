// Fork-only: an issue waits for Start once each time it enters a selection (jehhynes/t3code#7).
import type { IssueBoard, IssueBoardEntry } from "@t3tools/contracts";

import { boardSourceKey } from "../persistence/IssueBoardSources.ts";
import { OPEN_THREAD, type PlaybookEntryRow } from "../persistence/IssuePlaybookEntries.ts";
import { issueThreadKey } from "../persistence/IssueThreadLinks.ts";

const samePlaybook = (a: string | null, b: string | null) =>
  (a?.toLowerCase() ?? null) === (b?.toLowerCase() ?? null);

/** The playbook an issue waits for Start with: its entry's, until that entry is started. */
export const waitingPlaybook = (row: PlaybookEntryRow | undefined): string | null =>
  row !== undefined && row.startedBy === null ? row.playbook : null;

/**
 * The rows to write so each issue's record follows the boards as read; a row left out is
 * unchanged. Only a board that is on and was read decides, and a row whose own board did not
 * decide is left as it is, so an issue on a board that is off or failed keeps its record. Call it
 * only when every playbook could select.
 */
export function reconcilePlaybookEntries(input: {
  readonly rows: ReadonlyMap<string, PlaybookEntryRow>;
  readonly boards: ReadonlyArray<IssueBoard>;
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
      });
    } else if (!deciding.has(row.board)) {
      continue;
    } else if (!samePlaybook(row.playbook, entry.playbook)) {
      writes.push({ issueKey, board, playbook: entry.playbook, startedBy: null });
    } else if (row.board !== board) {
      writes.push({ ...row, board });
    }
  }
  for (const row of input.rows.values()) {
    if (row.playbook !== null && deciding.has(row.board) && !listed.has(row.issueKey)) {
      writes.push({ ...row, playbook: null, startedBy: null });
    }
  }
  return writes;
}
