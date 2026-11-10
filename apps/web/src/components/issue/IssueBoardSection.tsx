// Fork-only: a GitHub board's open issues on the Issues page (jehhynes/t3code#2).
import type { EnvironmentId, IssueBoard, IssueBoardEntry, ProjectId } from "@t3tools/contracts";
import { ArrowUpRightIcon, KanbanIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import {
  PullRequestActorAvatar,
  PullRequestLabelChip,
} from "../pullRequest/pullRequestPresentation";
import type { IssueRowTarget } from "./IssueRow";
import { IssueStateGlyph } from "./issuePresentation";

interface BoardGroup {
  readonly key: string;
  readonly heading: string;
  readonly entries: ReadonlyArray<IssueBoardEntry>;
}

/** Issues under their project, then each repository without one; newest updated first within. */
function groupBoard(entries: ReadonlyArray<IssueBoardEntry>): ReadonlyArray<BoardGroup> {
  const groups = new Map<
    string,
    { heading: string; projected: boolean; entries: IssueBoardEntry[] }
  >();
  for (const entry of entries) {
    const key =
      entry.projectId === null ? `repo:${entry.scope.toLowerCase()}` : `project:${entry.projectId}`;
    const group = groups.get(key) ?? {
      heading:
        entry.projectId === null
          ? `No T3 Code project for ${entry.scope}`
          : (entry.projectTitle ?? entry.scope),
      projected: entry.projectId !== null,
      entries: [],
    };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .toSorted(
      ([, a], [, b]) =>
        Number(b.projected) - Number(a.projected) || a.heading.localeCompare(b.heading),
    )
    .map(([key, group]) => ({
      key,
      heading: group.heading,
      entries: group.entries.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    }));
}

function BoardRowLines({ entry }: { entry: IssueBoardEntry }) {
  return (
    <>
      <IssueStateGlyph state={entry.state} />
      <PullRequestRowLines
        number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>{entry.displayKey}</span>}
        title={entry.title}
        status={
          <>
            {entry.assignees.length > 0 ? (
              <span className="flex items-center -space-x-1">
                {entry.assignees.slice(0, 3).map((assignee) => (
                  <PullRequestActorAvatar
                    key={assignee.login}
                    actor={assignee}
                    className="ring-1 ring-background"
                  />
                ))}
              </span>
            ) : null}
            <Badge variant="outline" size="sm">
              {entry.status ?? "No status"}
            </Badge>
          </>
        }
        meta={
          <>
            <span className="truncate">{entry.scope}</span>
            {entry.blockers.length > 0 ? (
              <span className="truncate text-warning-foreground">
                Blocked by {entry.blockers.map((blocker) => blocker.displayKey).join(", ")}
              </span>
            ) : null}
            {entry.labels.length > 0 ? (
              <span className="hidden min-w-0 items-center gap-1 @xl/issue-row-meta:flex">
                {entry.labels.slice(0, 3).map((label, index) => (
                  <PullRequestLabelChip key={label.name} label={label}>
                    {index === 2 && entry.labels.length > 3 ? (
                      <span className="shrink-0">+{entry.labels.length - 3}</span>
                    ) : null}
                  </PullRequestLabelChip>
                ))}
              </span>
            ) : null}
          </>
        }
        updatedAt={entry.updatedAt}
      />
    </>
  );
}

const ROW_CLASS = cn(PULL_REQUEST_ROW_CLASS, "@container/issue-row-meta px-3 py-2.5");

function IssueBoardSectionImpl({
  environmentId,
  board,
  query,
  environmentLabel,
  selectedKey,
  onSelect,
}: {
  environmentId: EnvironmentId;
  board: IssueBoard;
  /** Narrows rows by title or key; the board read itself has no filters. */
  query: string;
  /** Names the server this board was read from, where the page spans more than one. */
  environmentLabel?: string | undefined;
  /** The open issue's `projectId host scope key`, to mark its row. */
  selectedKey: string | null;
  onSelect: (entry: IssueRowTarget) => void;
}) {
  const needle = query.toLowerCase();
  const entries =
    needle.length === 0
      ? board.entries
      : board.entries.filter(
          (entry) =>
            entry.title.toLowerCase().includes(needle) ||
            entry.displayKey.toLowerCase().includes(needle),
        );
  const groups = groupBoard(entries);
  return (
    <section className="flex flex-col gap-1" aria-label={`Board ${board.owner}/${board.number}`}>
      <h2 className="flex items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground">
        <KanbanIcon aria-hidden className="size-3.5" />
        GitHub board {board.owner}/{board.number}
        {environmentLabel ? <span className="font-normal">· {environmentLabel}</span> : null}
      </h2>
      {board.error !== null ? (
        <p className="px-3 text-sm text-destructive">{board.error}</p>
      ) : groups.length === 0 ? (
        <p className="px-3 text-sm text-muted-foreground">
          {needle ? "Nothing matches that." : "No open issues on this board."}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="flex flex-col">
            <h3 className="px-3 pt-1 text-xs text-muted-foreground">{group.heading}</h3>
            {group.entries.map((entry) => {
              const projectId = entry.projectId;
              if (projectId === null) {
                return (
                  <a
                    key={`${entry.scope}#${entry.key}`}
                    href={entry.url}
                    target="_blank"
                    rel="noreferrer"
                    className={cn(ROW_CLASS, "hover:bg-accent/60")}
                  >
                    <BoardRowLines entry={entry} />
                    <ArrowUpRightIcon
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  </a>
                );
              }
              const selected =
                selectedKey ===
                boardEntryKey({ projectId, host: entry.host, scope: entry.scope, key: entry.key });
              return (
                <button
                  key={`${entry.scope}#${entry.key}`}
                  type="button"
                  aria-current={selected ? "true" : undefined}
                  onClick={() => onSelect({ ...entry, projectId, environmentId })}
                  className={cn(ROW_CLASS, selected ? "bg-accent" : "hover:bg-accent/60")}
                >
                  <BoardRowLines entry={entry} />
                </button>
              );
            })}
          </div>
        ))
      )}
    </section>
  );
}

export function boardEntryKey(entry: {
  readonly projectId: ProjectId | string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
}): string {
  return `${entry.projectId} ${entry.host.toLowerCase()} ${entry.scope.toLowerCase()} ${entry.key}`;
}

export const IssueBoardSection = memo(IssueBoardSectionImpl);
