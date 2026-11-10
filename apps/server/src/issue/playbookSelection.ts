// Fork-only: rules pick each board issue's playbook (jehhynes/t3code#5).
import { IssuePlaybook, type IssueBoardEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

export const PLAYBOOKS_FILE = "playbooks.json";

const decodePlaybook = Schema.decodeUnknownExit(IssuePlaybook, { onExcessProperty: "error" });

/** `Expected …\n  at ["rules"]["stat"]` → `Expected … at rules.stat`. */
function schemaMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\n\s*at /g, " at ")
    .replace(/\["([^"]*)"\]/g, ".$1")
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/ at \./g, " at ");
}

export interface ParsedPlaybooks {
  readonly playbooks: ReadonlyArray<IssuePlaybook>;
  readonly errors: ReadonlyArray<string>;
}

/** Each valid entry in file order; an invalid or repeated one is left out with its error. */
export function parsePlaybooks(text: string): ParsedPlaybooks {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return {
      playbooks: [],
      errors: [`${PLAYBOOKS_FILE} is not valid JSON: ${(cause as Error).message}`],
    };
  }
  if (!Array.isArray(json)) {
    return { playbooks: [], errors: [`${PLAYBOOKS_FILE} must hold a list of playbooks.`] };
  }
  const playbooks: IssuePlaybook[] = [];
  const errors: string[] = [];
  const names = new Set<string>();
  for (const [index, entry] of json.entries()) {
    const decoded = decodePlaybook(entry);
    const label = `Playbook ${index + 1}`;
    if (Exit.isFailure(decoded)) {
      const name =
        typeof entry === "object" && entry !== null && typeof entry.name === "string"
          ? ` (${entry.name.trim()})`
          : "";
      errors.push(`${label}${name}: ${schemaMessage(decoded.cause)}`);
      continue;
    }
    const playbook = decoded.value;
    const key = playbook.name.toLowerCase();
    if (names.has(key)) {
      errors.push(`${label} (${playbook.name}): an earlier playbook has this name.`);
      continue;
    }
    names.add(key);
    playbooks.push(playbook);
  }
  return { playbooks, errors };
}

export function needsViewer(playbooks: ReadonlyArray<IssuePlaybook>): boolean {
  return playbooks.some((playbook) => playbook.rules.assignee !== undefined);
}

function includesFolded(list: ReadonlyArray<string>, value: string): boolean {
  const folded = value.toLowerCase();
  return list.some((candidate) => candidate.toLowerCase() === folded);
}

function matches(
  rules: IssuePlaybook["rules"],
  entry: IssueBoardEntry,
  viewer: string | null,
): boolean {
  const { status, repository, labels } = rules;
  if (status !== undefined && (entry.status === null || !includesFolded(status, entry.status))) {
    return false;
  }
  if (repository !== undefined && !includesFolded(repository, entry.scope)) return false;
  if (labels !== undefined && !entry.labels.some((label) => includesFolded(labels, label.name))) {
    return false;
  }
  if (rules.blocked !== undefined && rules.blocked !== entry.blockers.length > 0) return false;
  if (rules.assignee !== undefined) {
    const me = viewer?.toLowerCase();
    const mine = entry.assignees.some((assignee) => assignee.login.toLowerCase() === me);
    const others = entry.assignees.some((assignee) => assignee.login.toLowerCase() !== me);
    switch (rules.assignee) {
      case "me":
        return mine;
      case "meAlone":
        return mine && !others;
      case "meAndOthers":
        return mine && others;
      case "othersOnly":
        return !mine && others;
      case "nobody":
        return entry.assignees.length === 0;
    }
  }
  return true;
}

/** The first playbook whose rules all match, or null. */
export function selectPlaybook(
  playbooks: ReadonlyArray<IssuePlaybook>,
  entry: IssueBoardEntry,
  viewer: string | null,
): string | null {
  return playbooks.find((playbook) => matches(playbook.rules, entry, viewer))?.name ?? null;
}
