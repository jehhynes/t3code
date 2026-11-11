// Fork-only (jehhynes/t3code#85)
import { describe, expect, it } from "vite-plus/test";

import {
  boardDraft,
  boardIndex,
  boardProblems,
  intervalProblem,
} from "./githubBoardSettings.logic";

const acme = { owner: "acme", number: 1, statusField: "Status" };
const other = { owner: "jehhynes", number: 4, statusField: "Stage", waitForBlockers: true };

describe("boardProblems", () => {
  it("refuses an empty field, a number that is not above 0 and a board already listed", () => {
    const draft = boardDraft(null);
    expect(boardProblems({ ...draft, number: "4" }, [acme], null)).toEqual({
      owner: expect.any(String),
    });
    for (const number of ["", "0", "-1", "1.5", "4a"]) {
      expect(boardProblems({ ...draft, owner: "acme", number }, [], null), number).toEqual({
        number: "Enter the number in the board's URL, a whole number above 0.",
      });
    }
    expect(
      boardProblems({ ...draft, owner: "a", number: "2", statusField: " " }, [], null),
    ).toEqual({ statusField: expect.any(String) });
    expect(boardProblems({ ...draft, owner: " ACME ", number: "1" }, [acme, other], null)).toEqual({
      number: "ACME/1 is already in the list.",
    });
  });

  it("lets the board being edited keep its own name", () => {
    expect(boardProblems(boardDraft(other), [acme, other], 1)).toEqual({});
    expect(
      boardProblems({ ...boardDraft(other), owner: "Acme", number: "1" }, [acme, other], 1),
    ).toEqual({ number: "Acme/1 is already in the list." });
  });
});

describe("intervalProblem", () => {
  it("refuses an empty value and anything under 10 seconds", () => {
    for (const seconds of [null, 0, 9, 9.9]) {
      expect(intervalProblem(seconds), String(seconds)).toBe("At least 10 seconds.");
    }
    expect(intervalProblem(10)).toBeNull();
    expect(intervalProblem(300)).toBeNull();
  });
});

describe("boardIndex", () => {
  it("finds the board as it was, and refuses one that changed or that two entries equal", () => {
    const stage = { ...acme, statusField: "Stage" };
    expect(boardIndex([other, { ...acme }], { index: 1, board: acme })).toBe(1);
    expect(boardIndex([{ ...acme }, other], { index: 1, board: acme })).toBe(0);
    expect(boardIndex([other, stage], { index: 1, board: acme })).toBe(-1);
    // The second of two acme/1 entries was the target; the one left is the other.
    expect(boardIndex([acme], { index: 1, board: stage })).toBe(-1);
    expect(boardIndex([acme, other, acme], { index: 3, board: acme })).toBe(-1);
  });
});
