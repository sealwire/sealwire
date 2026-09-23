// A handover is answered "on its way" before it is delivered, so the interesting
// failures all arrive later, over the per-device reviews channel. These are the rules
// that decide whether the person ever actually sees one.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createHandoverOutcomeReporter,
  handoverFailureText,
} from "./handover-outcomes.js";

function harness() {
  const reported = [];
  const acked = [];
  const reporter = createHandoverOutcomeReporter({
    report: (threadId, message) => reported.push([threadId, message]),
    acknowledge: (id) => acked.push(id),
  });
  return { ...reporter, reported, acked };
}

const failure = (id, source, error, updated_at = 1) => ({
  id,
  source_thread_id: source,
  target_thread_id: `${id}-target`,
  target_started: true,
  status: "failed",
  error,
  updated_at,
});

const BUSY = failure("handover-1", "thread-a", "that agent is busy right now");

test("a failure is reported against the thread it was typed into", () => {
  // Not the thread on screen. Handing over is precisely the act of moving on, so by
  // the time this lands the person is very likely somewhere else — and writing it
  // against the visible composer would put one session's failure under another's draft.
  const h = harness();

  h.sync([BUSY], { viewedThreadId: "thread-z" });

  assert.equal(h.reported.length, 1);
  assert.equal(h.reported[0][0], "thread-a");
  assert.match(h.reported[0][1], /busy right now/);
});

// The bug this rule exists for: it used to acknowledge as soon as it had written into an
// in-memory per-thread map. If the person had moved on — the ordinary handover case —
// and then reloaded, the server had already forgotten an outcome nobody had read.
test("a failure is not acknowledged until its own thread's composer is the one on screen", () => {
  const h = harness();

  h.sync([BUSY], { viewedThreadId: "thread-z" });
  assert.deepEqual(h.acked, [], "written is not shown");

  // Still nowhere near it.
  h.sync([BUSY], { viewedThreadId: null });
  assert.deepEqual(h.acked, []);

  // …and now they navigate back to it.
  h.sync([BUSY], { viewedThreadId: "thread-a" });
  assert.deepEqual(h.acked, ["handover-1"]);
});

test("looking at the thread when the failure lands acknowledges it there and then", () => {
  const h = harness();
  h.sync([BUSY], { viewedThreadId: "thread-a" });
  assert.deepEqual(h.acked, ["handover-1"]);
});

test("a deliberate retry supersedes what the last attempt left", () => {
  // Otherwise the relay holds an outcome that is no longer the current word and offers
  // it again on the next reload, underneath a draft that has since been fixed.
  const h = harness();
  h.sync([BUSY], { viewedThreadId: "thread-z" });

  assert.deepEqual(h.confirmShown("thread-a"), ["handover-1"]);
  assert.deepEqual(h.acked, ["handover-1"]);
  assert.deepEqual(h.confirmShown("thread-a"), [], "and it is consumed exactly once");
});

// Independently reproduced in review: `handovers_view` is newest-first and the reporter
// looped writing one per thread, so the newest was written and then OVERWRITTEN by the
// oldest — and both were acknowledged. The failure that mattered most was the one that
// could never be seen.
test("every failure on one thread is shown together, and none is consumed unseen", () => {
  const h = harness();
  const newest = failure("handover-new", "thread-a", "that agent was used meanwhile", 9);
  const oldest = failure("handover-old", "thread-a", "that agent is busy right now", 1);

  h.sync([newest, oldest], { viewedThreadId: "thread-a" });

  assert.equal(h.reported.length, 1, "one line for the thread, not one per failure");
  const [threadId, message] = h.reported[0];
  assert.equal(threadId, "thread-a");
  assert.match(message, /^2 handovers did not finish/);
  assert.match(message, /used meanwhile/, "the newest reason must survive");
  assert.match(message, /busy right now/, "and so must the one under it");
  assert.deepEqual(
    h.acked.slice().sort(),
    ["handover-new", "handover-old"],
    "both were shown, so both may be forgotten"
  );
});

test("a reason that would not fit is counted rather than silently dropped", () => {
  const many = Array.from({ length: 5 }, (_, index) =>
    failure(`handover-${index}`, "thread-a", `reason ${index}`, index)
  );
  const message = handoverFailureText(many);
  assert.match(message, /^5 handovers did not finish/);
  assert.match(message, /…and 2 more\./, "the count is the promise that none was lost");
});

test("failures on different threads each get their own line", () => {
  const h = harness();

  h.sync([BUSY, failure("handover-2", "thread-c", "there is no such agent")], {
    viewedThreadId: "thread-c",
  });

  assert.deepEqual(
    h.reported.map(([threadId]) => threadId).sort(),
    ["thread-a", "thread-c"]
  );
  assert.deepEqual(h.acked, ["handover-2"], "only the one that was actually on screen");
});

test("an unchanged feed does not rewrite the line under a draft being fixed", () => {
  const h = harness();

  h.sync([BUSY], { viewedThreadId: "thread-z" });
  h.sync([BUSY], { viewedThreadId: "thread-z" });
  h.sync([BUSY], { viewedThreadId: "thread-z" });

  assert.equal(h.reported.length, 1);
});

test("a second failure on the same thread reopens the line with both on it", () => {
  const h = harness();
  const first = failure("handover-1", "thread-a", "that agent is busy right now", 1);
  const second = failure("handover-2", "thread-a", "there is no such agent", 2);

  h.sync([first], { viewedThreadId: "thread-z" });
  h.sync([second, first], { viewedThreadId: "thread-z" });

  assert.equal(h.reported.length, 2);
  assert.match(h.reported.at(-1)[1], /no such agent/);
  assert.match(h.reported.at(-1)[1], /busy right now/);
  assert.deepEqual(h.acked, [], "still nobody has looked at that thread");
});

test("an accepted handover still running is not a failure to report", () => {
  const h = harness();

  h.sync([{ ...BUSY, status: "working", error: null }], { viewedThreadId: "thread-a" });

  assert.deepEqual(h.reported, [], "the person was already told it was under way");
  assert.deepEqual(h.acked, []);
});

test("nothing on the feed reports nothing, including from an older relay", () => {
  const h = harness();

  h.sync();
  h.sync([]);
  h.sync([null, { status: "failed" }], { viewedThreadId: "thread-a" });

  assert.deepEqual(h.reported, [], "a record with no id cannot be acknowledged or deduped");
});

// A refusal with no reason is worse than a wrong one: it is indistinguishable from the
// command never having been sent, which is the whole defect this channel exists to close.
test("a failure the relay could not explain still says something", () => {
  assert.match(handoverFailureText([{ status: "failed" }]), /did not finish/);
  assert.ok(handoverFailureText([{ status: "failed", error: "   " }]).trim());
  assert.equal(handoverFailureText([]), "");
});

// The reporter and the composer's own per-thread store, composed — because "attach it to
// the right thread" is only half the guarantee. The other half is that the surface then
// shows it on that thread and NOT on whichever one the person moved to.
test("switching sessions while a handover is pending leaves the failure on its own thread", async () => {
  const { recordComposerError, syncComposerError, resetComposerErrorsForTest } = await import(
    "../local/composer-error.js"
  );
  resetComposerErrorsForTest();

  const reporter = createHandoverOutcomeReporter({
    report: (threadId, message) => recordComposerError({ threadId, message }),
  });
  reporter.sync([BUSY], { viewedThreadId: "thread-z" });

  const line = { textContent: "", hidden: false };
  // The person handed the work over and moved on — which is the entire point of the
  // command, so it is the ordinary case, not the edge one.
  assert.equal(syncComposerError(line, "thread-z"), "");
  assert.equal(line.hidden, true, "another session's composer says nothing");

  assert.match(syncComposerError(line, "thread-a"), /busy right now/);
  assert.equal(line.hidden, false, "and coming back to it is where the failure is waiting");

  resetComposerErrorsForTest();
});
