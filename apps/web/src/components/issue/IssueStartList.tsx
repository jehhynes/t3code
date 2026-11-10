// Fork-only: board issues waiting for their playbook's Start (jehhynes/t3code#6).
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, IssueBoardResult } from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { issueEnvironment } from "~/state/issues";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { PULL_REQUEST_ROW_CLASS } from "../pullRequest/PullRequestListRow";
import { BoardRowLines } from "./IssueBoardSection";
import { type WaitingIssue, waitingIssueKey, waitingIssues } from "./issueStartList.logic";

const ROW_CLASS = cn(PULL_REQUEST_ROW_CLASS, "@container/issue-row-meta px-3 py-2.5");

function WaitingRow({
  issue,
  environmentLabel,
  starting,
  onStart,
}: {
  issue: WaitingIssue;
  environmentLabel: string | undefined;
  starting: boolean;
  onStart: () => void;
}) {
  const canStart = useAtomValue(issueEnvironment.startPlaybook.permissionAtom(issue.environmentId));
  const { entry } = issue;
  return (
    <div className={ROW_CLASS}>
      <BoardRowLines entry={entry} />
      {entry.projectId === null ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          No T3 Code project for {entry.scope}
        </span>
      ) : (
        <Button
          variant="outline"
          size="xs"
          disabled={starting || !canStart}
          title={canStart ? `Start playbook ${entry.playbook}` : "You cannot start threads here."}
          onClick={onStart}
        >
          <PlayIcon aria-hidden />
          Start
        </Button>
      )}
      {environmentLabel ? (
        <span className="shrink-0 text-xs text-muted-foreground">{environmentLabel}</span>
      ) : null}
    </div>
  );
}

export function IssueStartList({
  answers,
  query,
  environmentLabels,
}: {
  /** The latest board answers; a new array arrives with each answer the server publishes. */
  answers: ReadonlyArray<readonly [EnvironmentId, IssueBoardResult]>;
  /** Narrows rows by title or key, as the boards are narrowed. */
  query: string;
  /** Each environment's label, where the page spans more than one. */
  environmentLabels: ReadonlyMap<EnvironmentId, string> | null;
}) {
  const startPlaybook = useAtomCommand(issueEnvironment.startPlaybook, {
    label: "issue playbook start",
  });
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  // The server publishes the boards again after a Start; a started issue stays hidden while its
  // environment still shows the answer it was started from.
  const [started, setStarted] = useState<
    ReadonlyMap<string, { environmentId: EnvironmentId; answer: IssueBoardResult }>
  >(new Map());
  const answerOf = (environmentId: EnvironmentId) =>
    answers.find(([candidate]) => candidate === environmentId)?.[1];
  const stillHidden = [...started].filter(
    ([, { environmentId, answer }]) => answerOf(environmentId) === answer,
  );
  if (stillHidden.length !== started.size) setStarted(new Map(stillHidden));

  const needle = query.toLowerCase();
  const issues = waitingIssues(answers).filter(
    (issue) =>
      !started.has(waitingIssueKey(issue)) &&
      (needle.length === 0 ||
        issue.entry.title.toLowerCase().includes(needle) ||
        issue.entry.displayKey.toLowerCase().includes(needle)),
  );
  if (issues.length === 0) return null;

  const start = async (issue: WaitingIssue) => {
    const key = waitingIssueKey(issue);
    setStarting((current) => new Set([...current, key]));
    const result = await startPlaybook({
      environmentId: issue.environmentId,
      input: { playbook: issue.entry.playbook, entry: issue.entry },
    });
    setStarting((current) => new Set([...current].filter((candidate) => candidate !== key)));
    if (result._tag === "Success") {
      const answer = answerOf(issue.environmentId);
      if (answer !== undefined) {
        const environmentId = issue.environmentId;
        setStarted((current) => new Map(current).set(key, { environmentId, answer }));
      }
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not start ${issue.entry.displayKey} with playbook ${issue.entry.playbook}`,
        description:
          typeof failure === "object" && failure !== null && "detail" in failure
            ? String(failure.detail)
            : String(failure),
      });
    }
  };

  return (
    <section className="flex flex-col gap-1" aria-label="Waiting to start">
      <h2 className="flex items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground">
        <PlayIcon aria-hidden className="size-3.5" />
        Waiting to start
      </h2>
      <div className="flex flex-col">
        {issues.map((issue) => {
          const key = waitingIssueKey(issue);
          return (
            <WaitingRow
              key={key}
              issue={issue}
              environmentLabel={environmentLabels?.get(issue.environmentId)}
              starting={starting.has(key)}
              onStart={() => void start(issue)}
            />
          );
        })}
      </div>
    </section>
  );
}
