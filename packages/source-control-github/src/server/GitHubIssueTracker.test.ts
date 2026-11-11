import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { IssueTemplateList } from "@t3tools/contracts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";

const DETAIL_RESPONSE = JSON.stringify({
  data: {
    viewer: { login: "julius" },
    repository: {
      viewerPermission: "TRIAGE",
      issue: {
        __typename: "Issue",
        number: 42,
        title: "Composer loses focus",
        url: "https://github.com/acme/web/issues/42",
        author: {
          __typename: "User",
          login: "octocat",
          avatarUrl: "https://avatars/octocat",
          name: "Octo Cat",
        },
        state: "CLOSED",
        stateReason: "DUPLICATE",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-03T00:00:00Z",
        closedAt: "2026-07-03T00:00:00Z",
        comments: {
          totalCount: 3,
          pageInfo: { hasPreviousPage: true, startCursor: "Y3Vyc29y" },
          nodes: [
            {
              __typename: "IssueComment",
              id: "IC_1",
              author: { __typename: "User", login: "julius", avatarUrl: "https://avatars/julius" },
              body: "Repro attached.",
              createdAt: "2026-07-02T00:00:00Z",
              url: "https://github.com/acme/web/issues/42#issuecomment-1",
              reactionGroups: [
                {
                  content: "THUMBS_UP",
                  viewerHasReacted: true,
                  reactors: {
                    totalCount: 2,
                    nodes: [
                      { __typename: "User", login: "julius" },
                      { __typename: "User", login: "theo" },
                    ],
                  },
                },
                {
                  content: "EYES",
                  viewerHasReacted: false,
                  reactors: { totalCount: 0, nodes: [] },
                },
              ],
            },
          ],
        },
        assignees: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ login: "theo", name: null, avatarUrl: "https://avatars/julius" }],
        },
        labels: {
          pageInfo: { hasNextPage: true, endCursor: "labels-next" },
          nodes: [{ name: "bug", color: "d73a4a" }, null],
        },
        body: "Typing in the composer drops focus after a paste.",
        viewerCanUpdate: false,
        reactionGroups: [],
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 50,
              title: "fix(web): keep composer focus",
              url: "https://github.com/acme/web/pull/50",
              state: "MERGED",
              isDraft: false,
              repository: { nameWithOwner: "acme/web" },
            },
          ],
        },
        timelineItems: {
          nodes: [
            {
              __typename: "LabeledEvent",
              id: "LE_1",
              createdAt: "2026-07-01T01:00:00Z",
              actor: { __typename: "User", login: "theo", avatarUrl: "https://avatars/theo" },
              label: { name: "bug" },
            },
            {
              __typename: "CrossReferencedEvent",
              id: "CRE_1",
              createdAt: "2026-07-02T01:00:00Z",
              actor: { __typename: "User", login: "julius", avatarUrl: "https://avatars/julius" },
              source: {
                __typename: "PullRequest",
                number: 50,
                title: "fix(web): keep composer focus",
                url: "https://github.com/acme/web/pull/50",
                state: "MERGED",
                isDraft: false,
                repository: { nameWithOwner: "acme/web" },
              },
            },
            { __typename: "MentionedEvent", id: "ME_1", createdAt: "2026-07-02T02:00:00Z" },
            {
              __typename: "ClosedEvent",
              id: "CE_1",
              createdAt: "2026-07-03T00:00:00Z",
              actor: null,
            },
          ],
        },
      },
    },
  },
});

const decodeVariables = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

function transport(httpClient: HttpClient.HttpClient) {
  return GitHubRest.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        GitHubQuota.layer,
        SourceControlRateLimit.layer,
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          saved: () => Effect.succeedNone,
          get: (host) =>
            Effect.succeed({
              host,
              token: Redacted.make("test-token"),
              source: "gh" as const,
              fingerprint: "test",
            }),
        }),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
          enabled: false,
          token: () => Effect.succeedNone,
          invalidate: () => Effect.void,
        }),
      ),
    ),
  );
}

function tracker(onRequest: (variables: unknown) => void, templateRepository?: unknown) {
  return GitHubIssueTracker.make.pipe(
    Effect.provide(
      transport(
        HttpClient.make((request) => {
          if (request.body._tag !== "Uint8Array")
            return Effect.die("Expected a GraphQL JSON request.");
          const { variables } = decodeVariables(new TextDecoder().decode(request.body.body));
          onRequest(variables);
          const body =
            templateRepository !== undefined
              ? JSON.stringify({ data: { repository: templateRepository } })
              : "labelsCursor" in variables
                ? JSON.stringify({
                    data: {
                      repository: {
                        issue: {
                          labels: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: [{ name: "needs repro", color: "ffffff" }],
                          },
                          assignees: {
                            pageInfo: { hasNextPage: false, endCursor: null },
                            nodes: [],
                          },
                        },
                      },
                    },
                  })
                : DETAIL_RESPONSE;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(body, {
                headers: { "content-type": "application/json" },
              }),
            ),
          );
        }),
      ),
    ),
  );
}

const encodeTemplateList = Schema.encodeSync(IssueTemplateList);

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

describe("GitHubIssueTracker", () => {
  it.effect("writes an issue lifecycle without mutating pull requests or foreign comments", () =>
    Effect.gen(function* () {
      const writes: unknown[] = [];
      const http = HttpClient.make((request) => {
        if (request.body._tag !== "Uint8Array") return Effect.die("Expected a JSON request.");
        const text = new TextDecoder().decode(request.body.body);
        let response: unknown = {};
        if (request.url === "https://api.github.com/graphql") {
          const { query, variables } = decodeVariables(text);
          expect(request.method).toBe("POST");
          const operation = query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
          if (operation === "IssueNodeId" || operation === "IssueCommentScope") {
            expect(variables).toMatchObject({ owner: "acme", name: "web" });
            response = {
              data: {
                repository: { issue: variables["number"] === 42 ? { id: "I_42" } : null },
                ...(operation === "IssueCommentScope"
                  ? { node: { __typename: "IssueComment", issue: { id: "I_other" } } }
                  : {}),
              },
            };
          } else {
            expect(["AddReaction", "RemoveReaction"]).toContain(operation);
            expect(variables).toEqual({ subjectId: "I_42", content: "THUMBS_UP" });
            writes.push(operation);
            response = {
              data: {
                [operation === "AddReaction" ? "addReaction" : "removeReaction"]: {
                  reaction: { content: "THUMBS_UP" },
                },
              },
            };
          }
        } else {
          writes.push([request.method, request.url, decodeBody(text)]);
          if (request.url.endsWith("/issues")) {
            response = { number: 42, html_url: "https://github.com/acme/web/issues/42" };
          }
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(response), {
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });
      const api = yield* GitHubIssueTracker.make.pipe(Effect.provide(transport(http)));
      const target = { cwd: "/w", host: "github.com", scope: "acme/web", key: "42" };
      expect(
        yield* api.create({
          ...target,
          title: "Fixture",
          body: "Body",
          labels: ["bug"],
          assignees: ["octocat"],
        }),
      ).toEqual({
        key: "42",
        displayKey: "#42",
        url: "https://github.com/acme/web/issues/42",
      });
      yield* api.comment({ ...target, body: "Comment" });
      yield* api.update({ ...target, title: "Updated", body: "Edited", labels: [], assignees: [] });
      yield* api.setState({ ...target, state: "closed", closeReason: "not-planned" });
      yield* api.setState({ ...target, state: "open" });
      yield* api.setReaction({ ...target, content: "thumbs-up", reacted: true });
      yield* api.setReaction({ ...target, content: "thumbs-up", reacted: false });

      const pullRequest = { ...target, key: "50" };
      expect(
        yield* api.update({ ...pullRequest, title: "Do not edit" }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { operation: "update", reason: "not-found" } });
      expect(
        yield* api.setState({ ...pullRequest, state: "closed" }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { operation: "setState", reason: "not-found" },
      });
      expect(
        yield* api.comment({ ...pullRequest, body: "Do not comment" }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { operation: "comment", reason: "not-found" } });
      expect(
        yield* Effect.flip(
          api.setReaction({
            ...target,
            subjectId: "IC_other",
            content: "thumbs-up",
            reacted: true,
          }),
        ),
      ).toMatchObject({ operation: "setReaction", reason: "failed" });

      expect(writes).toEqual([
        [
          "POST",
          "https://api.github.com/repos/acme/web/issues",
          { title: "Fixture", body: "Body", labels: ["bug"], assignees: ["octocat"] },
        ],
        ["POST", "https://api.github.com/repos/acme/web/issues/42/comments", { body: "Comment" }],
        [
          "PATCH",
          "https://api.github.com/repos/acme/web/issues/42",
          { title: "Updated", body: "Edited", labels: [], assignees: [] },
        ],
        [
          "PATCH",
          "https://api.github.com/repos/acme/web/issues/42",
          { state: "closed", state_reason: "not_planned" },
        ],
        ["PATCH", "https://api.github.com/repos/acme/web/issues/42", { state: "open" }],
        "AddReaction",
        "RemoveReaction",
      ]);
    }),
  );

  it.effect("offers YAML issue forms when blank issues are disabled", () =>
    Effect.gen(function* () {
      const form = {
        __typename: "Blob",
        isTruncated: false,
        text: `name: Bug report
description: Report broken behavior.
title: "[Bug]: "
labels: [bug, needs-triage]
assignees: "octocat, theo"
body:
  - type: markdown
    attributes:
      value: Search existing issues first.
  - type: checkboxes
    attributes:
      label: Before submitting
      options:
        - label: I searched existing issues.
          required: true
  - type: dropdown
    attributes:
      label: Area
      description: Which part is affected?
      options: [Web, Server]
      default: 1
    validations:
      required: true
  - type: textarea
    attributes:
      label: Steps to reproduce
      placeholder: Start the app.
  - type: input
    attributes:
      label: Version
      value: main
  - type: upload
    attributes:
      label: Supporting files
      description: Redact secrets before uploading.
`,
      };
      const config = {
        __typename: "Blob",
        isTruncated: false,
        text: '"blank_issues_enabled": false # use a template',
      };
      const repository = {
        issueTemplates: [],
        templateDirectory: {
          __typename: "Tree",
          entries: [
            { name: "config.yml", object: config },
            { name: "bug_report.yml", object: form },
            {
              name: "empty_name.yml",
              object: { ...form, text: 'name: ""\ndescription: Empty name\nbody: []' },
            },
            {
              name: "blank_name.yml",
              object: { ...form, text: 'name: "   "\ndescription: Blank name\nbody: []' },
            },
            {
              name: "invalid.yml",
              object: { ...form, text: "name: Missing required metadata\nbody: []" },
            },
          ],
        },
      };
      const api = yield* tracker(() => {}, repository);
      const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
      const result = yield* api.listTemplates!(input);
      expect(encodeTemplateList(result)).toEqual(result);
      expect(result.blankIssuesEnabled).toBe(false);
      expect(result.templates).toHaveLength(1);
      expect(result.templates[0]).toMatchObject({
        key: "bug_report.yml",
        name: "Bug report",
        about: "Report broken behavior.",
        title: "[Bug]: ",
        labels: ["bug", "needs-triage"],
        assignees: ["octocat", "theo"],
      });
      expect(result.templates[0]?.body).toBe(`Search existing issues first.

### Before submitting

- [ ] I searched existing issues. (required)

### Area

Which part is affected?

Required.

Choose one:

- Web
- Server (default)

### Steps to reproduce

Example:
> Start the app.

### Version

main

### Supporting files

Redact secrets before uploading.`);
      config.isTruncated = true;
      expect(yield* Effect.flip(api.listTemplates!(input))).toMatchObject({
        reason: "failed",
        detail: "GitHub returned incomplete issue template contents.",
      });
    }),
  );

  it.effect("maps a detail read to the neutral issue shape", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const api = yield* tracker((variables) => {
        seen.push(variables);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
      });
      expect(seen).toEqual([
        { owner: "acme", name: "web", number: 42 },
        {
          owner: "acme",
          name: "web",
          number: 42,
          labelsCursor: "labels-next",
          assigneesCursor: null,
        },
      ]);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        title: "Composer loses focus",
        body: "Typing in the composer drops focus after a paste.",
        state: { category: "closed", name: "closed", closeReason: "duplicate" },
        author: {
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://avatars/octocat",
        },
        assignees: [{ login: "theo" }],
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "needs repro", color: "ffffff" },
        ],
        commentCount: 3,
        viewer: "julius",
        // Triage may label and assign; `viewerCanUpdate: false` withholds state and edits.
        viewerPermissions: {
          setState: false,
          edit: false,
          labels: true,
          assignees: true,
          comment: true,
        },
        commentsCursor: "Y3Vyc29y",
      });
      // The viewer is left out of `actors` and shown as "You"; an empty group is dropped.
      expect(issue.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      // The closing reference wins over the cross-reference sighting of the same pull request.
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://github.com/acme/web/pull/50",
          state: "merged",
          isDraft: false,
          closesIssue: true,
        },
      ]);
      // An event kind this page has no vocabulary for is dropped rather than guessed at.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "acme/web#50"],
        ["closed", null],
      ]);
    }),
  );

  describe("listBoard", () => {
    const BOARD = { host: "github.com", owner: "Acme", number: 7, statusField: "Status" };
    const STATUS_FIELD = { __typename: "ProjectV2SingleSelectField", name: "Status" };

    function boardNode(number: number, repository: string, extra: Record<string, unknown> = {}) {
      return {
        __typename: "Issue",
        number,
        title: `Issue ${number}`,
        url: `https://github.com/${repository}/issues/${number}`,
        state: "OPEN",
        stateReason: null,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        closedAt: null,
        author: null,
        assignees: { nodes: [] },
        labels: { nodes: [] },
        comments: { totalCount: 0 },
        repository: { nameWithOwner: repository },
        projectItems: { nodes: [] },
        blockedBy: { nodes: [] },
        ...extra,
      };
    }

    function search(nodes: ReadonlyArray<unknown>, endCursor: string | null, issueCount = 101) {
      return {
        data: {
          search: {
            issueCount,
            pageInfo: { hasNextPage: endCursor !== null, endCursor },
            nodes,
          },
        },
      };
    }

    /** Answers each operation from `answers`, recording the operations and variables sent. */
    function boardTracker(
      answers: {
        readonly fields: unknown;
        readonly pages?: ReadonlyArray<unknown>;
        /** Answers a batch of `BoardIssue` reads from its aliased variables. */
        readonly issues?: (variables: Record<string, unknown>) => unknown;
      },
      sent: Array<{ operation: string | undefined; variables: unknown }>,
    ) {
      let page = 0;
      return GitHubIssueTracker.make.pipe(
        Effect.provide(
          transport(
            HttpClient.make((request) => {
              if (request.body._tag !== "Uint8Array")
                return Effect.die("Expected a GraphQL JSON request.");
              const { query, variables } = decodeVariables(
                new TextDecoder().decode(request.body.body),
              );
              const operation = query.match(/query\s+(\w+)/)?.[1];
              sent.push({ operation, variables });
              const body =
                operation === "BoardFields"
                  ? answers.fields
                  : operation === "BoardIssue"
                    ? answers.issues?.(variables)
                    : answers.pages?.[page++];
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify(body), {
                    headers: { "content-type": "application/json" },
                  }),
                ),
              );
            }),
          ),
        ),
      );
    }

    const onBoard = {
      project: { number: 7, owner: { __typename: "Organization", login: "acme" } },
      fieldValueByName: { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Ready" },
    };
    const elsewhere = {
      project: { number: 8, owner: { __typename: "Organization", login: "acme" } },
      fieldValueByName: null,
    };

    /** One `BoardIssue` slice's answer: its `repository` value and the errors under its alias. */
    type IssueSlice = (alias: string) => {
      readonly repository: unknown;
      readonly errors?: ReadonlyArray<unknown>;
    };
    const openIssue =
      (number: number, items: ReadonlyArray<unknown>, hasNextPage = false): IssueSlice =>
      () => {
        const { __typename: _, ...node } = boardNode(number, "acme/web", {
          title: `Direct ${number}`,
        });
        return {
          repository: {
            issue: { ...node, projectItems: { pageInfo: { hasNextPage }, nodes: items } },
          },
        };
      };
    /** Answers each aliased slice by the issue number it asks for. */
    const issueSlices =
      (slices: Record<number, IssueSlice>) => (variables: Record<string, unknown>) => {
        const data: Record<string, unknown> = {};
        const errors: unknown[] = [];
        for (const [name, value] of Object.entries(variables)) {
          const prefix = /^(_\d+_)number$/.exec(name)?.[1];
          if (prefix === undefined) continue;
          const slice = slices[value as number]!(`${prefix}repository`);
          data[`${prefix}repository`] = slice.repository;
          errors.push(...(slice.errors ?? []));
        }
        return errors.length === 0 ? { data } : { data, errors };
      };

    const fieldsAnswer = (nodes: ReadonlyArray<unknown>) => ({
      data: {
        repositoryOwner: { __typename: "Organization", projectV2: { fields: { nodes } } },
      },
    });

    it.effect(
      "reads every page of the board across repositories, with its status and open blockers",
      () =>
        Effect.gen(function* () {
          const sent: Array<{ operation: string | undefined; variables: unknown }> = [];
          const firstPage = Array.from({ length: 100 }, (_, index) =>
            boardNode(index + 1, "acme/web"),
          );
          firstPage[0] = boardNode(1, "acme/web", {
            projectItems: {
              nodes: [
                // Another board's item is ignored, though its status field shares the name.
                {
                  project: { number: 7, owner: { __typename: "User", login: "someone" } },
                  fieldValueByName: {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: "Done",
                  },
                },
                {
                  project: { number: 7, owner: { __typename: "Organization", login: "acme" } },
                  fieldValueByName: {
                    __typename: "ProjectV2ItemFieldSingleSelectValue",
                    name: "In progress",
                  },
                },
              ],
            },
            blockedBy: {
              nodes: [
                {
                  number: 3,
                  title: "Open blocker",
                  url: "https://github.com/acme/api/issues/3",
                  state: "OPEN",
                  repository: { nameWithOwner: "acme/api" },
                },
                {
                  number: 4,
                  title: "Closed blocker",
                  url: "https://github.com/acme/web/issues/4",
                  state: "CLOSED",
                  repository: { nameWithOwner: "acme/web" },
                },
              ],
            },
          });
          const api = yield* boardTracker(
            {
              fields: fieldsAnswer([{ __typename: "ProjectV2Field", name: "Title" }, STATUS_FIELD]),
              pages: [
                search(firstPage, "page-2"),
                search([boardNode(101, "acme/api"), { __typename: "PullRequest" }], null),
              ],
            },
            sent,
          );

          // Every recorded issue is listed, so none is read on its own.
          const issues = yield* api.listBoard!({
            ...BOARD,
            recorded: [
              { scope: "acme/web", key: "1" },
              { scope: "ACME/API", key: "101" },
            ],
          });

          expect(sent).toEqual([
            { operation: "BoardFields", variables: { owner: "Acme", number: 7 } },
            {
              operation: "BoardIssues",
              variables: { q: "is:issue is:open project:Acme/7", status: "Status", cursor: null },
            },
            {
              operation: "BoardIssues",
              variables: {
                q: "is:issue is:open project:Acme/7",
                status: "Status",
                cursor: "page-2",
              },
            },
          ]);
          expect(issues).toHaveLength(101);
          expect(new Set(issues.map((issue) => issue.scope))).toEqual(
            new Set(["acme/web", "acme/api"]),
          );
          expect(issues[0]).toMatchObject({
            key: "1",
            scope: "acme/web",
            status: "In progress",
            blockers: [
              {
                scope: "acme/api",
                key: "3",
                displayKey: "acme/api#3",
                title: "Open blocker",
                url: "https://github.com/acme/api/issues/3",
              },
            ],
          });
          expect(issues[1]).toMatchObject({ status: null, blockers: [] });
        }),
    );

    it.effect("confirms each recorded issue the search leaves out, in one request", () =>
      Effect.gen(function* () {
        const sent: Array<{ operation: string | undefined; variables: unknown }> = [];
        const api = yield* boardTracker(
          {
            fields: fieldsAnswer([STATUS_FIELD]),
            pages: [search([boardNode(1, "Acme/Web")], null, 1)],
            issues: issueSlices({
              2: openIssue(2, [elsewhere, onBoard]),
              3: () => {
                const { __typename: _, ...node } = boardNode(3, "acme/web", { state: "CLOSED" });
                return {
                  repository: {
                    issue: {
                      ...node,
                      projectItems: { pageInfo: { hasNextPage: false }, nodes: [onBoard] },
                    },
                  },
                };
              },
              4: (alias) => ({
                repository: { issue: null },
                errors: [{ type: "NOT_FOUND", path: [alias, "issue"], message: "No issue" }],
              }),
              5: (alias) => ({
                repository: null,
                errors: [{ type: "NOT_FOUND", path: [alias], message: "No repository" }],
              }),
              6: openIssue(6, [elsewhere]),
            }),
          },
          sent,
        );

        const issues = yield* api.listBoard!({
          ...BOARD,
          recorded: [
            { scope: "acme/web", key: "1" },
            { scope: "acme/web", key: "2" },
            { scope: "acme/web", key: "3" },
            { scope: "acme/web", key: "4" },
            { scope: "acme/gone", key: "5" },
            { scope: "acme/web", key: "6" },
          ],
        });

        expect(issues.map((issue) => [issue.key, issue.title, issue.status])).toEqual([
          ["1", "Issue 1", null],
          ["2", "Direct 2", "Ready"],
        ]);
        expect(sent.filter((entry) => entry.operation === "BoardIssue")).toHaveLength(1);
      }),
    );

    it.effect("refuses a board it cannot read whole before listing anything", () =>
      Effect.gen(function* () {
        const cases = [
          {
            fields: fieldsAnswer([{ __typename: "ProjectV2Field", name: "Title" }]),
            detail: 'Project Acme/7 has no field named "Status".',
            searches: 0,
          },
          {
            fields: fieldsAnswer([{ __typename: "ProjectV2Field", name: "Status" }]),
            detail:
              'The "Status" field on project Acme/7 is a ProjectV2Field, not a single-select field.',
            searches: 0,
          },
          {
            fields: { data: { repositoryOwner: null } },
            detail: "GitHub has no project Acme/7 that this account can read.",
            searches: 0,
          },
          {
            fields: {
              data: { repositoryOwner: { __typename: "User", projectV2: null } },
              errors: [{ type: "NOT_FOUND", message: "Could not resolve to a ProjectV2" }],
            },
            detail: "GitHub has no project Acme/7 that this account can read.",
            searches: 0,
          },
          {
            fields: fieldsAnswer([STATUS_FIELD]),
            pages: [search([boardNode(1, "acme/web")], "page-2", 1_001)],
            detail:
              "Project Acme/7 has more than 1,000 open issues, which GitHub search cannot list.",
            searches: 1,
          },
          {
            fields: fieldsAnswer([STATUS_FIELD]),
            pages: [search([], null, 0)],
            issues: issueSlices({
              2: (alias) => ({
                repository: null,
                errors: [{ type: "FORBIDDEN", path: [alias], message: "Resource not accessible" }],
              }),
            }),
            detail:
              "Could not confirm that acme/web#2 left project Acme/7: The GitHub issue request failed.",
            searches: 1,
          },
          {
            // Only a missing repository or issue is gone; a missing nested field cannot tell.
            fields: fieldsAnswer([STATUS_FIELD]),
            pages: [search([], null, 0)],
            issues: issueSlices({
              2: (alias) => ({
                ...openIssue(2, [onBoard])(alias),
                errors: [
                  { type: "NOT_FOUND", path: [alias, "issue", "blockedBy"], message: "Gone" },
                ],
              }),
            }),
            detail:
              "Could not confirm that acme/web#2 left project Acme/7: GitHub could not find the requested issue.",
            searches: 1,
          },
          {
            // An error that nulls the whole answer fails every slice, so none counts as missing.
            fields: fieldsAnswer([STATUS_FIELD]),
            pages: [search([], null, 0)],
            issues: () => ({
              data: null,
              errors: [{ type: "NOT_FOUND", path: ["_0_repository"], message: "No repository" }],
            }),
            detail:
              "Could not confirm that acme/web#2 left project Acme/7: GitHub could not find the requested issue.",
            searches: 1,
          },
          {
            fields: fieldsAnswer([STATUS_FIELD]),
            pages: [search([], null, 0)],
            issues: issueSlices({ 2: openIssue(2, [elsewhere], true) }),
            detail:
              "Could not confirm that acme/web#2 left project Acme/7: it is on more projects than one read lists.",
            searches: 1,
          },
          {
            fields: fieldsAnswer([STATUS_FIELD]),
            pages: [search([], null, 0)],
            issues: issueSlices({
              2: () => {
                const { __typename: _, ...node } = boardNode(2, "acme/web", { projectItems: null });
                return { repository: { issue: node } };
              },
            }),
            detail:
              "Could not confirm that acme/web#2 left project Acme/7: GitHub did not say which projects it is on.",
            searches: 1,
          },
        ];
        for (const { detail, searches, ...answers } of cases) {
          const sent: Array<{ operation: string | undefined; variables: unknown }> = [];
          const api = yield* boardTracker(answers, sent);
          expect(
            yield* Effect.flip(
              api.listBoard!({ ...BOARD, recorded: [{ scope: "acme/web", key: "2" }] }),
            ),
          ).toMatchObject({
            operation: "listBoard",
            reason: "failed",
            detail,
          });
          expect(sent.filter((entry) => entry.operation === "BoardIssues")).toHaveLength(searches);
        }
      }),
    );
  });
});
