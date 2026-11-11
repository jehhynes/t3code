// Fork-only (jehhynes/t3code#85): what the GitHub boards section of Settings refuses and saves.
import type { GitHubBoardConfig } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

export const MIN_BOARD_READ_INTERVAL_SECONDS = 10;

export interface GitHubBoardDraft {
  readonly owner: string;
  readonly number: string;
  readonly statusField: string;
  readonly waitForBlockers: boolean;
}

export interface GitHubBoardProblems {
  readonly owner?: string;
  readonly number?: string;
  readonly statusField?: string;
}

/** The server's key for a board's switch: GitHub logins compare case-insensitively. */
export function boardKey(board: { readonly owner: string; readonly number: number }): string {
  return `${board.owner.trim().toLowerCase()}/${board.number}`;
}

export function boardDraft(board: GitHubBoardConfig | null): GitHubBoardDraft {
  return board === null
    ? { owner: "", number: "", statusField: "Status", waitForBlockers: false }
    : {
        owner: board.owner,
        number: String(board.number),
        statusField: board.statusField,
        waitForBlockers: board.waitForBlockers === true,
      };
}

/** Each field the settings file would refuse, or that names a board already listed, with why. */
export function boardProblems(
  draft: GitHubBoardDraft,
  boards: ReadonlyArray<GitHubBoardConfig>,
  editingIndex: number | null,
): GitHubBoardProblems {
  const owner = draft.owner.trim();
  const number = /^\d+$/.test(draft.number.trim()) ? Number(draft.number.trim()) : Number.NaN;
  const named =
    owner !== "" &&
    Number.isSafeInteger(number) &&
    boards.some(
      (board, index) => index !== editingIndex && boardKey(board) === boardKey({ owner, number }),
    );
  return {
    ...(owner === "" ? { owner: "Enter the user or organization that owns the board." } : {}),
    ...(!Number.isSafeInteger(number) || number < 1
      ? { number: "Enter the number in the board's URL, a whole number above 0." }
      : named
        ? { number: `${owner}/${number} is already in the list.` }
        : {}),
    ...(draft.statusField.trim() === ""
      ? { statusField: "Enter the board's single-select field that holds each issue's status." }
      : {}),
  };
}

/** The board a valid draft saves, keeping the fields the form does not show of the one it edits. */
export function boardFromDraft(
  draft: GitHubBoardDraft,
  editing: GitHubBoardConfig | null,
): GitHubBoardConfig {
  const { waitForBlockers: _, ...kept } = editing ?? {};
  return {
    ...kept,
    owner: draft.owner.trim(),
    number: Number(draft.number.trim()),
    statusField: draft.statusField.trim(),
    ...(draft.waitForBlockers ? { waitForBlockers: true } : {}),
  };
}

/** Why an interval cannot be saved, or null; the server reads anything under 10 s as 10 s. */
export function intervalProblem(seconds: number | null): string | null {
  return seconds === null || !Number.isFinite(seconds) || seconds < MIN_BOARD_READ_INTERVAL_SECONDS
    ? `At least ${MIN_BOARD_READ_INTERVAL_SECONDS} seconds.`
    : null;
}

/**
 * Where the board an edit began on is in the list now: at its place, else the one board equal to
 * it; -1 once it has left or changed, or when two boards equal it, since then neither is known.
 */
export function boardIndex(
  boards: ReadonlyArray<GitHubBoardConfig>,
  target: { readonly index: number; readonly board: GitHubBoardConfig },
): number {
  const at = boards[target.index];
  if (at !== undefined && Equal.equals(at, target.board)) return target.index;
  const matches = boards.flatMap((board, index) =>
    Equal.equals(board, target.board) ? [index] : [],
  );
  return matches.length === 1 ? matches[0]! : -1;
}
