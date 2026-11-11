import { describe, expect, it } from "@effect/vitest";

import { choices } from "./cases.ts";
import { passes } from "./grade.ts";

describe("passes", () => {
  it.each([
    ["fix", "fix", true],
    [" Fix\n", "fix", true],
    ["answer", "fix", false],
    ["deploy", "fix", false],
  ])("grades %j against %j as %j", (answer, expected, pass) => {
    expect(passes(answer, expected, choices)).toBe(pass);
  });
});
