// Fork-only: rules pick each board issue's playbook (jehhynes/t3code#5), and a triage playbook's
// classifier picks among its choices (#93).
import { IssuePlaybook, type IssueBoardEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { PLAYBOOK_PROMPT_FIELDS, promptFields, unknownPromptFields } from "./playbookPrompt.ts";

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
    const triageMistake = triageShapeMistake(playbook);
    if (triageMistake !== null) {
      errors.push(`${label} (${playbook.name}): ${triageMistake}`);
      continue;
    }
    const unknown = playbook.choices === undefined ? unknownPromptFields(playbook.prompt) : [];
    if (unknown.length > 0) {
      errors.push(
        `${label} (${playbook.name}): the prompt names ${unknown.map((field) => `{{${field}}}`).join(", ")}, which no issue has; use ${PLAYBOOK_PROMPT_FIELDS.map((field) => `{{${field}}}`).join(", ")}.`,
      );
      continue;
    }
    const key = playbook.name.toLowerCase();
    if (names.has(key)) {
      errors.push(`${label} (${playbook.name}): an earlier playbook has this name.`);
      continue;
    }
    names.add(key);
    playbooks.push(playbook);
  }
  // Fork-only (jehhynes/t3code#93): choices are checked against the entries that are valid.
  const valid = playbooks.filter((playbook) => {
    const mistake = choicesMistake(playbook, playbooks);
    if (mistake === null) return true;
    errors.push(`Playbook ${playbook.name}: ${mistake}`);
    return false;
  });
  return { playbooks: valid, errors };
}

const NOT_ON_TRIAGE = [
  "runtimeMode",
  "interactionMode",
  "autoStart",
  "requiresWorktree",
  "description",
] as const;

/** What a single entry gets wrong as a triage playbook or a playbook triage chooses, or null. */
function triageShapeMistake(playbook: IssuePlaybook): string | null {
  if (playbook.choices !== undefined) {
    const extra = NOT_ON_TRIAGE.filter((key) => playbook[key] !== undefined);
    if (extra.length > 0) {
      return `a triage playbook starts no thread, so it takes no ${extra.join(", ")}.`;
    }
    if (promptFields(playbook.prompt).some((field) => field !== "playbooks")) {
      return `a triage prompt takes only {{playbooks}}; the classifier is given the issue itself.`;
    }
    return null;
  }
  if (playbook.description !== undefined && Object.keys(playbook.rules).length > 0) {
    return "a playbook with a description is chosen only by triage, so it takes no rules.";
  }
  return null;
}

/** What a triage playbook's choices get wrong against the file's valid entries, or null. */
function choicesMistake(
  playbook: IssuePlaybook,
  playbooks: ReadonlyArray<IssuePlaybook>,
): string | null {
  if (playbook.choices === undefined) return null;
  for (const choice of playbook.choices) {
    const chosen = playbooks.find((candidate) => sameName(candidate.name, choice));
    if (chosen === undefined)
      return `the choice ${choice} is not a playbook in ${PLAYBOOKS_FILE}, or it has a mistake.`;
    if (chosen.choices !== undefined) return `the choice ${choice} is a triage playbook.`;
    if (chosen.description === undefined) return `the choice ${choice} has no description.`;
  }
  return null;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether the playbook is a triage playbook, whose classifier picks one of its choices. */
const isTriagePlaybook = (playbook: IssuePlaybook): boolean => playbook.choices !== undefined;

/** The triage playbook of this name, or undefined. */
export function triagePlaybookNamed(
  playbooks: ReadonlyArray<IssuePlaybook>,
  name: string | null,
): IssuePlaybook | undefined {
  if (name === null) return undefined;
  return playbooks.find((playbook) => isTriagePlaybook(playbook) && sameName(playbook.name, name));
}

/** Read whenever asked, so an edit applies at once; a missing file is no playbooks. */
export const readPlaybooksFile = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.map(parsePlaybooks),
    Effect.catch((error) =>
      Effect.succeed<ParsedPlaybooks>({
        playbooks: [],
        errors:
          error.reason._tag === "NotFound"
            ? []
            : [`${PLAYBOOKS_FILE} could not be read: ${error.message}`],
      }),
    ),
  );

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
  return (
    playbooks.find(
      // A playbook with a description is chosen only by triage (jehhynes/t3code#93).
      (playbook) => playbook.description === undefined && matches(playbook.rules, entry, viewer),
    )?.name ?? null
  );
}
