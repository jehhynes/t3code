// Fork-only (jehhynes/t3code#75): the stage an agent reports for its thread's running turn.
import * as Schema from "effect/Schema";

import { RunId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const THREAD_STAGE_MAX_LENGTH = 64;

export const ThreadStageText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_STAGE_MAX_LENGTH),
  Schema.makeFilter((value) =>
    /[\p{Cc}\u2028\u2029]/u.test(value) ? "A stage must be a single line of text." : true,
  ),
).annotate({
  description: `What this turn is doing now, in a few words (at most ${THREAD_STAGE_MAX_LENGTH} characters, one line). Required only when action is set_stage.`,
});

/** Shown only while its run is active. Lenient text so a later rule never fails a stored thread. */
export const ReportedThreadStage = Schema.Struct({ runId: RunId, text: Schema.String });

export const stageFitsAction = (input: {
  readonly action: string;
  readonly stage?: string | undefined;
}): true | string =>
  (input.action === "set_stage") === (input.stage !== undefined)
    ? true
    : "set_stage requires stage; other actions do not accept one.";
