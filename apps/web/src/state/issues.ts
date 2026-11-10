import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";
import type {
  EnvironmentId,
  IssueBoardResult,
  IssueListInput,
  IssueListResult,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { formatEnvironmentQueryError } from "./query";

export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);

export interface IssueListTarget {
  readonly environmentId: EnvironmentId;
  readonly input: IssueListInput;
}

export interface MergedIssueListView {
  /** One answer per environment that has one, in target order. */
  readonly answers: ReadonlyArray<readonly [EnvironmentId, IssueListResult]>;
  /** The first environment that failed outright; the others may still have answered. */
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

/**
 * The same listing read across every connected environment at once, as the pull-request page
 * does: React cannot subscribe to a list of atoms whose length changes, so the fan-out lives in
 * one derived atom keyed by the targets. An environment that fails contributes nothing rather
 * than blanking the page.
 */
const mergedIssueListFamily = Atom.family((key: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(key) as ReadonlyArray<IssueListTarget>;
    const answers: Array<readonly [EnvironmentId, IssueListResult]> = [];
    let error: string | null = null;
    let isPending = false;
    for (const target of targets) {
      const result = get(issueEnvironment.list(target));
      isPending ||= result.waiting;
      if (result._tag === "Failure" && error === null) {
        error = formatEnvironmentQueryError(result.cause);
      }
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) answers.push([target.environmentId, value]);
    }
    return { answers, error, isPending };
  }).pipe(Atom.withLabel(`web-issues:list:${key}`)),
);

const EMPTY_ISSUE_LIST = Atom.make({
  answers: [] as ReadonlyArray<readonly [EnvironmentId, IssueListResult]>,
  error: null as string | null,
  isPending: false,
}).pipe(Atom.withLabel("web-issues:list:empty"));

export function useIssueList(targets: ReadonlyArray<IssueListTarget>): MergedIssueListView {
  const key = JSON.stringify(targets);
  const view = useAtomValue(targets.length === 0 ? EMPTY_ISSUE_LIST : mergedIssueListFamily(key));
  const refresh = () => {
    for (const target of JSON.parse(key) as ReadonlyArray<IssueListTarget>) {
      appAtomRegistry.refresh(issueEnvironment.list(target));
    }
  };
  return { ...view, refresh };
}

// Board reads this page asked for that have not answered yet; their results arrive by `board`.
const boardReadsInFlight = Atom.make(0).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-issues:boards:reads-in-flight"),
);

/**
 * Each environment's GitHub boards as its server last read them, across every connected
 * environment as the listing is. An environment whose stream fails shows no boards; a board that
 * cannot be read says why itself.
 */
const mergedIssueBoardsFamily = Atom.family((key: string) =>
  Atom.make((get) => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    const answers: Array<readonly [EnvironmentId, IssueBoardResult]> = [];
    let isPending = get(boardReadsInFlight) > 0;
    for (const environmentId of environmentIds) {
      const result = get(issueEnvironment.board({ environmentId, input: {} }));
      const value = Option.getOrNull(AsyncResult.value(result));
      isPending ||= value === null && result._tag !== "Failure";
      if (value !== null) answers.push([environmentId, value]);
    }
    return { answers, isPending };
  }).pipe(Atom.withLabel(`web-issues:boards:${key}`)),
);

const EMPTY_ISSUE_BOARDS = Atom.make({
  answers: [] as ReadonlyArray<readonly [EnvironmentId, IssueBoardResult]>,
  isPending: false,
}).pipe(Atom.withLabel("web-issues:boards:empty"));

export function useIssueBoards(environmentIds: ReadonlyArray<EnvironmentId>) {
  const key = JSON.stringify(environmentIds);
  const view = useAtomValue(
    environmentIds.length === 0 ? EMPTY_ISSUE_BOARDS : mergedIssueBoardsFamily(key),
  );
  const refresh = () => {
    for (const environmentId of JSON.parse(key) as ReadonlyArray<EnvironmentId>) {
      appAtomRegistry.update(boardReadsInFlight, (count) => count + 1);
      // A failed read keeps the last result, as a failed refresh of the listing does.
      void runAtomCommand(
        appAtomRegistry,
        issueEnvironment.readBoard,
        { environmentId, input: {} },
        { label: "issue board read", reportFailure: false, reportDefect: true },
      ).finally(() => appAtomRegistry.update(boardReadsInFlight, (count) => count - 1));
    }
  };
  return { ...view, refresh };
}
