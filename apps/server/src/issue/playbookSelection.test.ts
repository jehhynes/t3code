import type { IssueBoardEntry, IssuePlaybookRules } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { parsePlaybooks, selectPlaybook } from "./playbookSelection.ts";

const person = (login: string) => ({ login, name: null, avatarUrl: null });

function entry(overrides: Partial<IssueBoardEntry> = {}): IssueBoardEntry {
  return {
    tracker: "github" as IssueBoardEntry["tracker"],
    host: "github.com",
    scope: "acme/web",
    key: "1",
    displayKey: "#1",
    title: "Issue 1",
    url: "https://github.com/acme/web/issues/1",
    author: null,
    state: { category: "open", name: "open" },
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    status: "Ready",
    blockers: [],
    projectId: null,
    projectTitle: null,
    playbook: null,
    hasOpenThread: false,
    ...overrides,
  };
}

const matches = (rules: IssuePlaybookRules, issue: IssueBoardEntry, viewer: string | null = "me") =>
  selectPlaybook([{ name: "it", rules, prompt: "Work on it." }], issue, viewer) === "it";

describe("selectPlaybook", () => {
  const meAlone = entry({ assignees: [person("Me")] });
  const meAndOthers = entry({ assignees: [person("jessy"), person("me")] });
  const othersOnly = entry({ assignees: [person("jessy")] });
  const nobody = entry();

  it.each([
    ["me", [true, true, false, false]],
    ["meAlone", [true, false, false, false]],
    ["meAndOthers", [false, true, false, false]],
    ["othersOnly", [false, false, true, false]],
    ["nobody", [false, false, false, true]],
  ] as const)("assignee %s tells the four assignments apart", (assignee, expected) => {
    expect(
      [meAlone, meAndOthers, othersOnly, nobody].map((issue) => matches({ assignee }, issue)),
    ).toEqual(expected);
  });

  it("selects by its other rules whoever is assigned when it has no assignee rule", () => {
    for (const issue of [meAlone, meAndOthers, othersOnly, nobody]) {
      expect(matches({ status: ["ready"] }, issue, null)).toBe(true);
    }
  });

  it.each([
    ["status", { status: ["In progress", "ready"] }, entry(), entry({ status: "Done" })],
    ["no status", { status: ["Ready"] }, entry(), entry({ status: null })],
    ["repository", { repository: ["Acme/Web"] }, entry(), entry({ scope: "acme/api" })],
    [
      "labels",
      { labels: ["bug", "Docs"] },
      entry({ labels: [{ name: "docs", color: null }] }),
      entry({ labels: [{ name: "feature", color: null }] }),
    ],
    [
      "blocked",
      { blocked: true },
      entry({
        blockers: [{ scope: "acme/web", key: "2", displayKey: "#2", title: "B", url: "u" }],
      }),
      entry(),
    ],
    [
      "not blocked",
      { blocked: false },
      entry(),
      entry({
        blockers: [{ scope: "acme/web", key: "2", displayKey: "#2", title: "B", url: "u" }],
      }),
    ],
    [
      "every rule",
      { status: ["Ready"], assignee: "me", labels: ["bug"] },
      entry({ assignees: [person("me")], labels: [{ name: "bug", color: null }] }),
      entry({ assignees: [person("me")] }),
    ],
  ] as const)("a %s rule selects the issues it describes", (_name, rules, match, miss) => {
    expect(matches(rules, match)).toBe(true);
    expect(matches(rules, miss)).toBe(false);
  });

  it("gives each issue the first playbook that matches, or none", () => {
    const { playbooks } = parsePlaybooks(
      JSON.stringify([
        {
          name: "develop",
          rules: { status: ["Ready", "In progress"], assignee: "me" },
          prompt: "Develop.",
        },
        { name: "ship", rules: { status: ["In review"] }, prompt: "Ship." },
        { name: "other", prompt: "Other." },
      ]),
    );
    const pick = (issue: IssueBoardEntry) => selectPlaybook(playbooks, issue, "me");
    expect(pick(entry({ assignees: [person("me")] }))).toBe("develop");
    expect(pick(entry({ status: "In progress", assignees: [person("me")] }))).toBe("develop");
    expect(pick(entry({ status: "In review", assignees: [person("me")] }))).toBe("ship");
    expect(pick(entry({ assignees: [person("jessy")] }))).toBe("other");
    expect(selectPlaybook(playbooks.slice(0, 2), entry(), "me")).toBeNull();
  });
});

describe("parsePlaybooks", () => {
  it("leaves out each invalid or repeated playbook with its cause and keeps the rest", () => {
    expect(
      parsePlaybooks(
        JSON.stringify([
          { name: "develop", rules: { assignee: "mine" }, prompt: "p" },
          { name: " ship ", rules: { status: ["In review"] }, prompt: "Ship {{ issue.url }}." },
          { name: "Ship", prompt: "p" },
          { rules: {}, prompt: "p" },
          { name: "extra", launch: true, prompt: "p" },
          { name: "unprompted" },
          { name: "typo", prompt: "Fix {{issue.titel}} in {{issue.repository}}." },
          { name: "mode", prompt: "p", runtimeMode: "yolo" },
          {
            name: "other",
            prompt: "Look at {{issue.title}}.",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
        ]),
      ),
    ).toEqual({
      playbooks: [
        { name: "ship", rules: { status: ["In review"] }, prompt: "Ship {{ issue.url }}." },
        {
          name: "other",
          rules: {},
          prompt: "Look at {{issue.title}}.",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
        },
      ],
      errors: [
        'Playbook 1 (develop): Expected "me" | "meAlone" | "meAndOthers" | "othersOnly" | "nobody" at rules.assignee',
        "Playbook 3 (Ship): an earlier playbook has this name.",
        "Playbook 4: Missing key at name",
        "Playbook 5 (extra): Expected no excess property at launch",
        "Playbook 6 (unprompted): Missing key at prompt",
        "Playbook 7 (typo): the prompt names {{issue.titel}}, which no issue has; use {{issue.number}}, {{issue.title}}, {{issue.url}}, {{issue.repository}}, {{issue.status}}, {{issue.labels}}, {{issue.assignees}}.",
        'Playbook 8 (mode): Expected "approval-required" | "auto-accept-edits" | "auto" | "full-access" at runtimeMode',
      ],
    });
  });

  it("gives one error and no playbooks for a file that is not a JSON list", () => {
    expect(parsePlaybooks('{"name": "develop"}')).toEqual({
      playbooks: [],
      errors: ["playbooks.json must hold a list of playbooks."],
    });
    const broken = parsePlaybooks("[{");
    expect(broken.playbooks).toEqual([]);
    expect(broken.errors[0]).toMatch(/^playbooks\.json is not valid JSON: /);
  });
});
