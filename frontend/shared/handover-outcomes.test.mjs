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

test("every reason is on the line — none is reduced to a count", () => {
  // Paging was the wrong answer to a long line. Acknowledging the first few changes the
  // revision, the automatic refetch renders the next few over the top, and the earlier
  // ones flash past on ONE continuous view — so the promise of a second visit was a
  // promise this code never kept. Nothing here is user-driven, so nothing here may
  // assume the person will come back.
  const many = Array.from({ length: 5 }, (_, index) =>
    failure(`handover-${index}`, "thread-a", `reason number ${index}`, index)
  );
  const message = handoverFailureText(many);
  assert.match(message, /^5 handovers did not finish/);
  for (let index = 0; index < 5; index += 1) {
    assert.ok(message.includes(`reason number ${index}`), `reason ${index} is missing`);
  }
  assert.doesNotMatch(message, /more will follow|and \d+ more/);
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

// The whole chain in one place, because every join in it has silently dropped the
// payload at least once: the relay serves the outcome on ReviewsResponse, the reviews
// cache is what both surfaces actually read, and the reporter is what turns it into a
// line. Each part had a passing test while the two between them lost the data.
test("an outcome served on ReviewsResponse survives the cache and reaches the composer", async () => {
  const { createReviewsCache } = await import("./reviews-cache.js");
  const cache = createReviewsCache();
  const reported = [];
  const acked = [];
  const reporter = createHandoverOutcomeReporter({
    report: (threadId, message) => reported.push([threadId, message]),
    acknowledge: (id) => acked.push(id),
  });

  // Exactly the shape the relay's `reviews_response` builds for this actor.
  await cache.sync(
    3,
    async () => ({
      reviews_revision: 3,
      review_jobs: [],
      reviewer_threads: [],
      asks: [],
      goals: [],
      handovers: [BUSY],
    }),
    () => {}
  );

  // The person is still on the session they handed the work to, not the one they left.
  reporter.sync(cache.current().handovers, { viewedThreadId: "thread-b" });
  assert.deepEqual(
    reported.map(([threadId]) => threadId),
    ["thread-a"],
    "the failure got all the way from the channel to the source thread's composer"
  );
  assert.match(reported[0][1], /busy right now/);
  assert.deepEqual(acked, [], "and is still the relay's until they look at it");

  reporter.sync(cache.current().handovers, { viewedThreadId: "thread-a" });
  assert.deepEqual(acked, ["handover-1"]);
});

// Counting a reason is not showing it. There is no panel and no detail route for a
// handover outcome — the composer line is the whole of it — so an id represented only by
// "…and 2 more" and then acknowledged is a failure consumed unseen, which is the exact
// invariant this lifecycle exists to hold.
test("nothing is acknowledged whose reason was not on the line", () => {
  // The invariant, stated as a property rather than as a count: whatever was consumed,
  // the person read the reason for it. There is no panel and no detail route, so an id
  // acknowledged without its reason on screen is one nobody can ever find out about.
  const h = harness();
  const group = [1, 2, 3, 4, 5].map((n) =>
    failure(`handover-${n}`, "thread-a", `reason number ${n}`, 10 - n)
  );

  h.sync(group, { viewedThreadId: "thread-a" });

  assert.equal(h.reported.length, 1, "one stable line, not a sequence of them");
  const line = h.reported[0][1];
  for (const id of h.acked) {
    const spoken = group.find((entry) => entry.id === id);
    assert.ok(
      line.includes(spoken.error),
      `${id} was acknowledged but its reason (${spoken.error}) was never on the line`
    );
  }
  assert.deepEqual(
    h.acked.slice().sort(),
    group.map((entry) => entry.id).sort(),
    "and all five were on it, so all five are consumed in one go"
  );
});

// The effect a paging design actually had, spelled out through the real cache and the
// real revision key: acking the first few moves the revision, the refetch lands, and a
// second line replaces the first while the person is still reading it. The line must be
// written ONCE and then stay put.
test("five failures land as one stable line no automatic follow-up overwrites", async () => {
  const { createReviewsCache } = await import("./reviews-cache.js");
  const cache = createReviewsCache();
  const h = harness();
  const group = [1, 2, 3, 4, 5].map((n) =>
    failure(`handover-${n}`, "thread-a", `reason number ${n}`, 10 - n)
  );

  const served = () => group.filter((entry) => !h.acked.includes(entry.id));
  const fetchReviews = async () => ({
    reviews_revision: 40 + h.acked.length,
    review_jobs: [],
    reviewer_threads: [],
    asks: [],
    goals: [],
    handovers: served(),
  });

  // The person is on the source thread and stays there, which is precisely the case
  // paging could not survive.
  await cache.sync(40, fetchReviews, () => {});
  h.sync(cache.current().handovers, { viewedThreadId: "thread-a" });

  // Whatever the ack changed, the surface refetches and syncs again — many times, as it
  // does on every render.
  for (const revision of [41, 42, 43, 44, 45]) {
    await cache.sync(revision, fetchReviews, () => {});
    h.sync(cache.current().handovers, { viewedThreadId: "thread-a" });
  }

  assert.equal(
    h.reported.length,
    1,
    `the line was rewritten ${h.reported.length} times; earlier reasons flashed past`
  );
  const line = h.reported[0][1];
  for (let n = 1; n <= 5; n += 1) {
    assert.ok(line.includes(`reason number ${n}`), `reason ${n} never reached the person`);
  }
  assert.equal(h.acked.length, 5, "and all five are settled, none left stranded");
  assert.deepEqual(served(), [], "the relay is holding nothing back");
});
