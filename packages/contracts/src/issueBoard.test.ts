import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { IssueBoardEntry, IssuePlaybookStartInput } from "./issueBoard.ts";

const entry = {
  tracker: "github",
  host: "github.com",
  scope: "acme/web",
  key: "6",
  displayKey: "#6",
  title: "Start a thread",
  url: "https://github.com/acme/web/issues/6",
  author: null,
  state: { category: "open", name: "open" },
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T00:00:00Z",
  closedAt: null,
  assignees: [],
  labels: [],
  commentCount: 0,
  status: "Ready",
  blockers: [],
  projectId: "web",
  projectTitle: "web",
};

// The Start input of a server older than jehhynes/t3code#65.
const decodeOlderStartInput = Schema.decodeUnknownSync(
  Schema.Struct({ playbook: Schema.String, entry: IssueBoardEntry }),
);
const decodeStartInput = Schema.decodeUnknownSync(IssuePlaybookStartInput);

describe("IssuePlaybookStartInput", () => {
  it("takes a queued start back in a form an older server refuses rather than starts", () => {
    const cancel = { playbook: "develop", cancelQueued: entry };
    expect(decodeStartInput(cancel)).toMatchObject({
      cancelQueued: { key: "6" },
    });
    expect(() => decodeOlderStartInput(cancel)).toThrow();
    expect(decodeStartInput({ playbook: "develop", entry })).toMatchObject({ entry: { key: "6" } });
  });
});
