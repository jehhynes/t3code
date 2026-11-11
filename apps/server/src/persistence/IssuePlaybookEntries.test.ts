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
    const enter = (playbook: string | null, leftAt: string | null = null) =>
      store.reconcile(() => [
        {
          issueKey,
          board: "acme/1",
          playbook,
          startedBy: null,
          autoTried: false,
          startFailure: null,
          leftAt,
          startQueued: false,
        },
      ]);

    const entered = yield* enter("develop");
    assert.deepStrictEqual(entered.get(issueKey), {
      issueKey,
      board: "acme/1",
      playbook: "develop",
      startedBy: null,
      autoTried: false,
      startFailure: null,
      leftAt: null,
      startQueued: false,
    });
    const first = { issueKey, playbook: "Develop", startedBy: "issue-playbook:a" };
    assert.isFalse(yield* store.claim({ ...first, playbook: "ship" }));
    assert.isTrue(yield* store.claim(first));
    assert.isFalse(yield* store.claim({ ...first, startedBy: "issue-playbook:b" }));
    assert.strictEqual((yield* store.list).get(issueKey)?.startedBy, first.startedBy);

    // The issue leaves and comes back while the first Start is still running.
    const leftAt = "2026-11-11T12:00:00.000Z";
    yield* enter(null, leftAt);
    assert.strictEqual((yield* store.list).get(issueKey)?.leftAt, leftAt);
    yield* enter("develop");
    const second = { issueKey, playbook: "develop", startedBy: "issue-playbook:c" };
    assert.isTrue(yield* store.claim(second));
    yield* store.release({ ...first, failure: "stale" });
    assert.deepInclude((yield* store.list).get(issueKey), {
      startedBy: second.startedBy,
      startFailure: null,
    });
    // A failed Start keeps its cause; a later one with no cause, as when interrupted, keeps it too.
    yield* store.release({ ...second, failure: "The launch failed." });
    assert.deepInclude((yield* store.list).get(issueKey), {
      startedBy: null,
      startFailure: "The launch failed.",
    });
    const retry = { ...second, startedBy: "issue-playbook:c2" };
    assert.isTrue(yield* store.claim(retry));
    yield* store.release({ ...retry, failure: null });
    assert.strictEqual((yield* store.list).get(issueKey)?.startFailure, "The launch failed.");
    assert.isTrue(yield* store.claim(retry));
    yield* store.release({ ...retry, failure: "The link failed." });
    assert.strictEqual((yield* store.list).get(issueKey)?.startFailure, "The link failed.");

    // Names compare beyond ASCII, as selection compares them.
    yield* store.reconcile(() => [
      {
        issueKey,
        board: "acme/1",
        playbook: "Équipe",
        startedBy: null,
        autoTried: false,
        startFailure: null,
        leftAt: null,
        startQueued: false,
      },
    ]);
    assert.isTrue(
      yield* store.claim({ issueKey, playbook: "équipe", startedBy: "issue-playbook:d" }),
    );

    const unchanged = yield* store.reconcile(() => []);
    assert.strictEqual(unchanged.size, 1);

    // The server tries an entry by itself once: a release keeps the try, so only Start is left.
    yield* enter(null);
    yield* enter("develop");
    const auto = {
      issueKey,
      playbook: "develop",
      startedBy: "issue-playbook:e",
      auto: true,
      selfStarting: true,
    };
    assert.isTrue(yield* store.claim(auto));
    assert.isTrue((yield* store.list).get(issueKey)?.autoTried);
    yield* store.release({ ...auto, failure: null });
    assert.isFalse(yield* store.claim({ ...auto, startedBy: "issue-playbook:f" }));
    const manual = { issueKey, playbook: "develop", startedBy: "issue-playbook:g" };
    assert.isTrue(yield* store.claim(manual));
    assert.deepStrictEqual((yield* store.list).get(issueKey), {
      issueKey,
      board: "acme/1",
      playbook: "develop",
      startedBy: manual.startedBy,
      autoTried: true,
      startFailure: null,
      leftAt: null,
      startQueued: false,
    });
    // Entering again is a new entry, not tried yet.
    yield* enter(null);
    yield* enter("develop");
    assert.isTrue(yield* store.claim({ ...auto, startedBy: "issue-playbook:h" }));

    // A Start queued behind open blockers (jehhynes/t3code#65): the server claims it by itself
    // once, even for a playbook that waits for Start or an entry it already tried.
    yield* enter(null);
    yield* enter("develop");
    const byItself = { ...auto, selfStarting: false, startedBy: "issue-playbook:i" };
    assert.isFalse(yield* store.claim(byItself));
    const queue = { issueKey, playbook: "Develop", queued: true };
    assert.isFalse(yield* store.setQueued({ ...queue, playbook: "ship" }));
    assert.isTrue(yield* store.setQueued(queue));
    assert.isTrue((yield* store.list).get(issueKey)?.startQueued);
    // Taken back before the claim, it does not start.
    assert.isTrue(yield* store.setQueued({ ...queue, queued: false }));
    assert.isFalse(yield* store.claim(byItself));
    assert.isTrue(yield* store.setQueued(queue));
    assert.isTrue(yield* store.claim(byItself));
    assert.isFalse(yield* store.setQueued({ ...queue, queued: false }));
    yield* store.release({ ...byItself, failure: "The launch failed." });
    assert.deepInclude((yield* store.list).get(issueKey), {
      startedBy: null,
      autoTried: true,
      startFailure: "The launch failed.",
      startQueued: false,
    });
    assert.isFalse(yield* store.claim({ ...byItself, startedBy: "issue-playbook:j" }));
    // Retry queues the tried entry again, keeping its failure, and the server claims it once more.
    assert.isTrue(yield* store.setQueued(queue));
    assert.strictEqual((yield* store.list).get(issueKey)?.startFailure, "The launch failed.");
    assert.isTrue(yield* store.claim({ ...byItself, startedBy: "issue-playbook:k" }));
  }).pipe(
    Effect.provide(
      IssuePlaybookEntries.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
