// Fork-only: which board issues wait for Start (jehhynes/t3code#6, #7).
import {
  heldByBlockers,
  type EnvironmentId,
  type IssueBoard,
  type IssueBoardEntry,
  type IssueBoardResult,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";

export interface WaitingIssue {
  readonly environmentId: EnvironmentId;
  readonly entry: IssueBoardEntry & { readonly playbook: string };
  /**
   * The playbooks its environment's `playbooks.json` lists, in order; absent from a server older
   * than jehhynes/t3code#26.
   */
  readonly playbooks: ReadonlyArray<string> | undefined;
  /**
   * How an open blocker holds its start (jehhynes/t3code#65): it `starts` by itself once none is
   * left, or `waits` for Start, which queues it. With no blocker, `slot`: it starts by itself once
   * a slot is free, which it waits for while every slot is in use (jehhynes/t3code#76). Null when
   * nothing holds it.
   */
  readonly hold: "starts" | "waits" | "slot" | null;
  /**
   * Whether a triage playbook's classifier is still `choosing` its playbook, or `failed` to, with
   * the cause in `startFailure` (jehhynes/t3code#93); null once chosen or with no triage.
   */
  readonly triage: "choosing" | "failed" | null;
  /** The triage playbooks, which no issue starts with; absent from an older server. */
  readonly triagePlaybooks: ReadonlyArray<string> | undefined;
}

function holdOf(
  board: IssueBoard,
  entry: IssueBoardEntry,
  playbookErrors: ReadonlyArray<string>,
): WaitingIssue["hold"] {
  if (heldByBlockers(board, entry)) return entry.startsBySelf === true ? "starts" : "waits";
  if (entry.projectId === null) return null;
  // During a mistake nothing starts by itself, so an untried entry keeps its Start.
  if (entry.startQueued === true) return "slot";
  return entry.startsBySelf === true && playbookErrors.length === 0 ? "slot" : null;
}

function joinKeys(keys: ReadonlyArray<string>): string {
  return keys.length < 2 ? keys.join("") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
}

/** What a held row says it waits for, such as "Starts when #12 closes". */
export function holdText(
  hold: "starts" | "waits" | "slot",
  blockers: IssueBoardEntry["blockers"],
): string {
  if (hold === "slot") return "Starts when a thread finishes";
  const keys = joinKeys(blockers.map((blocker) => blocker.displayKey));
  if (hold === "waits") return `Waits for ${keys}`;
  return `Starts when ${keys} ${blockers.length === 1 ? "closes" : "close"}`;
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
        const triaging =
          entry.triagedBy == null &&
          (answer.triagePlaybooks ?? []).some(
            (name) => name.toLowerCase() === playbook.toLowerCase(),
          );
        const issue = {
          environmentId,
          entry: { ...entry, playbook },
          playbooks: answer.playbooks,
          hold: holdOf(board, entry, answer.playbookErrors),
          triage: triaging ? (entry.startFailure == null ? "choosing" : "failed") : null,
          triagePlaybooks: answer.triagePlaybooks,
        } satisfies WaitingIssue;
        const key = waitingIssueKey(issue);
        if (!waiting.has(key)) waiting.set(key, issue);
      }
    }
  }
  return [...waiting.values()].toSorted(
    (a, b) => Date.parse(b.entry.updatedAt) - Date.parse(a.entry.updatedAt),
  );
}

/**
 * Whether the issue is snoozed at `nowMs` (jehhynes/t3code#86); a wake that has passed no longer
 * holds it, as the server decides from its own record.
 */
export function isSnoozed(issue: WaitingIssue, nowMs: number): boolean {
  const { snoozedUntil } = issue.entry;
  return snoozedUntil != null && Date.parse(snoozedUntil) > nowMs;
}

/** The playbooks a draft can take instead, without the issue's own or a triage playbook. */
export function otherPlaybooks(issue: WaitingIssue): ReadonlyArray<string> {
  const skipped = new Set(
    [issue.entry.playbook, ...(issue.triagePlaybooks ?? [])].map((name) => name.toLowerCase()),
  );
  return (issue.playbooks ?? []).filter((name) => !skipped.has(name.toLowerCase()));
}

/** Every field is set, so a reused draft keeps none of its own folder. */
export function draftWorkspace(workspace: OrchestrationV2ThreadLaunchWorkspaceStrategy) {
  switch (workspace.type) {
    case "existing_worktree":
      return {
        envMode: "worktree" as const,
        worktreePath: workspace.worktreePath,
        branch: workspace.branch ?? null,
        startFromOrigin: false,
      };
    case "worktree":
      return {
        envMode: "worktree" as const,
        worktreePath: null,
        branch: workspace.baseRef,
        startFromOrigin: workspace.startFromOrigin === true,
      };
    case "root":
      return {
        envMode: "local" as const,
        worktreePath: null,
        branch: workspace.branch ?? null,
        startFromOrigin: false,
      };
  }
}
