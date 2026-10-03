// Perf regression, shaped like transcript-hydration-perf.test.mjs: the delta
// path used to derive the rendered transcript array from the hydration
// window (order.map(...).filter(Boolean), O(n) in the loaded window) once
// PER TOKEN. That projection is now deferred to settleTranscriptProjection,
// so it runs once per flush regardless of how many tokens streamed in between
// or how large the loaded window is. Counters, not wall time.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamController,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "./stream.js";
import { settleTranscriptProjection } from "../transcript/store.js";

const THREAD = "thread-1";
const BODY = "x".repeat(120);

function entry(i) {
  return {
    item_id: `item-${i}`,
    kind: "agent_text",
    text: `msg ${i} ${BODY}`,
    status: i === 0 ? "running" : "completed",
    turn_id: `turn-${i}`,
    tool: null,
    content_state: "full",
  };
}

// A large, fully-loaded hydration window — what a long, scrolled-up session
// looks like. item-0 is the streaming entry deltas append to.
function buildHarness(n) {
  const ids = Array.from({ length: n }, (_, i) => `item-${i}`);
  const state = {
    session: {
      active_thread_id: THREAD,
      transcript: ids.map((_, i) => entry(i)),
      transcript_revision: 0,
    },
    transcriptHydrationThreadId: THREAD,
    transcriptHydrationEntries: new Map(ids.map((id, i) => [id, entry(i)])),
    transcriptHydrationOrder: [...ids],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: null,
    viewOnlyThread: null,
  };
  const controller = createStreamController({
    state,
    ensureConversationTranscript: () => {},
    logLine: () => {},
    seedDefaults: () => {},
    renderSession: () => {},

    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    // This test drives flushes explicitly via projectTranscriptWindowIfPending()
    // rather than through real scheduling, so nothing here must render on its
    // own — queue()/note()/flushNow() are no-ops.
    transcriptFlushScheduler: {
      queue() {},
      note() {},
      flushNow() {},
      cancel() {},
      stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
    },
  });
  return { controller, state };
}

function streamToken(controller, tick) {
  controller.applyLocalTranscriptEntryDelta({
    thread_id: THREAD,
    item_id: "item-0",
    delta_kind: "agent_text",
    turn_id: "turn-0",
    delta: ` tok${tick}`,
  });
}

// Mirrors session-controller.js's ctx.renderSession wrapper: a "flush" here
// is settling any pending window projection directly into state.session.
function flush(_controller, state) {
  settleTranscriptProjection(state);
}

test("the delta path never rebuilds before a flush, and rebuilds exactly once per flush, independent of window size", () => {
  const TOKENS_PER_FLUSH = 25;
  const FLUSHES = 5;

  for (const n of [1000, 20000]) {
    __resetTranscriptFullRebuildCount();
    const { controller, state } = buildHarness(n);

    for (let f = 0; f < FLUSHES; f += 1) {
      for (let t = 0; t < TOKENS_PER_FLUSH; t += 1) {
        streamToken(controller, f * TOKENS_PER_FLUSH + t);
      }
      assert.equal(
        __readTranscriptFullRebuildCount(),
        f,
        `n=${n}: ${TOKENS_PER_FLUSH} deltas must not rebuild the transcript before their flush`
      );

      flush(controller, state);

      assert.equal(
        __readTranscriptFullRebuildCount(),
        f + 1,
        `n=${n}: exactly one rebuild per flush, regardless of loaded window size`
      );
    }

    // Sanity: the deferred projection actually caught up, in order — not just
    // a counter moving in isolation.
    const streamed = state.session.transcript.find((candidate) => candidate.item_id === "item-0");
    const expectedTail = Array.from({ length: TOKENS_PER_FLUSH * FLUSHES }, (_, i) => ` tok${i}`).join("");
    assert.equal(streamed.text, `${entry(0).text}${expectedTail}`);
  }
});

test("a flush with nothing pending does not rebuild", () => {
  __resetTranscriptFullRebuildCount();
  const { controller, state } = buildHarness(1000);

  flush(controller, state);

  assert.equal(
    __readTranscriptFullRebuildCount(),
    0,
    "a flush the delta path never armed must not touch the window projection"
  );
});

// P1: applyLocalTranscriptEntryPatch used to settle the pending window
// projection before checking whether the patch even applies to the active
// thread. Background threads are watched, so an off-thread patch arriving
// between an active-thread delta and its flush is routine, not exceptional —
// paying for an O(n) settle just to discard the patch defeats the point of
// deferring the projection to the flush.
test("an off-thread patch arriving before the flush does not force the deferred projection early", () => {
  __resetTranscriptFullRebuildCount();
  const { controller, state } = buildHarness(20000);

  streamToken(controller, 0);
  assert.equal(
    __readTranscriptFullRebuildCount(),
    0,
    "the active-thread delta itself must not rebuild anything"
  );

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "item-5", thread_id: "some-other-thread", status: "completed", text: "done" },
    { defaultStatus: "completed" }
  );

  assert.equal(
    __readTranscriptFullRebuildCount(),
    0,
    "an off-thread patch is dropped before ever touching state.session.transcript — it must not settle the pending projection early"
  );

  flush(controller, state);

  assert.equal(
    __readTranscriptFullRebuildCount(),
    1,
    "the flush itself must still settle exactly once"
  );
});

// REVIEW P2: the window projection is not the only full-array rebuild site —
// the pre-hydration fallback (no hydration window loaded yet) copies the
// whole state.session.transcript synchronously per delta. It stays
// synchronous on purpose (bounded by max_transcript_entries: 8), but it must
// still be counted: the requirement is visibility into every full-rebuild
// site, not just the deferred one.
test("the pre-hydration fallback (no window loaded yet) also counts its full-array rebuild", () => {
  __resetTranscriptFullRebuildCount();
  const state = {
    session: {
      active_thread_id: THREAD,
      transcript: [entry(0)],
      transcript_revision: 0,
    },
    // Deliberately no transcriptHydrationThreadId/Entries/Order: the window
    // is not loaded, so this exercises the OTHER full-rebuild site.
  };
  const controller = createStreamController({
    state,
    ensureConversationTranscript: () => {},
    logLine: () => {},
    seedDefaults: () => {},
    renderSession: () => {},

    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    transcriptFlushScheduler: {
      queue() {},
      note() {},
      flushNow() {},
      cancel() {},
      stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
    },
  });

  streamToken(controller, 0);

  assert.equal(
    __readTranscriptFullRebuildCount(),
    1,
    "the pre-hydration fallback rebuilds synchronously per delta and must be counted too"
  );
  assert.equal(state.session.transcript[0].text, `${entry(0).text} tok0`);
});
