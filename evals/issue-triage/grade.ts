import { matchChoice } from "../../apps/server/src/issue/triagePrompt.ts";

/** A sample passes when the server would accept its answer as the expected choice. */
export const passes = (
  answer: string,
  expected: string,
  choices: ReadonlyArray<{ readonly name: string }>,
) =>
  matchChoice(
    answer,
    choices.map((choice) => choice.name),
  ) === expected;
