// Fork-only (jehhynes/t3code#106): project rows already visible in a board stay in that section.
import type { EnvironmentId, IssueBoardResult, IssueListEntry } from "@t3tools/contracts";

type ProjectRow = Pick<IssueListEntry, "tracker" | "host" | "scope" | "key"> & {
  readonly environmentId: EnvironmentId;
};

interface ProjectGroup {
  readonly tracker: { readonly configured: boolean };
  readonly rows: ReadonlyArray<ProjectRow>;
  readonly errors: ReadonlyArray<unknown>;
  readonly more: ReadonlyArray<unknown>;
}

export function withoutBoardIssues<Group extends ProjectGroup>(
  groups: ReadonlyArray<Group>,
  answers: ReadonlyArray<readonly [EnvironmentId, IssueBoardResult]>,
  query: string,
  boardsVisible: boolean,
): ReadonlyArray<Group> {
  if (!boardsVisible) return groups;
  const shown = new Set<string>();
  const needle = query.toLowerCase();
  for (const [environmentId, answer] of answers) {
    for (const board of answer.boards) {
      if (!board.enabled || board.error !== null) continue;
      for (const entry of board.entries) {
        if (
          needle.length > 0 &&
          !entry.title.toLowerCase().includes(needle) &&
          !entry.displayKey.toLowerCase().includes(needle)
        )
          continue;
        shown.add(identity({ ...entry, environmentId }));
      }
    }
  }
  if (shown.size === 0) return groups;
  return groups.flatMap((group) => {
    const rows = group.rows.filter((row) => !shown.has(identity(row)));
    if (rows.length === group.rows.length) return [group];
    if (
      rows.length === 0 &&
      group.tracker.configured &&
      group.errors.length === 0 &&
      group.more.length === 0
    )
      return [];
    return [{ ...group, rows }];
  });
}

function identity(row: ProjectRow): string {
  return `${row.environmentId} ${row.tracker} ${row.host.toLowerCase()} ${row.scope.toLowerCase()} ${row.key}`;
}
