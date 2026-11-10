// Fork-only: which board issues wait for Start (jehhynes/t3code#6).
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
 * Each issue a playbook selected with no open thread, newest updated first. An issue on two boards
 * is listed once, as the first board in settings order lists it.
 */
export function waitingIssues(
  answers: ReadonlyArray<readonly [EnvironmentId, IssueBoardResult]>,
): ReadonlyArray<WaitingIssue> {
  const waiting = new Map<string, WaitingIssue>();
  for (const [environmentId, answer] of answers) {
    for (const board of answer.boards) {
      for (const entry of board.entries) {
        const { playbook } = entry;
        if (playbook === null || entry.hasOpenThread) continue;
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
