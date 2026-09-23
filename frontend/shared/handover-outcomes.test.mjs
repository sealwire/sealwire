// A handover is answered "on its way" before it is delivered, so the interesting
// failures all arrive later, on the snapshot. These are the rules that decide whether
// the person ever sees one.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createHandoverOutcomeReporter,
  handoverFailureText,
} from "./handover-outcomes.js";

function harness() {
  const reported = [];
  const acked = [];
  const sync = createHandoverOutcomeReporter({
    report: (threadId, message) => reported.push([threadId, message]),
    acknowledge: (id) => acked.push(id),
  });
  return { sync, reported, acked };
}

const FAILED = {
  id: "handover-1",
  source_thread_id: "thread-a",
  target_thread_id: "thread-b",
  target_started: true,
  status: "failed",
  error: "that agent is busy right now. The session started for this is thread-b",
};

test("a failure is reported against the thread it was typed into", () => {
  // Not the thread on screen. Handing over is precisely the act of moving on, so by
  // the time this lands the person is very likely somewhere else — and writing it
  // against the visible composer would put one session's failure under another's draft.
  const { sync, reported } = harness();

  sync([FAILED]);

  assert.equal(reported.length, 1);
  assert.equal(reported[0][0], "thread-a");
  assert.match(reported[0][1], /busy right now/);
  assert.match(reported[0][1], /thread-b/, "the relay's reason names what was left behind");
});

test("each failure is said once, however many snapshots carry it", () => {
  // Snapshots arrive many times a second, and the composer clears its error line on
  // every new command attempt — so re-reporting would put the old failure straight back
  // underneath a draft that has since been fixed.
  const { sync, reported, acked } = harness();

  assert.deepEqual(sync([FAILED]), ["handover-1"]);
  assert.deepEqual(sync([FAILED]), []);
  sync([FAILED]);

  assert.equal(reported.length, 1);
  assert.deepEqual(acked, ["handover-1"], "and the relay is told, so a reload agrees");
});

test("an accepted handover still running is not a failure to report", () => {
  const { sync, reported, acked } = harness();

  sync([{ ...FAILED, status: "working", error: null }]);

  assert.deepEqual(reported, [], "the person was already told it was under way");
  assert.deepEqual(acked, []);
});

test("nothing on the wire reports nothing, including from an older relay", () => {
  const { sync, reported } = harness();

  sync();
  sync([]);
  sync([null, { status: "failed" }]);

  assert.deepEqual(reported, [], "a record with no id cannot be acknowledged or deduped");
});

test("several failures are each reported, and each acknowledged", () => {
  const { sync, reported, acked } = harness();

  sync([
    FAILED,
    { ...FAILED, id: "handover-2", source_thread_id: "thread-c", error: "there is no such agent" },
  ]);

  assert.deepEqual(
    reported.map(([threadId]) => threadId),
    ["thread-a", "thread-c"]
  );
  assert.deepEqual(acked, ["handover-1", "handover-2"]);
});

// A refusal with no reason is worse than a wrong one: it is indistinguishable from the
// command never having been sent, which is the whole defect this channel exists to close.
test("a failure the relay could not explain still says something", () => {
  assert.match(handoverFailureText({ status: "failed" }), /did not finish/);
  assert.ok(handoverFailureText({ status: "failed", error: "   " }).trim());
});

// The reporter and the composer's own per-thread store, composed — because "attach it to
// the right thread" is only half the guarantee. The other half is that the surface then
// shows it on that thread and NOT on whichever one the person moved to.
test("switching sessions while a handover is pending leaves the failure on its own thread", async () => {
  const { recordComposerError, syncComposerError, resetComposerErrorsForTest } = await import(
    "../local/composer-error.js"
  );
  resetComposerErrorsForTest();

  const sync = createHandoverOutcomeReporter({
    report: (threadId, message) => recordComposerError({ threadId, message }),
  });
  sync([FAILED]);

  const line = { textContent: "", hidden: false };
  // The person handed the work over and moved on — which is the entire point of the
  // command, so it is the ordinary case, not the edge one.
  assert.equal(syncComposerError(line, "thread-z"), "");
  assert.equal(line.hidden, true, "another session's composer says nothing");

  assert.match(syncComposerError(line, "thread-a"), /busy right now/);
  assert.equal(line.hidden, false, "and coming back to it is where the failure is waiting");

  resetComposerErrorsForTest();
});
