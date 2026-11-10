// Fork-only: which board issues wait for Start (jehhynes/t3code#6, #7).
import type { EnvironmentId, IssueBoardEntry, IssueBoardResult } from "@t3tools/contracts";

export interface WaitingIssue {
  readonly environmentId: EnvironmentId;
  readonly entry: IssueBoardEntry & { readonly playbook: string };
}

export function waitingIssueKey(issue: WaitingIssue): string {
  const { entry } = issue;
  return `${issue.environmentId} ${entry.tracker} ${entry.host.toLowerCase()} ${entry.scope.toLowerCase()} ${entry.key}`;
}

/**
 * Each issue waiting for Start, with the playbook it waits with, newest updated first. An issue on
 * two boards is listed once, as the first board in settings order lists it.
 */
export function waitingIssues(
  answers: ReadonlyArray<readonly [EnvironmentId, IssueBoardResult]>,
): ReadonlyArray<WaitingIssue> {
  const waiting = new Map<string, WaitingIssue>();
  for (const [environmentId, answer] of answers) {
    for (const board of answer.boards) {
      for (const entry of board.entries) {
        // A server older than #7 sends no waitingPlaybook and listed each selected issue that had
        // no open thread.
        const playbook =
          entry.waitingPlaybook === undefined
            ? entry.hasOpenThread
              ? null
              : entry.playbook
            : entry.waitingPlaybook;
        if (playbook === null) continue;
        const issue = { environmentId, entry: { ...entry, playbook } };
        const key = waitingIssueKey(issue);
        if (!waiting.has(key)) waiting.set(key, issue);
      }
    }
  }
  return [...waiting.values()].toSorted(
    (a, b) => Date.parse(b.entry.updatedAt) - Date.parse(a.entry.updatedAt),
  );
}
