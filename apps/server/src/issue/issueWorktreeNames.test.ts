import { describe, expect, it } from "@effect/vitest";

import { issueSlug, issueType, renderWorktreeName } from "./issueWorktreeNames.ts";

const issue = (key: string, title: string, labels: ReadonlyArray<string> = []) => ({
  key,
  title,
  labels: labels.map((name) => ({ name, color: null })),
});

describe("issueSlug", () => {
  it.each([
    { title: "Fix the login page", slug: "fix-the-login-page" },
    { title: "../../x", slug: "x" },
    { title: "a/b\\c..d:e?f*g<h>i|j\"k'l", slug: "a-b-c-d-e-f-g-h-i-j-k-l" },
    { title: "-rf --force", slug: "rf-force" },
    { title: "Ünïcödé café", slug: "unicode-cafe" },
    { title: "@{-1}.lock", slug: "1-lock" },
    { title: "日本語", slug: "issue" },
    { title: "   ", slug: "issue" },
    { title: `${"word ".repeat(20)}end`, slug: "word-word-word-word-word-word-word-word" },
  ])("$title gives $slug", ({ title, slug }) => {
    expect(issueSlug(title)).toBe(slug);
    expect(issueSlug(title)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(issueSlug(title).length).toBeLessThanOrEqual(40);
  });
});

describe("issueType", () => {
  it.each([
    { name: "a bug with no map", labels: ["bug"], types: undefined, type: "fix" },
    { name: "an enhancement with no map", labels: ["enhancement"], types: undefined, type: "feat" },
    { name: "no labels", labels: [], types: undefined, type: "feat" },
    {
      name: "the first label the map names",
      labels: ["Docs", "bug"],
      types: { bug: "fix", docs: "docs" },
      type: "docs",
    },
    {
      name: "a map without the issue's labels",
      labels: ["bug"],
      types: { chore: "chore" },
      type: "feat",
    },
  ])("$name gives $type", ({ labels, types, type }) => {
    expect(issueType(issue("6", "x", labels), types)).toBe(type);
  });
});

describe("renderWorktreeName", () => {
  it.each([
    {
      name: "Jessy's branch",
      template: "{{issue.type}}/{{issue.number}}-{{issue.slug}}",
      input: issue("123", "Fix the login page", ["bug"]),
      result: { ok: true, value: "fix/123-fix-the-login-page" },
    },
    {
      name: "an unknown field",
      template: "{{issue.title}}",
      input: issue("123", "x"),
      result: {
        ok: false,
        error:
          "{{issue.title}} is not an issue field; use {{issue.number}}, {{issue.slug}} or {{issue.type}}.",
      },
    },
    ...["__proto__", "constructor", "toString"].map((field) => ({
      name: `the inherited name {{${field}}}`,
      template: `{{${field}}}`,
      input: issue("123", "x"),
      result: {
        ok: false,
        error: `{{${field}}} is not an issue field; use {{issue.number}}, {{issue.slug}} or {{issue.type}}.`,
      },
    })),
    {
      name: "a number that is not digits",
      template: "{{issue.number}}",
      input: issue("1/../x", "x"),
      result: { ok: false, error: `The issue's number "1/../x" is not 1 to 10 digits.` },
    },
    {
      name: "a number over 10 digits",
      template: "{{issue.number}}",
      input: issue("12345678901", "x"),
      result: { ok: false, error: `The issue's number "12345678901" is not 1 to 10 digits.` },
    },
  ])("renders $name", ({ template, input, result }) => {
    expect(renderWorktreeName(template, input, undefined)).toEqual(result);
  });

  it("refuses a type from the map that is not a-z, 0-9 and -", () => {
    expect(
      renderWorktreeName("{{issue.type}}/x", issue("6", "x", ["bug"]), { bug: "../fix" }),
    ).toEqual({ ok: false, error: `The type "../fix" may hold only a-z, 0-9 and "-".` });
  });
});
