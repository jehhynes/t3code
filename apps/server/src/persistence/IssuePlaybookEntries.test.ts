import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as IssuePlaybookEntries from "./IssuePlaybookEntries.ts";
import { runMigrations } from "./Migrations.ts";

it.effect("starts an entry once, and a failed Start releases only its own claim", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
    const issueKey = "github github.com acme/web 1";
    const entered = "2026-11-11T10:00:00.000Z";
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
          waitingSince: entered,
          snoozedUntil: null,
          triage: null,
          nothingNewSince: null,
        },
      ]);

    const rows = yield* enter("develop");
    assert.deepStrictEqual(rows.get(issueKey), {
      issueKey,
      board: "acme/1",
      playbook: "develop",
      startedBy: null,
      autoTried: false,
      startFailure: null,
      leftAt: null,
      startQueued: false,
      waitingSince: entered,
      snoozedUntil: null,
      triage: null,
      nothingNewSince: null,
    });
    const first = {
      issueKey,
      playbook: "Develop",
      startedBy: "issue-playbook:a",
      messageId: "message-a",
    };
    // Fork-only (jehhynes/t3code#102): a claim records its prompt's playbook; a refused one does not.
    const starts = sql<{ messageId: string; issueKey: string; playbook: string }>`
      SELECT message_id AS "messageId", issue_key AS "issueKey", playbook
      FROM issue_playbook_starts ORDER BY message_id
    `;
    assert.isFalse(yield* store.claim({ ...first, playbook: "ship" }));
    assert.deepStrictEqual(yield* starts, []);
    assert.isTrue(yield* store.claim(first));
    assert.isFalse(
      yield* store.claim({ ...first, startedBy: "issue-playbook:b", messageId: "message-b" }),
    );
    assert.deepStrictEqual(yield* starts, [
      { messageId: "message-a", issueKey, playbook: "develop" },
    ]);
    assert.strictEqual((yield* store.list).get(issueKey)?.startedBy, first.startedBy);

    // The issue leaves and comes back while the first Start is still running.
    const leftAt = "2026-11-11T12:00:00.000Z";
    yield* enter(null, leftAt);
    assert.strictEqual((yield* store.list).get(issueKey)?.leftAt, leftAt);
    yield* enter("develop");
    const second = {
      issueKey,
      playbook: "develop",
      startedBy: "issue-playbook:c",
      messageId: "message-c",
    };
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
    // A released start keeps its record: its prompt may still have reached a thread.
    assert.deepInclude(yield* starts, { messageId: "message-c", issueKey, playbook: "develop" });

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
        waitingSince: null,
        snoozedUntil: null,
        triage: null,
        nothingNewSince: null,
      },
    ]);
    assert.isTrue(
      yield* store.claim({
        issueKey,
        playbook: "équipe",
        startedBy: "issue-playbook:d",
        messageId: "message-d",
      }),
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
      messageId: "message-e",
      auto: true,
      selfStarting: true,
    };
    assert.isTrue(yield* store.claim(auto));
    assert.isTrue((yield* store.list).get(issueKey)?.autoTried);
    yield* store.release({ ...auto, failure: null });
    assert.isFalse(yield* store.claim({ ...auto, startedBy: "issue-playbook:f" }));
    const manual = {
      issueKey,
      playbook: "develop",
      startedBy: "issue-playbook:g",
      messageId: "message-g",
    };
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
      waitingSince: entered,
      snoozedUntil: null,
      triage: null,
      nothingNewSince: null,
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
    const queuedAt = "2026-11-11T11:00:00.000Z";
    const queue = { issueKey, playbook: "Develop", queued: true, now: queuedAt };
    assert.isFalse(yield* store.setQueued({ ...queue, playbook: "ship" }));
    assert.isTrue(yield* store.setQueued(queue));
    assert.deepInclude((yield* store.list).get(issueKey), {
      startQueued: true,
      waitingSince: queuedAt,
    });
    // A Start queued again, as from another client, keeps its place (jehhynes/t3code#76).
    assert.isTrue(yield* store.setQueued({ ...queue, now: "2026-11-11T11:30:00.000Z" }));
    assert.strictEqual((yield* store.list).get(issueKey)?.waitingSince, queuedAt);
    // Taken back before the claim, it does not start, and keeps when it began to wait.
    assert.isTrue(yield* store.setQueued({ ...queue, queued: false, now: "unused" }));
    assert.strictEqual((yield* store.list).get(issueKey)?.waitingSince, queuedAt);
    assert.isFalse(yield* store.claim(byItself));
    // Queued again after that, it waits from then.
    const requeuedAt = "2026-11-11T12:00:00.000Z";
    assert.isTrue(yield* store.setQueued({ ...queue, now: requeuedAt }));
    assert.strictEqual((yield* store.list).get(issueKey)?.waitingSince, requeuedAt);
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

    // A snooze holds the waiting entry's claim and queue until its wake (jehhynes/t3code#86).
    yield* enter(null);
    yield* enter("develop");
    const wake = "2026-11-11T13:00:00.000Z";
    const before = "2026-11-11T12:59:59.999Z";
    const snooze = { issueKey, playbook: "Develop", until: "2026-11-11T12:30:00.000Z" };
    assert.isFalse(yield* store.setSnoozed({ ...snooze, playbook: "ship" }));
    assert.isTrue(yield* store.setQueued(queue));
    assert.isTrue(yield* store.setSnoozed(snooze));
    // Snoozing again replaces the wake.
    assert.isTrue(yield* store.setSnoozed({ ...snooze, until: wake }));
    assert.deepInclude((yield* store.list).get(issueKey), {
      startQueued: true,
      snoozedUntil: wake,
    });
    const snoozedClaim = { ...byItself, startedBy: "issue-playbook:l", now: before };
    assert.isFalse(yield* store.claim(snoozedClaim));
    assert.isFalse(yield* store.claim({ ...manual, startedBy: "issue-playbook:m", now: before }));
    // Cancel start still takes the queue back, and queueing again waits for the wake.
    assert.isTrue(yield* store.setQueued({ ...queue, queued: false }));
    assert.isFalse(yield* store.setQueued({ ...queue, now: before }));
    assert.isTrue(yield* store.setQueued({ ...queue, now: wake }));
    // At the wake it starts, and the claim clears the snooze.
    assert.isTrue(yield* store.claim({ ...snoozedClaim, now: wake }));
    assert.deepInclude((yield* store.list).get(issueKey), { snoozedUntil: null });
    // A draft's send claims with no time, so a snooze does not hold it.
    yield* enter(null);
    yield* enter("develop");
    assert.isTrue(yield* store.setSnoozed({ ...snooze, until: wake }));
    assert.isTrue(yield* store.claim({ ...manual, startedBy: "issue-playbook-draft:n" }));
    assert.isFalse(yield* store.setSnoozed({ ...snooze, until: null }));
  }).pipe(
    Effect.provide(
      IssuePlaybookEntries.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);

// Fork-only (jehhynes/t3code#93)
it.effect("records a triage playbook's choice only for the entry it classified", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* IssuePlaybookEntries.IssuePlaybookEntriesRepository;
    const issueKey = "github github.com acme/web 1";
    const entered = "2026-11-11T10:00:00.000Z";
    const waiting = {
      issueKey,
      board: "acme/1",
      playbook: "triage",
      startedBy: null,
      autoTried: false,
      startFailure: null,
      leftAt: null,
      startQueued: false,
      waitingSince: entered,
      snoozedUntil: null,
      triage: null,
      nothingNewSince: null,
    };
    yield* store.reconcile(() => [waiting]);
    const outcome = { issueKey, triage: "Triage", waitingSince: entered };

    // An answer for another entry of the issue writes nothing.
    assert.isFalse(yield* store.setTriage({ ...outcome, waitingSince: null, chosen: "fix" }));
    assert.isTrue(
      yield* store.setTriage({ ...outcome, failure: "The classifier could not answer." }),
    );
    assert.isTrue(yield* store.setTriage({ ...outcome, failure: null }));
    assert.isTrue(yield* store.setTriage({ ...outcome, chosen: "fix" }));
    assert.deepInclude((yield* store.list).get(issueKey), {
      playbook: "fix",
      triage: "triage",
      startFailure: null,
      waitingSince: entered,
    });
    // Once chosen, it is no longer classified, and Start claims it as the chosen playbook's.
    assert.isFalse(yield* store.setTriage({ ...outcome, chosen: "answer" }));
    assert.isFalse(
      yield* store.claim({
        issueKey,
        playbook: "triage",
        startedBy: "issue-playbook:a",
        messageId: "message-a",
      }),
    );

    // A dropped choice goes back to the triage playbook, unclassified.
    const reset = { issueKey, triage: "triage", playbook: "Fix", waitingSince: entered };
    assert.isFalse(yield* store.resetTriage({ ...reset, playbook: "answer" }));
    assert.isTrue(yield* store.resetTriage(reset));
    assert.deepInclude((yield* store.list).get(issueKey), { playbook: "triage", triage: null });

    // A draft opened on the triage playbook still claims the entry after the choice.
    assert.isTrue(yield* store.setTriage({ ...outcome, chosen: "fix" }));
    assert.isTrue(
      yield* store.claim({
        issueKey,
        playbook: "triage",
        startedBy: "issue-playbook-draft:t",
        orTriage: true,
        messageId: "message-t",
        startedWith: "answer",
      }),
    );
    // Fork-only (jehhynes/t3code#102): a draft records the playbook it took.
    assert.deepStrictEqual(
      yield* sql`SELECT playbook FROM issue_playbook_starts WHERE message_id = 'message-t'`,
      [{ playbook: "answer" }],
    );
    assert.isFalse(yield* store.resetTriage(reset));

    // Fork-only (jehhynes/t3code#100): a choice with nothing new waits for Start, its try used; a
    // reset of the choice classifies it again, untried and without the hold.
    yield* store.reconcile(() => [waiting]);
    const since = "2026-11-10T08:00:00.000Z";
    assert.isTrue(yield* store.setTriage({ ...outcome, chosen: "fix", nothingNewSince: since }));
    assert.deepInclude((yield* store.list).get(issueKey), {
      playbook: "fix",
      autoTried: true,
      nothingNewSince: since,
    });
    assert.isFalse(
      yield* store.claim({
        issueKey,
        playbook: "fix",
        startedBy: "issue-playbook:auto",
        messageId: "message-auto",
        auto: true,
        selfStarting: true,
      }),
    );
    assert.isTrue(yield* store.resetTriage(reset));
    assert.deepInclude((yield* store.list).get(issueKey), {
      autoTried: false,
      nothingNewSince: null,
    });
    // Something new: chosen without the hold, its try untouched.
    assert.isTrue(yield* store.setTriage({ ...outcome, chosen: "fix" }));
    assert.deepInclude((yield* store.list).get(issueKey), {
      autoTried: false,
      nothingNewSince: null,
    });
  }).pipe(
    Effect.provide(
      IssuePlaybookEntries.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
