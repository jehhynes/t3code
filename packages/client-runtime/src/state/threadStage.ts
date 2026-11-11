// Fork-only (jehhynes/t3code#73): the stage changes while a run streams, and only the row that
// reads the live shell shows it, so the quiet shell compares without it.
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

/** `shell` with `next`'s exact `stage` key; schema equivalence tells a missing key from undefined. */
export function withStageOf(
  shell: OrchestrationV2ThreadShell,
  next: Pick<OrchestrationV2ThreadShell, "stage">,
): OrchestrationV2ThreadShell {
  const { stage: _stage, ...rest } = shell;
  return Object.hasOwn(next, "stage") ? { ...rest, stage: next.stage } : rest;
}
