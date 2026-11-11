// Fork-only: an issue's worktree branch and folder from the project's templates (jehhynes/t3code#44).
import type { IssueBoardEntry } from "@t3tools/contracts";

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const NUMBER = /^[0-9]{1,10}$/;
const TYPE = /^[a-z][a-z0-9-]*$/;
const SLUG_LENGTH = 40;
const DEFAULT_TYPES: Readonly<Record<string, string>> = { bug: "fix" };
const DEFAULT_TYPE = "feat";

/** Whether the text names any `{{…}}` field. */
export function hasWorktreeField(text: string): boolean {
  return /\{\{[^{}]*\}\}/.test(text);
}

type NamedIssue = Pick<IssueBoardEntry, "key" | "title" | "labels">;

/** Only `a-z`, `0-9` and single inner hyphens, so other people's titles cannot form a path or a bad ref. */
export function issueSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_LENGTH)
    .replace(/-+$/, "");
  return slug === "" ? "issue" : slug;
}

/** The first label the project's map names, else `feat`; no map means `bug` gives `fix`. */
export function issueType(
  issue: NamedIssue,
  types: Readonly<Record<string, string>> | undefined,
): string {
  const map = types ?? DEFAULT_TYPES;
  const byLabel = new Map(Object.entries(map).map(([label, type]) => [label.toLowerCase(), type]));
  for (const label of issue.labels) {
    const type = byLabel.get(label.name.toLowerCase());
    if (type !== undefined) return type;
  }
  return DEFAULT_TYPE;
}

export type RenderResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

/** Fills `{{issue.number}}`, `{{issue.slug}}` and `{{issue.type}}`; any other field is a mistake. */
export function renderWorktreeName(
  template: string,
  issue: NamedIssue,
  types: Readonly<Record<string, string>> | undefined,
): RenderResult {
  const values: Record<string, () => RenderResult> = {
    "issue.number": () =>
      NUMBER.test(issue.key)
        ? { ok: true, value: issue.key }
        : { ok: false, error: `The issue's number "${issue.key}" is not 1 to 10 digits.` },
    "issue.slug": () => ({ ok: true, value: issueSlug(issue.title) }),
    "issue.type": () => {
      const type = issueType(issue, types);
      return TYPE.test(type)
        ? { ok: true, value: type }
        : { ok: false, error: `The type "${type}" may hold only a-z, 0-9 and "-".` };
    },
  };
  let error: string | null = null;
  const value = template.replace(PLACEHOLDER, (_match, expression: string) => {
    const name = expression.trim();
    const field = Object.hasOwn(values, name) ? values[name] : undefined;
    if (field === undefined) {
      error ??= `{{${name}}} is not an issue field; use {{issue.number}}, {{issue.slug}} or {{issue.type}}.`;
      return "";
    }
    const result = field();
    if (!result.ok) {
      error ??= result.error;
      return "";
    }
    return result.value;
  });
  return error === null ? { ok: true, value } : { ok: false, error };
}
