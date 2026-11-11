import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import type { ThreadLaunchInput } from "../orchestration-v2/ThreadLaunchService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueWorktrees from "./IssueWorktrees.ts";

const withFolders = <A, E>(
  folders: Record<string, string>,
  body: (
    service: IssueWorktrees.IssueWorktrees["Service"],
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const service = yield* IssueWorktrees.IssueWorktrees;
    return yield* body(service);
  }).pipe(
    Effect.provide(
      IssueWorktrees.layer.pipe(
        Layer.provide(
          Layer.merge(
            ServerSettings.layerTest({
              issueWorktrees: Object.fromEntries(
                Object.entries(folders).map(([repository, folder]) => [repository, { folder }]),
              ),
            }),
            // The project is a fork checkout of acme/web whose origin is me/web.
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/web",
                  locator: {} as never,
                  origin: { canonicalKey: "github.com/me/web" },
                }),
            }),
          ),
        ),
      ),
    ),
  );

describe("IssueWorktrees.checkFolder", () => {
  it.effect.each([
    {
      name: "a new folder in the configured folder, relative to the project",
      path: "worktrees/6-start",
      allowed: true,
    },
    {
      name: "a new folder in an absolute configured folder",
      path: "absolute/6-start",
      allowed: true,
    },
    {
      name: "a folder reached through a symlink to the configured folder",
      path: "linked/6-start",
      allowed: true,
    },
    { name: "a folder in no configured folder", path: "elsewhere/6-start", allowed: false },
    {
      name: "a folder that another repository's setting names",
      path: "other/6-start",
      allowed: false,
    },
    {
      name: "a folder in a configured folder that is the filesystem root",
      path: "rootlink/6-start",
      own: "rootlink/{{issue.number}}",
      allowed: false,
    },
    { name: "a folder that already exists", path: "worktrees/taken", allowed: false },
    {
      name: "a symlink at the folder, even one that leads nowhere",
      path: "worktrees/dangling",
      allowed: false,
    },
    {
      name: "a folder whose parent is a symlink out of the configured folder",
      path: "worktrees/out/6-start",
      allowed: false,
    },
    {
      name: "a path that is not normalized",
      path: "worktrees/../elsewhere/6-start",
      allowed: false,
    },
    {
      name: "a folder in a parent that names an issue field",
      path: "{{issue.slug}}/6-start",
      own: "{{issue.slug}}/{{issue.number}}",
      allowed: false,
    },
  ])("$name: allowed $allowed", ({ path, own, allowed }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3code-issue-worktrees-" }),
      );
      const workspaceRoot = `${dir}/project`;
      yield* fs.makeDirectory(`${dir}/project`);
      yield* fs.makeDirectory(`${dir}/worktrees/taken`, { recursive: true });
      yield* fs.makeDirectory(`${dir}/absolute`);
      yield* fs.makeDirectory(`${dir}/elsewhere`);
      yield* fs.makeDirectory(`${dir}/other`);
      yield* fs.symlink(`${dir}/missing`, `${dir}/worktrees/dangling`);
      yield* fs.symlink(`${dir}/elsewhere`, `${dir}/worktrees/out`);
      yield* fs.symlink(`${dir}/worktrees`, `${dir}/linked`);
      yield* fs.symlink("/", `${dir}/rootlink`);
      const worktreePath = `${dir}/${path}`;
      const result = yield* withFolders(
        {
          "acme/web":
            own === undefined ? "../worktrees/{{issue.number}}-{{issue.slug}}" : `${dir}/${own}`,
          // The fork's origin, as boards map its issues to this project, in any case.
          "Me/Web": `${dir}/absolute/{{issue.number}}`,
          // Resolved against another project's folder, it would name this one's sibling.
          "acme/api": "../other/{{issue.number}}",
        },
        (service) => service.checkFolder({ workspaceRoot, worktreePath }).pipe(Effect.result),
      );
      assert.equal(result._tag === "Success", allowed);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("IssueWorktrees.nameDraft", () => {
  const launch = (
    workspaceStrategy: ThreadLaunchInput["workspaceStrategy"],
  ): ThreadLaunchInput => ({
    commandId: CommandId.make("command-1"),
    threadId: ThreadId.make("draft-1"),
    projectId: ProjectId.make("web"),
    title: "#6 Start",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4-mini" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    workspaceStrategy,
    createdBy: "user",
    creationSource: "web",
  });
  const named = { branch: "fix/6-start", worktreePath: "/projects/web.worktrees/6-start" };

  it.effect(
    "names only a recorded draft's new worktree, working the names out once they hold",
    () =>
      withFolders({}, (service) =>
        Effect.gen(function* () {
          let worked = 0;
          let holds = false;
          yield* service.recordDraft(ThreadId.make("draft-1"), () =>
            Effect.suspend(() => {
              worked += 1;
              return holds
                ? Effect.succeed(named)
                : Effect.fail(
                    new IssueWorktrees.IssueWorktreeError({ detail: "The folder already exists." }),
                  );
            }),
          );
          const fresh = launch({ type: "worktree", baseRef: "switchboard" });

          const refused = yield* service.nameDraft(fresh).pipe(Effect.flip);
          assert.equal(refused.detail, "The folder already exists.");
          holds = true;
          assert.deepEqual((yield* service.nameDraft(fresh)).workspaceStrategy, {
            type: "worktree",
            baseRef: "switchboard",
            ...named,
          });
          // A replayed launch's folder exists by now.
          holds = false;
          assert.deepEqual((yield* service.nameDraft(fresh)).workspaceStrategy, {
            type: "worktree",
            baseRef: "switchboard",
            ...named,
          });
          assert.equal(worked, 2);

          for (const strategy of [
            { type: "root" },
            { type: "existing_worktree", worktreePath: "/elsewhere" },
            { type: "worktree", baseRef: "main", branch: "mine" },
            { type: "worktree", baseRef: "main", worktreePath: "/projects/web.worktrees/mine" },
          ] as const) {
            assert.deepEqual(
              (yield* service.nameDraft(launch(strategy))).workspaceStrategy,
              strategy,
            );
          }
          const other = { ...fresh, threadId: ThreadId.make("draft-2") };
          assert.deepEqual(yield* service.nameDraft(other), other);
          yield* service.forgetDraft(ThreadId.make("draft-1"));
          assert.deepEqual(yield* service.nameDraft(fresh), fresh);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
