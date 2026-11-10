import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as IssuePlaybookEntries from "./IssuePlaybookEntries.ts";
import { runMigrations } from "./Migrations.ts";

it.effect("starts an entry once, and a failed Start releases only its own claim", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runMigrations();
    const store = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
    const issueKey = "github github.com acme/web 1";
    const enter = (playbook: string | null) =>
      store.reconcile(() => [
        { issueKey, board: "acme/1", playbook, startedBy: null, autoTried: false },
      ]);

    const entered = yield* enter("develop");
    assert.deepStrictEqual(entered.get(issueKey), {
      issueKey,
      board: "acme/1",
      playbook: "develop",
      startedBy: null,
      autoTried: false,
    });
    const first = { issueKey, playbook: "Develop", startedBy: "issue-playbook:a" };
    assert.isFalse(yield* store.claim({ ...first, playbook: "ship" }));
    assert.isTrue(yield* store.claim(first));
    assert.isFalse(yield* store.claim({ ...first, startedBy: "issue-playbook:b" }));
    assert.strictEqual((yield* store.list).get(issueKey)?.startedBy, first.startedBy);

    // The issue leaves and comes back while the first Start is still running.
    yield* enter(null);
    yield* enter("develop");
    const second = { issueKey, playbook: "develop", startedBy: "issue-playbook:c" };
    assert.isTrue(yield* store.claim(second));
    yield* store.release(first);
    assert.strictEqual((yield* store.list).get(issueKey)?.startedBy, second.startedBy);
    yield* store.release(second);
    assert.strictEqual((yield* store.list).get(issueKey)?.startedBy, null);

    // Names compare beyond ASCII, as selection compares them.
    yield* store.reconcile(() => [
      { issueKey, board: "acme/1", playbook: "Équipe", startedBy: null, autoTried: false },
    ]);
    assert.isTrue(
      yield* store.claim({ issueKey, playbook: "équipe", startedBy: "issue-playbook:d" }),
    );

    const unchanged = yield* store.reconcile(() => []);
    assert.strictEqual(unchanged.size, 1);

    // The server tries an entry by itself once: a release keeps the try, so only Start is left.
    yield* enter(null);
    yield* enter("develop");
    const auto = { issueKey, playbook: "develop", startedBy: "issue-playbook:e", auto: true };
    assert.isTrue(yield* store.claim(auto));
    assert.isTrue((yield* store.list).get(issueKey)?.autoTried);
    yield* store.release(auto);
    assert.isFalse(yield* store.claim({ ...auto, startedBy: "issue-playbook:f" }));
    const manual = { issueKey, playbook: "develop", startedBy: "issue-playbook:g" };
    assert.isTrue(yield* store.claim(manual));
    assert.deepStrictEqual((yield* store.list).get(issueKey), {
      issueKey,
      board: "acme/1",
      playbook: "develop",
      startedBy: manual.startedBy,
      autoTried: true,
    });
    // Entering again is a new entry, not tried yet.
    yield* enter(null);
    yield* enter("develop");
    assert.isTrue(yield* store.claim({ ...auto, startedBy: "issue-playbook:h" }));
  }).pipe(
    Effect.provide(
      IssuePlaybookEntries.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
