import assert from "node:assert/strict";
import test from "node:test";

import {
  createStreamController,
  __readTranscriptFullRebuildCount,
  __resetTranscriptFullRebuildCount,
} from "./session/stream.js";
import { adoptSettledTranscript, settleTranscriptProjection, transcriptWindowIsLoaded } from "./transcript/store.js";
import { hydrateLocalTranscript, loadOlderLocalTranscript } from "./transcript/hydration.js";
import {
  cancelAndSettlePendingTranscriptFlush,
  resolveDirectRenderSession,
} from "./session/render-session-flush.js";
import {
  createTranscriptFlushScheduler,
  TRANSCRIPT_FLUSH_CHAR_THRESHOLD,
  TRANSCRIPT_FLUSH_MAX_WINDOW_MS,
  TRANSCRIPT_FLUSH_MIN_WINDOW_MS,
} from "../shared/transcript-flush-scheduler.js";
import { createRelayQueryClient } from "../shared/query-client.js";
import {
  createThreadTranscriptPageQueryOptions,
  fetchThreadTranscriptPageFresh,
  threadTranscriptPageQueryKey,
} from "../shared/thread-queries.js";

/**
 * A minimal fake clock: `tick` advances time and fires due timers (in due
 * order). Mirrors the harness in shared/transcript-flush-scheduler.test.mjs.
 */
function createManualClock(startTime = 0) {
  let currentTime = startTime;
  const timers = new Map();
  let nextId = 0;
  return {
    now: () => currentTime,
    setTimer(callback, delayMs) {
      const id = ++nextId;
      timers.set(id, { callback, dueAt: currentTime + delayMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick(ms) {
      currentTime += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= currentTime)
          .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
        if (!due) {
          break;
        }
        const [id, timer] = due;
        timers.delete(id);
        timer.callback();
      }
    },
    pendingTimerCount: () => timers.size,
  };
}

// A manually-resolved promise, for driving two independent in-flight fetches
// to completion in a chosen order — no fake timer can express "the network
// call itself finishes now", only when queued callbacks run.
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeController({ ensureConversationTranscript, fetchFreshTranscriptPage, isViewingConversation } = {}) {
  const renders = [];
  const clock = createManualClock();
  const state = {
    session: {
      active_thread_id: "thread-1",
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "",
          tool: null,
          turn_id: "turn-1",
        },
      ],
      transcript_revision: 0,
    },
  };
  function baseRenderSession(session) {
    renders.push(session);
  }
  // Late-bound: the scheduler and the wrapper below are constructed before
  // the controller they flush through exists (same seam as
  // session-controller.js's real wiring).
  let controller;
  // Mirrors session-controller.js's ctx.renderSession: the ONE choke point
  // every render — the scheduler's own flush AND stream.js's own direct
  // render calls (session_meta_updated, approvals, the stream-disconnect
  // notice) alike — goes through, which is what makes
  // settleTranscriptProjection() reliable no matter which path triggered the
  // render.
  function renderSessionAndClearPendingFlush(session) {
    const settled = cancelAndSettlePendingTranscriptFlush(transcriptFlushScheduler, state);
    return baseRenderSession(adoptSettledTranscript(state, session, settled));
  }
  const transcriptFlushScheduler = createTranscriptFlushScheduler({
    render: () => {
      if (state.session) {
        renderSessionAndClearPendingFlush(state.session);
      }
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isHidden: () => false,
  });
  controller = createStreamController({
    applySessionSnapshot() {},
    cancelSessionPoll() {},
    cancelStreamReconnect() {},
    ensureConversationTranscript,
    fetchFreshTranscriptPage,
    // repairActiveTranscriptTail no longer reads this (P1 review — it used
    // to gate the repair on it, wrongly). Passed through only so a
    // dedicated regression test can supply `() => false` and prove the
    // repair fires anyway; every other test's default here is inert.
    isViewingConversation: isViewingConversation || (() => true),
    handleUnauthorized() {},
    logLine() {},
    renderSession: renderSessionAndClearPendingFlush,
    scheduleSessionPoll() {},
    scheduleStreamReconnect() {},
    seedDefaults() {},
    state,
    transcriptFlushScheduler,
  });

  // The SAME function session-controller.js's exposed cancelPendingTranscriptFlush
  // calls — app.js's `renderer.renderSession` wrap (frontend/app.js:1191) calls
  // that BEFORE painting `state.session` directly, bypassing
  // renderSessionAndClearPendingFlush/ctx.renderSession entirely. Must settle
  // as well as cancel, or that direct paint sees the stale pre-projection array.
  function cancelPendingTranscriptFlush() {
    return cancelAndSettlePendingTranscriptFlush(transcriptFlushScheduler, state);
  }

  // Mirrors render-session.js's OWN renderSession after the P1 fix: it calls
  // cancelPendingTranscriptFlush itself, so callbacks defined in the SAME
  // closure that invoke it directly — never through renderSessionAndClearPendingFlush,
  // never through app.js's wrap — still cancel a pending flush instead of
  // leaving it to double-render later.
  function renderSessionBase(session) {
    const settled = cancelPendingTranscriptFlush();
    return baseRenderSession(adoptSettledTranscript(state, session, settled));
  }

  return {
    clock,
    controller,
    renders,
    state,
    transcriptFlushScheduler,
    cancelPendingTranscriptFlush,
    renderSessionBase,
  };
}

test("live transcript deltas update state immediately but render once per window", () => {
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " three",
    item_id: "agent-1",
    revision: 3,
    thread_id: "thread-1",
  });

  assert.equal(state.session.transcript[0].text, "one two three");
  assert.equal(state.session.transcript_revision, 3);
  assert.equal(renders.length, 0);
  assert.equal(transcriptFlushScheduler.stats().pending, true);

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(renders.length, 1);
  assert.equal(renders[0].transcript[0].text, "one two three");
});

test("a later window schedules another render without losing prior text", () => {
  const { clock, controller, renders, state } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "first",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  controller.applyLocalTranscriptEntryDelta({
    delta: " second",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });

  assert.equal(clock.pendingTimerCount(), 1);
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renders.length, 2);
  assert.equal(state.session.transcript[0].text, "first second");
});

test("a large-chunk delta flushes early via note(), without waiting out the window", () => {
  const { clock, controller, renders } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "x".repeat(TRANSCRIPT_FLUSH_CHAR_THRESHOLD),
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });

  assert.equal(
    renders.length,
    1,
    "a single chunk at the char threshold must render immediately, not coalesce for the full window"
  );

  // The window this flush brought forward must not also fire on its own.
  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1);
});

test("transcript_stream_lagged brings a pending render forward instead of leaving it to coalesce", () => {
  const { clock, controller, renders, transcriptFlushScheduler } = makeController();

  controller.applyLocalTranscriptEntryDelta({
    delta: "partial",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");

  controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 3 });

  assert.equal(
    renders.length,
    1,
    "a lagged-stream notice must flush immediately, per the scheduler's immediate-event contract"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the delta's window timer must be absorbed by the immediate flush, not left to fire again"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time");
});

// P1: the test above never loads a hydration window, so the delta it applies
// lands directly in state.session.transcript and cannot exercise the deferred
// window->array projection at all — see transcript/store.js's "Deferred
// window->array projection" section. This one loads a real window, so the
// delta is pending ONLY there when the lagged notice fires, the same shape as
// remote's scheduleTranscriptGapRepair (session-ops.js:619-630).
test("transcript_stream_lagged settles the pending window delta before invalidating, so the immediate render carries the newest text", () => {
  let fetchCalls = 0;
  const ensureConversationTranscript = () => {
    fetchCalls += 1;
    return Promise.resolve();
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    ensureConversationTranscript,
  });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello";

  controller.applyLocalTranscriptEntryDelta({
    delta: " world",
    item_id: "agent-1",
    revision: 6,
    text_offset: 5,
    thread_id: "thread-1",
  });

  // Preconditions: the delta reached the window (O(1) write) but the O(n)
  // projection back onto the array is deferred — this is the state a naive
  // test (like the one above) can never produce.
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world",
    "precondition: the delta landed in the window"
  );
  assert.equal(
    state.session.transcript[0].text,
    "hello",
    "precondition: the array projection is still pending"
  );
  assert.equal(renders.length, 0, "precondition: the delta is still coalescing");

  controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 3 });

  assert.equal(renders.length, 1, "the lagged notice must flush immediately");
  assert.equal(
    renders[0].transcript[0].text,
    "hello world",
    "the immediate render must carry the newest text — invalidating before the pending delta settles " +
      "makes the projection fall back to the array's stale pre-delta copy instead"
  );
  assert.equal(fetchCalls, 1, "the refetch must still have been requested");
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the coalesced timer must be absorbed by the immediate flush"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time later");
});

// P1 (review): transcript_stream_lagged is not the only local site that
// downgrades a loaded window entry's content_state — applyTranscriptDeltaToWindow
// (shared/transcript-hydration-store.js) does the same thing IN PLACE whenever
// an ordinary per-item delta is refused as a gap or byte mismatch. The fix
// above only covered the bulk lagged-notice path; this covers the equivalent
// per-item path reached through an everyday streaming delta, never through
// transcript_stream_lagged at all — it must get the SAME immediate
// settle -> refetch -> flush tail, not fall through to the coalesced render
// (a coalesced-only assertion reached by ticking the clock cannot tell a
// path that renders immediately apart from one that merely waits out the
// same window — this asserts the immediate render, fetch, and timer
// cancellation BEFORE the clock ever moves).
//
// P1 (review, round 2): an earlier version of this test stubbed
// ensureConversationTranscript itself and only counted that the stub was
// called. ensureConversationTranscript's own gate (prepareTranscriptHydration
// State, shared/transcript-hydration-store.js) fires off
// snapshot.transcript_truncated and the WIRE snapshot's own per-entry
// content_state — both server-computed signals a client-only window
// downgrade never touches — so in real code that call is a silent no-op:
// reproduction showed zero fetchPage calls. Stubbing it hid exactly that.
// This version stubs one level lower, at fetchFreshTranscriptPage (the actual
// dependency repairActiveTranscriptTail calls, bypassing both the broken
// gate AND queryClient's fetchQuery dedupe — see stream.js's doc on that
// function), and asserts the REAL merge landed: the window entry is
// promoted back to `full` with the fetched page's text, and a second render
// actually paints it.
//
// P1 (review): the fetch-initiation assertions used to run AFTER
// clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS), so a repair deferred into the
// coalesced window would still have passed. Initiation is synchronous — the
// call happens before repairActiveTranscriptTail's first await — so it is
// asserted immediately below, with no tick and no microtask flush.
test("a gapped delta for an item with an earlier pending append settles and flushes immediately, then repairs with the authoritative page once it lands", async () => {
  const fetchCalls = [];
  const fetchFreshTranscriptPage = (threadId, { before } = {}) => {
    fetchCalls.push({ threadId, before });
    return Promise.resolve({
      thread_id: "thread-1",
      entries: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "completed",
          text: "hello world, repaired",
          tool: null,
          turn_id: "turn-1",
        },
      ],
      prev_cursor: null,
      revision: 8,
    });
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    fetchFreshTranscriptPage,
  });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello";

  // A valid delta appends " world" — lands only in the window (deferred
  // projection); the array still reads "hello" until something settles it.
  controller.applyLocalTranscriptEntryDelta({
    delta: " world",
    item_id: "agent-1",
    revision: 6,
    text_offset: 5,
    thread_id: "thread-1",
  });
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world",
    "precondition: the valid append landed in the window"
  );
  assert.equal(
    state.session.transcript[0].text,
    "hello",
    "precondition: the array projection is still pending"
  );
  assert.equal(renders.length, 0, "precondition: the delta is still coalescing");

  // A second, GAPPED delta for the SAME item arrives (offset far past the
  // window's current length) — applyTranscriptDeltaToWindow refuses it and
  // downgrades the window entry to preview in place, right there, with no
  // notice like transcript_stream_lagged to hang a fix off of.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  // Fetch initiation is synchronous — repairActiveTranscriptTail calls
  // fetchFreshTranscriptPage before its first await, so this is observable
  // right away with no clock tick and no microtask flush. Asserted BEFORE
  // either, or a repair deferred into the coalesced window would pass this
  // test too.
  assert.equal(fetchCalls.length, 1, "a true refusal must trigger exactly one authoritative-tail fetch");
  assert.equal(fetchCalls[0].threadId, "thread-1");
  assert.equal(fetchCalls[0].before, null, "the repair must fetch the LIVE tail, not an older page");
  assert.equal(
    renders.length,
    1,
    "the refusal must flush immediately, not sit out the coalescing window behind a copy already known stale"
  );
  assert.equal(
    renders[0].transcript[0].text,
    "hello world",
    "the immediate render must carry the earlier valid append — downgrading the window before that append " +
      "settles makes the projection fall back to the array's stale pre-append copy instead"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the coalesced timer armed by the first (valid) delta must be absorbed by the immediate flush"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time later");
  assert.equal(fetchCalls.length, 1, "the coalesced window timer must not trigger a second repair fetch");

  // The repair fetch is fire-and-forget (`void repairActiveTranscriptTail(...)`)
  // — flush the microtask queue so its continuation (the merge + render after
  // `await fetchFreshTranscriptPage(...)` resolves) has actually run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the fetched page must promote the window entry back to full"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the window must hold the AUTHORITATIVE page's text, not the refused local copy"
  );
  assert.equal(
    renders.length,
    2,
    "the landed repair is new information and must paint again, once — this is not the absorbed stale timer"
  );
  assert.equal(
    renders[1].transcript[0].text,
    "hello world, repaired",
    "the second render must carry the repaired, authoritative text"
  );
});

// P1 (review): repairActiveTranscriptTail used to gate its fetch on
// isViewingConversation, silently suppressing the repair whenever the
// active thread's own conversation route wasn't the screen currently on
// screen (e.g. the Tasks screen, or a different session) — the entry stayed
// downgraded to `preview` forever, since nothing else ever retries a
// client-detected gap. Every OTHER test in this file relies on
// makeController's `() => true` default for this gate, which never actually
// exercised it — acceptance criterion 1 ("initiates a new raw/fresh
// live-tail network request immediately") has no route carve-out, so this
// explicitly supplies a FALSE gate and proves the repair fires regardless.
test("a loaded-window refusal repairs even while the active thread is off the conversation route", async () => {
  const fetchCalls = [];
  const fetchFreshTranscriptPage = (threadId, { before } = {}) => {
    fetchCalls.push({ threadId, before });
    return Promise.resolve({
      thread_id: "thread-1",
      entries: [
        { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired", tool: null, turn_id: "turn-1" },
      ],
      prev_cursor: null,
    });
  };
  const { controller, renders, state } = makeController({
    fetchFreshTranscriptPage,
    // The active thread is still the client's live one (the delta below
    // carries its thread_id and state.session.active_thread_id matches) —
    // only the UI's current route is elsewhere. That must not matter here.
    isViewingConversation: () => false,
  });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello world",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello world";

  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  assert.equal(
    fetchCalls.length,
    1,
    "a loaded-window refusal must repair unconditionally — acceptance criterion 1 has no route carve-out"
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the repair must still land while off-route"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the repaired text must still become authoritative while off-route"
  );
  assert.equal(renders.length, 2, "the repair must still paint once it lands");
});

// Sibling to the refusal test above: resolveDeltaAppend returns `""` — not
// `null` — for a pure re-delivery of bytes we already hold. `""` is falsy,
// so a naive `if (!resolveDeltaAppend(...))` refusal check would treat this
// exactly like a gap and refetch on every re-delivered chunk. It must stay
// the ordinary idempotent no-op: no refetch, no immediate render.
//
// P1 (review, round 3): stubbing ensureConversationTranscript only proved
// THAT stub was never called — production stopped calling it for this path
// in ee08b1ed, so the assertion was observing an unused dependency and would
// pass even if a duplicate wrongly triggered a repair. Stubs
// fetchFreshTranscriptPage instead, the dependency repairActiveTranscriptTail
// actually calls now.
test("a duplicate delta for an item already fully held triggers neither a repair fetch nor an immediate render", () => {
  const fetchCalls = [];
  const fetchFreshTranscriptPage = (threadId, { before } = {}) => {
    fetchCalls.push({ threadId, before });
    return Promise.resolve({ thread_id: "thread-1", entries: [], prev_cursor: null });
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    fetchFreshTranscriptPage,
  });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello world",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello world";

  // Re-delivery of bytes already fully covered by what the window holds —
  // resolveDeltaAppend returns "", not null.
  controller.applyLocalTranscriptEntryDelta({
    delta: "hello",
    item_id: "agent-1",
    revision: 7,
    text_offset: 0,
    thread_id: "thread-1",
  });

  assert.equal(fetchCalls.length, 0, "a duplicate must never trigger a repair fetch");
  assert.equal(renders.length, 0, "a duplicate must never flush immediately");
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    true,
    "a duplicate still coalesces like any other non-refusal delta, it just has nothing new to paint"
  );

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renders.length, 1, "the coalesced window still renders once");
});

// P1 (review): the two tests above only cover an item the window ALREADY
// tracks — resolveDeltaAppend, and the isRefusal check built on it, never run
// for an item the window has never seen at all. applyTranscriptDeltaToWindow
// has its OWN refusal for that case: a first delta with a nonzero offset
// means the entry's opening text went missing, so it stores an empty preview
// rather than ever marking the entry `full`. Before this fix that shape fell
// straight through to the ordinary coalesced path with no refetch requested —
// reproducing as fetchCalls: 0, renders: 0, pending: true, the same signature
// the original per-item defect had.
//
// P1 (review, round 2): same correction as the sibling test above — stubbing
// ensureConversationTranscript only proved the stub was called, not that a
// real fetch (or its merge) ever happens; reproduction showed zero
// fetchPage calls for this shape too. Stubs fetchFreshTranscriptPage instead
// (the dependency repairActiveTranscriptTail actually calls) and asserts the
// previously-missing item is actually promoted to `full` with real text once
// the repair lands.
test("a first delta for a new item with a missing head (nonzero offset) flushes immediately, then repairs once the authoritative page lands", async () => {
  const fetchCalls = [];
  const fetchFreshTranscriptPage = (threadId, { before } = {}) => {
    fetchCalls.push({ threadId, before });
    return Promise.resolve({
      thread_id: "thread-1",
      entries: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "completed",
          text: "hello",
          tool: null,
          turn_id: "turn-1",
        },
        {
          item_id: "agent-2",
          kind: "agent_text",
          status: "completed",
          text: "full body the client never saw the head of",
          tool: null,
          turn_id: "turn-2",
        },
      ],
      prev_cursor: null,
      revision: 2,
    });
  };
  const { clock, controller, renders, state, transcriptFlushScheduler } = makeController({
    fetchFreshTranscriptPage,
  });

  // The window is loaded for the thread (it already tracks "agent-1"), but
  // "agent-2" has never been seen by it — this exercises
  // applyTranscriptDeltaToWindow's "unknown item" branch, not the
  // resolveDeltaAppend-guarded "existing item" branch the sibling test does.
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello";

  controller.applyLocalTranscriptEntryDelta({
    delta: "world",
    item_id: "agent-2",
    revision: 1,
    text_offset: 5,
    thread_id: "thread-1",
  });

  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.content_state,
    "preview",
    "precondition: a missing head is recorded as an untrusted preview, never full"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.text,
    "",
    "precondition: the tail must not be stored as if it were the whole body"
  );

  assert.equal(
    renders.length,
    1,
    "a missing-head delta for a brand-new item must flush immediately, not sit out the coalescing window"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "no coalesced timer may be left armed behind the immediate flush"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the absorbed window timer must not render a second time later");

  // Flush the microtask queue so the fire-and-forget repair's continuation
  // (the merge + render after `await fetchFreshTranscriptPage(...)` resolves)
  // has actually run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls.length, 1, "a missing head must trigger exactly one authoritative-tail fetch");
  assert.equal(fetchCalls[0].threadId, "thread-1");
  assert.equal(fetchCalls[0].before, null, "the repair must fetch the LIVE tail, not an older page");
  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.content_state,
    "full",
    "the fetched page must promote the previously-missing-head item to full"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-2")?.text,
    "full body the client never saw the head of",
    "the window must hold the AUTHORITATIVE page's text for the item the stream never delivered a head for"
  );
  assert.equal(
    renders.length,
    2,
    "the landed repair is new information and must paint again, once"
  );
  const repairedEntry = renders[1].transcript.find((entry) => entry.item_id === "agent-2");
  assert.ok(repairedEntry, "the repaired item must actually appear in the rendered transcript");
  assert.equal(
    repairedEntry.text,
    "full body the client never saw the head of",
    "the second render must carry the repaired, authoritative text for the previously-missing item"
  );
});

// P1 (review): the race the repair fetch above must survive. Two writers can
// merge a tail page into the same window: this repair, and a PRE-GAP
// hydration fetch already in flight through the shared hydrateTranscript
// driver (shared/transcript-hydration.js) — e.g. a re-hydration armed before
// this gap happened, still awaiting its own fetchPage. isStaleTranscriptPage
// used to check only thread id, so nothing discarded that fetch's
// continuation once it landed, in either completion order. Each order below
// drives two independently-controlled deferreds and asserts the FINAL window
// state (text + content_state) — never that a function was called, which is
// what let the original defect through review three times over.
function setUpRaceState(fetchFreshTranscriptPage) {
  const helpers = makeController({ fetchFreshTranscriptPage });
  const { state } = helpers;
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello world",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript[0].text = "hello world";
  return helpers;
}

// Deliberately at least as long as "hello world, repaired" (22 chars): the
// merge keeps the LONGER of two same-rank (full) bodies, so this is what
// would let a stale page overwrite the repair if nothing discarded it — see
// mergeTranscriptEntry (shared/transcript-hydration-store.js).
const STALE_PRE_GAP_TEXT = "hello world STALE PRE-GAP BODY THAT MUST NOT WIN";

test("a stale pre-gap hydration fetch resolving BEFORE the repair must not block or get overwritten by it (old, then repair)", async () => {
  const oldFetch = createDeferred();
  const repairFetch = createDeferred();
  const { controller, state } = setUpRaceState(() => repairFetch.promise);

  // The pre-gap re-hydration fetch, in flight through the REAL shared driver
  // (not a stub) — the same driver production's ensureConversationTranscript
  // uses. Its own fetchPage is a second, independently-controlled deferred.
  void hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      transcript_truncated: true,
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "hello world",
          tool: null,
          turn_id: "turn-1",
          content_state: "full",
        },
      ],
    },
    { fetchPage: () => oldFetch.promise, onProgress() {}, onError() {} }
  );

  // A gapped delta for the SAME item arrives — refused, which downgrades the
  // window entry, bumps the refusal epoch, and fires the repair fetch above.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "preview",
    "precondition: the refusal downgraded the window entry"
  );

  // Old resolves first, with a page a real server could plausibly have
  // returned before the gap.
  oldFetch.resolve({
    thread_id: "thread-1",
    entries: [{ item_id: "agent-1", kind: "agent_text", status: "running", text: STALE_PRE_GAP_TEXT }],
    prev_cursor: null,
    revision: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "preview",
    "the pre-gap page was fetched under an epoch the refusal already invalidated, so it must be discarded"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world",
    "the stale pre-gap page's text must never land in the window"
  );

  // Repair resolves second, with the authoritative post-gap text.
  repairFetch.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired", turn_id: "turn-1" },
    ],
    prev_cursor: null,
    revision: 8,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the repair's authoritative page must land"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the window must hold the repair's text"
  );
});

test("a stale pre-gap hydration fetch resolving AFTER the repair must not overwrite it (repair, then old)", async () => {
  const oldFetch = createDeferred();
  const repairFetch = createDeferred();
  const { controller, state } = setUpRaceState(() => repairFetch.promise);

  void hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      transcript_truncated: true,
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "hello world",
          tool: null,
          turn_id: "turn-1",
          content_state: "full",
        },
      ],
    },
    { fetchPage: () => oldFetch.promise, onProgress() {}, onError() {} }
  );

  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "preview",
    "precondition: the refusal downgraded the window entry"
  );

  // Repair resolves first this time — the authoritative post-gap text lands.
  repairFetch.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired", turn_id: "turn-1" },
    ],
    prev_cursor: null,
    revision: 8,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "precondition: the repair landed before the stale pre-gap fetch resolves"
  );
  assert.equal(state.transcriptHydrationEntries.get("agent-1").text, "hello world, repaired");

  // The dangerous order: the stale pre-gap page resolves AFTER the repair
  // already landed. Both are now `full`, so without the epoch guard the
  // merge's length tie-break (mergeTranscriptEntry) would let the longer,
  // stale body win and get re-marked authoritative — exactly the bug this
  // guard exists to stop.
  oldFetch.resolve({
    thread_id: "thread-1",
    entries: [{ item_id: "agent-1", kind: "agent_text", status: "running", text: STALE_PRE_GAP_TEXT }],
    prev_cursor: null,
    revision: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the repair's content_state must survive the stale page landing late"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the stale pre-gap page must not overwrite the already-repaired, authoritative text"
  );
});

// P1 (review): the epoch-stale discard above (isRefusalEpochStale,
// shared/transcript-hydration.js) used to just `return` without resetting
// transcriptHydrationStatus, reusing the bare shape isStaleTranscriptPage
// uses for a CROSS-thread page. That shape is safe there because a thread
// switch already replaces the whole hydration slot — but this is the SAME
// thread, so nothing else ever clears "loading", and loadOlderTranscript's
// own gate (`state.transcriptHydrationPromise || status === "loading"`)
// would then block scroll-up on this thread forever, even after the
// concurrent repair that invalidated the discarded fetch lands successfully.
test("an epoch-discarded pre-gap hydration fetch releases its status after a failed repair, so hydration can retry", async () => {
  const oldFetch = createDeferred();
  const { controller, state } = setUpRaceState(() =>
    Promise.reject(new Error("simulated fresh repair failure"))
  );

  void hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      transcript_truncated: true,
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "hello world",
          tool: null,
          turn_id: "turn-1",
          content_state: "full",
        },
      ],
    },
    { fetchPage: () => oldFetch.promise, onProgress() {}, onError() {} }
  );

  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  oldFetch.resolve({
    thread_id: "thread-1",
    entries: [{ item_id: "agent-1", kind: "agent_text", status: "running", text: STALE_PRE_GAP_TEXT }],
    prev_cursor: null,
    revision: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.notEqual(
    state.transcriptHydrationStatus,
    "loading",
    "the epoch-discarded fetch must release the loading gate, or every later hydration attempt on this thread is blocked"
  );

  // Prove it concretely, not just via the internal field: after the concurrent
  // fresh repair fails, ordinary hydration must be able to retry the live tail
  // instead of bailing out on a wedged status.
  const retryFetchCalls = [];
  await hydrateLocalTranscript(state, {
    active_thread_id: "thread-1",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "completed",
        text: "hello world",
        tool: null,
        turn_id: "turn-1",
        content_state: "preview",
      },
    ],
  }, {
    fetchPage: ({ threadId, before }) => {
      retryFetchCalls.push({ threadId, before });
      return Promise.resolve({
        thread_id: "thread-1",
        entries: [
          {
            item_id: "agent-1",
            kind: "agent_text",
            status: "completed",
            text: "hello world, repaired by retry",
            tool: null,
            turn_id: "turn-1",
          },
        ],
        prev_cursor: null,
      });
    },
    onProgress() {},
    onError() {},
  });
  assert.equal(
    retryFetchCalls.length,
    1,
    "the retry must actually reach the network, not be gated by a wedged status"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired by retry",
    "the retry must be able to establish authority after the failed fresh repair"
  );
});

test("an epoch-discarded pre-gap hydration fetch does not leave a promise that blocks scroll-up", async () => {
  const oldFetch = createDeferred();
  const repairFetch = createDeferred();
  const { controller, state } = setUpRaceState(() => repairFetch.promise);
  state.transcriptHydrationOlderCursor = "older-cursor-1";

  void hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      transcript_truncated: true,
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "hello world",
          tool: null,
          turn_id: "turn-1",
          content_state: "full",
        },
      ],
    },
    { fetchPage: () => oldFetch.promise, onProgress() {}, onError() {} }
  );

  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  oldFetch.resolve({
    thread_id: "thread-1",
    entries: [{ item_id: "agent-1", kind: "agent_text", status: "running", text: STALE_PRE_GAP_TEXT }],
    prev_cursor: null,
    revision: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const olderFetchCalls = [];
  await loadOlderLocalTranscript(state, {
    fetchPage: ({ threadId, before }) => {
      olderFetchCalls.push({ threadId, before });
      return Promise.resolve({ thread_id: "thread-1", entries: [], prev_cursor: null });
    },
    onProgress() {},
    onError() {},
  });

  assert.deepEqual(
    olderFetchCalls,
    [{ threadId: "thread-1", before: "older-cursor-1" }],
    "the settled pre-gap owner must not leave either gate blocking the scroll-up request"
  );
});

// P1 (review): repairActiveTranscriptTail's own merge never went through the
// shared driver's isRefusalEpochStale gate, so it had no epoch check of its
// own. Two refusals for the same item in quick succession each launch their
// own repair fetch — if the NEWER repair resolves first (landing the
// correct text) and the OLDER repair then resolves late, its merge was
// unconditional and could still overwrite the newer repair's already-
// authoritative text via mergeTranscriptEntry's length tie-break.
test("two successive refusals: an older repair resolving after the newer one must not overwrite it", async () => {
  const repair1 = createDeferred();
  const repair2 = createDeferred();
  const fetchCalls = [];
  const fetchFreshTranscriptPage = (threadId, { before } = {}) => {
    fetchCalls.push({ threadId, before });
    return fetchCalls.length === 1 ? repair1.promise : repair2.promise;
  };
  const { controller, state } = setUpRaceState(fetchFreshTranscriptPage);

  // First refusal — fires repair1.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });
  assert.equal(fetchCalls.length, 1, "precondition: the first refusal fired its own repair fetch");

  // A second refusal arrives while repair1 is still in flight — bumps the
  // epoch again and fires repair2, its own independent fetch.
  controller.applyLocalTranscriptEntryDelta({
    delta: "y",
    item_id: "agent-1",
    revision: 8,
    text_offset: 200,
    thread_id: "thread-1",
  });
  assert.equal(fetchCalls.length, 2, "precondition: the second refusal fired its own repair fetch too");

  // The NEWER repair resolves first, with the authoritative text.
  repair2.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired twice", turn_id: "turn-1" },
    ],
    prev_cursor: null,
    revision: 9,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.transcriptHydrationEntries.get("agent-1").content_state, "full");
  assert.equal(state.transcriptHydrationEntries.get("agent-1").text, "hello world, repaired twice");

  // The OLDER repair resolves late, with a longer but stale response — it
  // predates the newer repair and must not overwrite its already-
  // authoritative text.
  repair1.resolve({
    thread_id: "thread-1",
    entries: [{ item_id: "agent-1", kind: "agent_text", status: "running", text: `${STALE_PRE_GAP_TEXT} EVEN LONGER STILL` }],
    prev_cursor: null,
    revision: 7,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the newer repair's content_state must survive the older repair landing late"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired twice",
    "the older repair's stale response must not overwrite the newer repair's authoritative text"
  );
});

// P1 (review): repairActiveTranscriptTail started a raw repair fetch but
// left the pre-gap query owning its exact cache key — a hydration re-arm
// through fetchTranscriptPage (session/transcript.js:92-106) for the SAME
// key, issued while the repair's own fetch is still in flight, would
// dedupe onto that old, still-in-flight query and inherit its pre-gap
// answer. That answer's captured epoch is taken at the RE-ARM's own start —
// after the bump — so isRefusalEpochStale alone cannot tell it apart from a
// genuinely fresh fetch; only evicting the query-cache entry before the
// repair's own fetch (fetchThreadTranscriptPageFresh,
// shared/thread-queries.js) closes this. Uses a REAL query-core QueryClient
// (createRelayQueryClient), not a stub, since the bug is in the cache's own
// dedup behavior, not anything this file could fake convincingly.
//
// query-core's removeQueries does not just detach the key for FUTURE
// readers — Query.destroy() cancels its retryer outright, rejecting the
// promise every caller (including one from BEFORE the eviction) is holding.
// So the pre-gap request's own promise below is asserted to REJECT, not to
// silently resolve with data nobody reads — and the re-arm, issued only
// AFTER that eviction, is proven to be a genuinely independent fetch rather
// than something that inherited the dead query somehow.
test("a hydration re-arm racing the repair does not dedupe onto the pre-gap request it is superseding (real query client)", async () => {
  const queryClient = createRelayQueryClient();
  const oldFetchPage = createDeferred();
  const repairRawFetch = createDeferred();
  const rearmFetchPage = createDeferred();

  const fetchFreshTranscriptPage = (threadId, { before } = {}) =>
    fetchThreadTranscriptPageFresh({
      before,
      fetchPage: () => repairRawFetch.promise,
      queryClient,
      scope: "local",
      surface: "local",
      threadId,
    });

  const { controller, state } = setUpRaceState(fetchFreshTranscriptPage);

  // The PRE-GAP hydration fetch, already in flight — through the real query
  // client, the exact same key fetchTranscriptPage uses.
  const oldQueryPromise = queryClient.fetchQuery(
    createThreadTranscriptPageQueryOptions({
      before: null,
      fetchPage: () => oldFetchPage.promise,
      scope: "local",
      surface: "local",
      threadId: "thread-1",
    })
  );
  let oldQueryError = null;
  const oldQuerySettled = oldQueryPromise.then(
    () => {
      oldQueryError = null;
    },
    (error) => {
      oldQueryError = error;
    }
  );

  // Gapped delta -> refusal -> repair. fetchFreshTranscriptPage evicts the
  // tail's exact query-cache key synchronously, before its own raw fetch —
  // repairActiveTranscriptTail's first (and only, until the raw fetch)
  // await is inside that call, so this has already happened by the time
  // applyLocalTranscriptEntryDelta returns control here.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  // A LATER hydration re-arm for the SAME key — e.g. ensureConversationTranscript
  // firing again while the repair's own fetch is still in flight. Without
  // eviction, this fetchQuery call would find the OLD query still registered
  // and dedupe onto oldFetchPage's promise instead of starting its own.
  const rearmQueryPromise = queryClient.fetchQuery(
    createThreadTranscriptPageQueryOptions({
      before: null,
      fetchPage: () => rearmFetchPage.promise,
      scope: "local",
      surface: "local",
      threadId: "thread-1",
    })
  );

  await oldQuerySettled;
  assert.ok(
    oldQueryError,
    "the pre-gap request must not resolve successfully once the repair evicts its query-cache entry"
  );
  assert.equal(
    oldQueryError.message,
    "CancelledError",
    "eviction must cancel the pre-gap query outright, not just quietly detach it for future readers"
  );

  // The repair's own fetch resolves with the authoritative post-gap page and
  // lands in the window.
  repairRawFetch.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired", tool: null, turn_id: "turn-1" },
    ],
    prev_cursor: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the repair's fresh page must land"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the repair's fresh text must be authoritative"
  );

  // Resolving the now-cancelled pre-gap fetch's OWN queryFn must be inert —
  // nothing is listening to it as authoritative any more.
  oldFetchPage.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "running", text: "hello world STALE PRE-GAP BODY THAT MUST NOT WIN" },
    ],
    prev_cursor: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").content_state,
    "full",
    "the repair's content_state must survive the stale pre-gap queryFn resolving late"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, repaired",
    "the repair's fresh text must survive the stale pre-gap queryFn resolving late"
  );

  // Prove the re-arm's fetchQuery call genuinely started its own, live
  // fetch — not something silently dropped or hung waiting on the dead
  // query — by resolving ITS OWN underlying fetch and confirming that is
  // what settles it.
  rearmFetchPage.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello world, repaired", tool: null, turn_id: "turn-1" },
    ],
    prev_cursor: null,
  });
  const rearmResult = await rearmQueryPromise;
  assert.equal(
    rearmResult?.entries?.[0]?.text,
    "hello world, repaired",
    "the re-arm must settle from its OWN independent fetch once that resolves, not the evicted one"
  );
});

test("real QueryClient race matrix: the pre-gap query and post-refusal raw repair never dedupe or grant stale authority", async (t) => {
  const orders = [
    { name: "old response, then fresh repair", first: "old" },
    { name: "fresh repair, then old response", first: "fresh" },
  ];

  for (const order of orders) {
    await t.test(order.name, async () => {
      const queryClient = createRelayQueryClient();
      const oldFetch = createDeferred();
      const repairFetch = createDeferred();
      const ordinaryCalls = [];
      const rawRepairCalls = [];
      const queryKey = threadTranscriptPageQueryKey({
        before: null,
        scope: "local",
        surface: "local",
        threadId: "thread-1",
      });

      const fetchFreshTranscriptPage = (threadId, { before } = {}) =>
        fetchThreadTranscriptPageFresh({
          before,
          fetchPage: (request) => {
            rawRepairCalls.push(request);
            return repairFetch.promise;
          },
          queryClient,
          scope: "local",
          surface: "local",
          threadId,
        });
      const { controller, state } = setUpRaceState(fetchFreshTranscriptPage);

      const hydrationPromise = hydrateLocalTranscript(
        state,
        {
          active_thread_id: "thread-1",
          transcript_truncated: true,
          transcript: [
            {
              item_id: "agent-1",
              kind: "agent_text",
              status: "running",
              text: "hello world",
              tool: null,
              turn_id: "turn-1",
              content_state: "full",
            },
          ],
        },
        {
          fetchPage: ({ before, threadId }) =>
            queryClient.fetchQuery(
              createThreadTranscriptPageQueryOptions({
                before,
                fetchPage: (request) => {
                  ordinaryCalls.push(request);
                  return oldFetch.promise;
                },
                scope: "local",
                surface: "local",
                threadId,
              })
            ),
          onProgress() {},
          onError() {},
        }
      );

      assert.equal(ordinaryCalls.length, 1, "precondition: hydration started one ordinary request");
      assert.deepEqual(
        queryClient.getQueryCache().find({ queryKey, exact: true })?.queryKey,
        queryKey,
        "the pre-gap hydration request must own the production tail query key"
      );

      controller.applyLocalTranscriptEntryDelta({
        delta: "z",
        item_id: "agent-1",
        revision: 7,
        text_offset: 100,
        thread_id: "thread-1",
      });

      assert.equal(
        rawRepairCalls.length,
        1,
        "the refusal must synchronously start one independent raw repair request"
      );
      assert.deepEqual(rawRepairCalls[0], { before: null, threadId: "thread-1" });
      assert.equal(
        queryClient.getQueryCache().find({ queryKey, exact: true }),
        undefined,
        "the raw repair must evict the pre-gap owner instead of deduping onto it"
      );
      assert.equal(
        state.transcriptHydrationEntries.get("agent-1").content_state,
        "preview",
        "the refusal must revoke the cached body's authority before either response resolves"
      );

      const oldPage = {
        thread_id: "thread-1",
        entries: [
          {
            item_id: "agent-1",
            kind: "agent_text",
            status: "running",
            text: STALE_PRE_GAP_TEXT,
            turn_id: "turn-1",
          },
        ],
        prev_cursor: null,
        revision: 6,
      };
      const freshPage = {
        thread_id: "thread-1",
        entries: [
          {
            item_id: "agent-1",
            kind: "agent_text",
            status: "completed",
            text: "hello world, repaired",
            turn_id: "turn-1",
          },
        ],
        prev_cursor: null,
        revision: 8,
      };

      if (order.first === "old") {
        oldFetch.resolve(oldPage);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(
          state.transcriptHydrationEntries.get("agent-1").content_state,
          "preview",
          "the old response must never regain authority while the fresh repair is pending"
        );
        assert.equal(
          state.transcriptHydrationEntries.get("agent-1").text,
          "hello world",
          "the old response must not even land transiently"
        );
        repairFetch.resolve(freshPage);
      } else {
        repairFetch.resolve(freshPage);
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(state.transcriptHydrationEntries.get("agent-1").content_state, "full");
        assert.equal(state.transcriptHydrationEntries.get("agent-1").text, "hello world, repaired");
        oldFetch.resolve(oldPage);
      }

      await hydrationPromise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(
        state.transcriptHydrationEntries.get("agent-1").content_state,
        "full",
        "only the post-refusal page may establish authority"
      );
      assert.equal(
        state.transcriptHydrationEntries.get("agent-1").text,
        "hello world, repaired",
        "the old response must be inert in either completion order"
      );
      assert.equal(ordinaryCalls.length, 1, "the ordinary pre-gap request must remain a single request");
      assert.equal(rawRepairCalls.length, 1, "the raw repair must remain a separate single request");
    });
  }
});

// P1 (review): every race test above starts from a LOADED window
// (transcriptWindowIsLoaded === true) — the branch above this one in
// applyLocalTranscriptEntryDelta. Deltas can arrive before the first
// hydration ever runs, and that "no window yet" branch (below the loaded
// branch, reconciling directly against state.session.transcript) had its OWN
// gap/mismatch refusal shape that skipped every protection this cycle added:
// no epoch bump, no repair, no revision advance, no immediate flush. A
// hydration fetch already in flight when the cold gap happens (e.g. armed by
// the very first snapshot) would resolve with pre-gap content, sail past
// isRefusalEpochStale with a never-bumped epoch, and land as `full` —
// exactly the race the epoch guard exists to close, just reached through the
// one call site that never checked it. Drives the REAL hydrateLocalTranscript
// driver, same as the loaded-window race tests, and asserts the final window
// state, not that a function was called.
//
// P1 (review, round 2): this test used to stub the repair's own fetch to
// resolve with an EMPTY page and only prove the stale pre-gap response was
// discarded — accepting "the window stays unloaded with stale visible text"
// as if that were success. repairActiveTranscriptTail's own merge was ALSO
// gated on transcriptWindowIsLoaded, so even after the epoch fix, a cold
// thread's fresh repair response landed and was thrown away right alongside
// the stale one — the gap was never actually repaired. Now proves the
// opposite of a no-op: the repair's fresh page bootstraps the window from
// empty and becomes visible in the rendered transcript.
test("a gap during COLD hydration (no window loaded yet) still bumps the epoch, repairs, and the fresh repair becomes authoritative over the discarded pre-gap response", async () => {
  const preGapFetch = createDeferred();
  const repairFetch = createDeferred();
  const repairFetchCalls = [];
  const fetchFreshTranscriptPage = (threadId, { before } = {}) => {
    repairFetchCalls.push({ threadId, before });
    return repairFetch.promise;
  };
  const { controller, renders, state } = makeController({ fetchFreshTranscriptPage });

  // Genuinely cold: no window loaded for this thread at all (the shape every
  // OTHER test in this file that exercises the window starts from — those all
  // populate transcriptHydrationOrder/Entries first). Mirrors app.js's real
  // boot-time initial state rather than leaving these fields undefined, which
  // never happens in production and would throw inside
  // prepareTranscriptHydrationState (state.transcriptHydrationOrder.length).
  state.transcriptHydrationEntries = new Map();
  state.transcriptHydrationOrder = [];
  state.transcriptHydrationOlderCursor = null;
  state.transcriptHydrationPromise = null;
  state.transcriptHydrationSignature = null;
  state.transcriptHydrationStatus = "idle";
  state.transcriptHydrationTailReady = false;
  state.transcriptHydrationThreadId = null;
  state.session.transcript[0].text = "hello";

  // A hydration fetch already in flight BEFORE the gap — e.g. armed by the
  // very first snapshot (transcript_truncated: true). Its own fetchPage is an
  // independently-controlled deferred, resolved after the gap below.
  void hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      transcript_truncated: true,
      transcript: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "running",
          text: "",
          tool: null,
          turn_id: "turn-1",
          content_state: "preview",
        },
      ],
    },
    { fetchPage: () => preGapFetch.promise, onProgress() {}, onError() {} }
  );
  assert.equal(
    transcriptWindowIsLoaded(state, "thread-1"),
    false,
    "precondition: the window must still be unloaded — arming hydration alone must not load it"
  );

  // A gapped delta for the SAME item arrives before that fetch resolves —
  // offset far past "hello".length, so resolveDeltaAppend refuses it.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  assert.equal(
    state.transcriptRefusalEpoch,
    1,
    "a cold-path gap is a true refusal and must bump the epoch, same as the loaded-window path"
  );
  assert.equal(
    repairFetchCalls.length,
    1,
    "a cold-path gap must still launch the fresh repair"
  );
  assert.equal(repairFetchCalls[0].threadId, "thread-1");
  assert.equal(repairFetchCalls[0].before, null, "the repair must fetch the LIVE tail, not an older page");
  assert.equal(
    state.session.transcript_revision,
    7,
    "the event's revision must still advance even though the window isn't loaded to reconcile the text"
  );
  assert.equal(
    renders.length,
    1,
    "a cold-path refusal must flush immediately too, not sit behind the coalescing window"
  );

  // The pre-gap fetch resolves first, carrying stale content for the same
  // item, defaulting content_state to `full` like any raw page — it must be
  // discarded (its captured epoch predates the bump).
  preGapFetch.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "running", text: "hello STALE PRE-GAP BODY" },
    ],
    prev_cursor: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    state.transcriptHydrationEntries.get("agent-1"),
    undefined,
    "the pre-gap page must never land — its fetch predates the refusal that bumped the epoch, " +
      "so isRefusalEpochStale must discard the merge before it writes anything"
  );
  assert.equal(
    state.transcriptHydrationOrder.length,
    0,
    "a discarded merge must not bootstrap the window from stale content either"
  );

  // The repair's OWN fetch resolves next, with the authoritative post-gap
  // text. Its captured epoch matches current (it was captured AFTER the
  // bump), so it must land — and its merge must not be a no-op just because
  // the window was never loaded before now: bootstrapping an empty window is
  // exactly what the very first hydration attempt for any thread does too.
  repairFetch.resolve({
    thread_id: "thread-1",
    entries: [
      { item_id: "agent-1", kind: "agent_text", status: "completed", text: "hello, repaired", tool: null, turn_id: "turn-1" },
    ],
    prev_cursor: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    transcriptWindowIsLoaded(state, "thread-1"),
    true,
    "the repair must bootstrap the window from empty — a cold thread is exactly the case it also serves"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1")?.content_state,
    "full",
    "the repair's fresh page must become authoritative"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1")?.text,
    "hello, repaired",
    "the window must hold the repair's fresh text"
  );
  assert.equal(
    renders.length,
    2,
    "the landed repair is new information and must paint again, once"
  );
  assert.equal(renders[1].transcript.length, 1, "the repair must not duplicate the item in the rendered array");
  const repairedEntry = renders[1].transcript.find((entry) => entry.item_id === "agent-1");
  assert.ok(repairedEntry, "the repaired item must actually appear in the rendered transcript, not just the window");
  assert.equal(
    repairedEntry.text,
    "hello, repaired",
    "the second render must carry the repaired, authoritative text — final fresh authority, not a no-op"
  );
});

// P1 (review): a terminal entry patch used to end at the same coalescing
// queueTranscriptRender() as an ordinary streaming delta, so a completion /
// failure / error / cancellation sat behind the 100-300ms window instead of
// painting at once — the only signal local gets that a turn just went idle
// for an entry with no dedicated snapshot turn-state change of its own.
test("a completed entry patch flushes immediately instead of coalescing", () => {
  const { clock, controller, renders, transcriptFlushScheduler } = makeController();

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-1", text: "final answer", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  assert.equal(
    renders.length,
    1,
    "a terminal completion must paint at once, not wait out the coalescing window"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "nothing must be left pending to render a second time"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(renders.length, 1, "the immediate flush must not be followed by a second, coalesced one");
});

test("failed/error/cancelled entry patches flush immediately, same as completed", () => {
  for (const status of ["failed", "error", "cancelled"]) {
    const { clock, controller, renders } = makeController();

    controller.applyLocalTranscriptEntryPatch(
      { item_id: "agent-1", status, thread_id: "thread-1" },
      { defaultStatus: null }
    );

    assert.equal(renders.length, 1, `a "${status}" patch must paint at once`);
    clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
    assert.equal(renders.length, 1, `"${status}" must not render a second time later`);
  }
});

test("a running (in-progress) entry patch still coalesces on the scheduler window", () => {
  const { clock, controller, renders } = makeController();

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-1", thread_id: "thread-1" },
    { defaultStatus: "running" }
  );

  assert.equal(renders.length, 0, "a non-terminal patch must still coalesce, not paint immediately");
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);
  assert.equal(renders.length, 1);
});

test("with a loaded hydration window, deltas within one window rebuild the transcript only once, at the flush", () => {
  __resetTranscriptFullRebuildCount();
  const { clock, controller, renders, state } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });

  assert.equal(
    __readTranscriptFullRebuildCount(),
    0,
    "the window-loaded deltas must not rebuild the rendered array before the flush"
  );
  assert.equal(renders.length, 0);

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(
    __readTranscriptFullRebuildCount(),
    1,
    "the flush must derive the rendered array from the window exactly once"
  );
  assert.equal(renders.length, 1);
  assert.equal(renders[0].transcript[0].text, "one two");
});

// REVIEW P1: renderSessionAndClearPendingFlush's own scheduler flush is not
// the only render path. A direct render call — session_meta_updated here,
// but any of the ~30 elsewhere in the app is the same shape — builds its own
// session object by spreading state.session and renders it immediately,
// cancelling the pending scheduled flush along the way. If the projection
// only ran inside the scheduler's own flush, that cancel would throw away
// the ONLY chance to derive the fresh array, and the direct render would
// paint the stale one with the just-streamed token missing.
test("a delta immediately followed by a direct render (session_meta_updated) still paints the fresh window text, not the stale array", () => {
  const { controller, renders, state } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");

  // No scheduled flush ever fires — the direct render below is the only
  // paint this test drives.
  controller.applySessionStreamEvent("session_meta_updated", {
    session: { current_status: "idle" },
  });

  assert.equal(renders.length, 1, "the direct render must paint immediately");
  assert.equal(
    renders[0].transcript[0].text,
    "one",
    "the direct render must include the token the cancelled flush would have shown"
  );
  assert.equal(renders[0].current_status, "idle", "and still carry the metadata it was sent to apply");
});

// P1: frontend/app.js:1192 (`renderer.renderSession`'s wrap) calls
// cancelPendingTranscriptFlush() and then paints `state.session` DIRECTLY —
// it never goes through renderSessionAndClearPendingFlush/ctx.renderSession
// at all, so it never called projectTranscriptWindowIfPending either. A BARE
// cancel (the old cancelPendingTranscriptFlush) would destroy the only
// scheduled catch-up while leaving state.session.transcript on its stale
// pre-projection array — so this direct paint would show that stale array
// with the just-streamed token invisible, permanently (nothing else was
// ever going to render it). cancelPendingTranscriptFlush must settle too.
test("cancelPendingTranscriptFlush settles the pending projection, so a direct render right after paints the fresh text, not the stale array", () => {
  const { controller, state, renders, transcriptFlushScheduler, cancelPendingTranscriptFlush } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });

  // Sanity: before settling, the array itself has not been rebuilt — only
  // the window Map has the token (this is what "deferred" means).
  assert.equal(state.session.transcript[0].text, "");
  assert.equal(transcriptFlushScheduler.stats().pending, true);

  // Drives the SAME resolveDirectRenderSession app.js's wrappedRenderSession
  // (frontend/app.js:1191) calls — not a hand-mirrored copy of its logic —
  // for every direct `renderer.renderSession(state.session)` call site there
  // (~30 of them): passes state.session, settles via cancelPendingTranscriptFlush
  // first, then hands the (possibly reassigned) session to the real renderer.
  // `renders` below stands in for that renderer, so the assertion is on what
  // it actually RECEIVED, not on state.session read back out independently of
  // any render call.
  const resolved = resolveDirectRenderSession(state.session, {
    state,
    cancelPendingTranscriptFlush,
  });
  renders.push(resolved);

  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the scheduled catch-up must be cancelled — the direct render satisfies it"
  );
  assert.equal(renders.length, 1, "the renderer must have been invoked exactly once");
  assert.equal(
    renders[0].transcript[0].text,
    "one",
    "a bare cancel would leave this stale — the RENDERER must receive the settled text, not the pre-projection array"
  );
});

// P1: render-session.js's OWN internal callbacks — teamsCache.sync's resolve
// (render-session.js:624), reviewsCache.sync's and workflowsCache.sync's
// resolves, the pairing-expiry timer — call the closure-local `renderSession`
// function DIRECTLY. None of them go through ctx.renderSession, and none of
// them go through app.js's `renderer.renderSession` wrap either (that wrap
// only intercepts the exported object property; these closures call the
// function binding itself). Settling only in those two places therefore
// leaves every one of these call sites able to paint the stale
// pre-projection array immediately and then paint AGAIN when the scheduler's
// own timer catches up. renderSessionBase below mirrors render-session.js's
// fix: renderSession calls cancelPendingTranscriptFlush itself.
test("an internal renderSession callback (mirroring render-session.js's teamsCache.sync resolve) settles the pending flush itself and is not double-rendered by the scheduler's own timer", () => {
  const { clock, controller, renders, state, transcriptFlushScheduler, renderSessionBase } = makeController();
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([["agent-1", { ...state.session.transcript[0] }]]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");
  assert.equal(transcriptFlushScheduler.stats().pending, true);

  // Mirrors render-session.js:624 — `() => renderSession(state.session || session)`,
  // a closure over the SAME `renderSession` this file's fix lives inside,
  // never routed through any external wrapper.
  function teamsCacheResolvedCallback() {
    renderSessionBase(state.session);
  }
  teamsCacheResolvedCallback();

  assert.equal(renders.length, 1, "the internal callback must have painted");
  assert.equal(
    renders[0].transcript[0].text,
    "one",
    "and painted the settled text, not the stale pre-projection array"
  );
  assert.equal(
    transcriptFlushScheduler.stats().pending,
    false,
    "the internal callback must cancel the scheduler's pending timer too, not just settle the array"
  );

  clock.tick(TRANSCRIPT_FLUSH_MAX_WINDOW_MS);
  assert.equal(
    renders.length,
    1,
    "the scheduler's own (already-cancelled) timer must not fire a second render"
  );
});

// P1: applyLocalTranscriptEntryPatch reads state.session.transcript and
// rebuilds it (for a DIFFERENT item than any pending delta targets) without
// ever touching the hydration window. Two ways that used to go wrong, both
// guarded here:
//   - The old render-time projection matched a pending append by ARRAY
//     IDENTITY. This patch's rebuild produces a new array reference, so the
//     match missed and agent-1's still-pending delta was silently dropped
//     from the eventual render (never lost from the window itself, just
//     never painted).
//   - Settling always re-derives the WHOLE array from the window
//     (settleTranscriptProjection), which does not know about this patch —
//     so if the patch does not settle FIRST, before its own read/rebuild,
//     the render chokepoint's later settle overwrites the patch's own
//     array-only change to agent-2 with the window's (unpatched) copy of it.
test("an entry patch for one item, landing between a delta for another item and the flush, does not drop the delta OR the patch", () => {
  const { clock, controller, renders, state } = makeController();
  state.session.transcript.push({
    item_id: "agent-2",
    kind: "agent_text",
    status: "running",
    text: "",
    tool: null,
    turn_id: "turn-2",
  });
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
    ["agent-2", { ...state.session.transcript[1] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1", "agent-2"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 0, "the delta must still be coalescing");

  // The interleaved write: a patch for agent-2 lands BEFORE the delta's
  // flush fires. It reads+rewrites state.session.transcript directly,
  // producing a new array reference — exactly the write the old
  // identity-matching projection could not see past.
  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-2", status: "completed", text: "done", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(renders.length, 1);
  const rendered = renders[0].transcript;
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-1").text,
    "one",
    "the delta for agent-1 must survive the interleaved patch for agent-2, not be dropped by it"
  );
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-2").text,
    "done",
    "and the patch itself must still land"
  );
});

// P1: settling before a patch reads the array only protects THAT ONE flush.
// A SECOND delta after the patch (still before the flush) re-arms
// transcriptWindowProjectionPending, and the eventual settle rebuilds the
// array from the window — which never received the patch's fields (it can
// never safely write them; see invalidateTranscriptWindowEntryForPatch) and
// was invalidated instead. renderedTranscriptFromWindow's array-fallback for
// that invalidated entry is what keeps the patch from being overwritten by
// the window's own (blanked) copy.
test("a patch survives a later delta for another item re-arming the pending projection before the flush", () => {
  const { clock, controller, renders, state } = makeController();
  state.session.transcript.push({
    item_id: "agent-2",
    kind: "agent_text",
    status: "running",
    text: "",
    tool: null,
    turn_id: "turn-2",
  });
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0] }],
    ["agent-2", { ...state.session.transcript[1] }],
  ]);
  state.transcriptHydrationOrder = ["agent-1", "agent-2"];

  controller.applyLocalTranscriptEntryDelta({
    delta: "one",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-2", status: "completed", text: "done", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );
  // The completion patch is terminal, so — per the immediate-flush fix — it
  // paints AT ONCE, settling agent-1's still-pending delta text along with it
  // rather than leaving both to coalesce.
  assert.equal(renders.length, 1, "a terminal patch must paint at once");
  assert.equal(
    renders[0].transcript.find((entry) => entry.item_id === "agent-1").text,
    "one",
    "the pending delta must be settled into the immediate flush, not dropped"
  );
  assert.equal(renders[0].transcript.find((entry) => entry.item_id === "agent-2").text, "done");

  // A second delta for agent-1 lands AFTER the patch's immediate flush,
  // re-arming the pending window projection for a fresh coalesced render.
  controller.applyLocalTranscriptEntryDelta({
    delta: " two",
    item_id: "agent-1",
    revision: 2,
    thread_id: "thread-1",
  });
  assert.equal(renders.length, 1, "still coalescing");

  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.equal(renders.length, 2);
  const rendered = renders[1].transcript;
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-1").text,
    "one two",
    "both deltas for agent-1 must land"
  );
  assert.equal(
    rendered.find((entry) => entry.item_id === "agent-2").text,
    "done",
    "the patch must survive the later delta re-arming the window projection — it must have reached the window itself"
  );
});

// P1: applyLocalTranscriptEntryPatch wrote into the window unconditionally —
// unlike the delta path a few lines up, it never checked transcriptWindowIsLoaded
// first. A patch landing while hydration was merely armed for this thread
// (transcriptHydrationThreadId set, but entries/order still empty) therefore
// created a one-entry "loaded" window off that single patched item, and the
// very next delta for a DIFFERENT, already-visible item then settles the
// array down to just the window's contents — dropping every untouched row.
test("a completion patch before hydration has loaded anything must not turn an empty window into a one-entry one", () => {
  const { clock, controller, renders, state } = makeController();
  state.session.transcript.push(
    { item_id: "agent-2", kind: "agent_text", status: "running", text: "", tool: null, turn_id: "turn-2" },
    { item_id: "agent-3", kind: "agent_text", status: "running", text: "", tool: null, turn_id: "turn-3" }
  );
  // Hydration has been armed for this thread but nothing has landed yet.
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map();
  state.transcriptHydrationOrder = [];

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-3", status: "completed", text: "done", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  assert.equal(
    state.transcriptHydrationOrder.length,
    0,
    "a patch alone must never be the thing that makes an unhydrated window look loaded"
  );

  // A delta for a DIFFERENT item, still visible in the array — if the patch
  // above had wrongly loaded the window, this would settle the array down to
  // just the window's one entry.
  controller.applyLocalTranscriptEntryDelta({
    delta: "X",
    item_id: "agent-1",
    revision: 1,
    thread_id: "thread-1",
  });
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  const rendered = renders[renders.length - 1].transcript;
  assert.equal(
    rendered.length,
    3,
    "agent-2 must not have been dropped by a window the patch alone should never have loaded"
  );
  assert.ok(rendered.some((entry) => entry.item_id === "agent-2"));
});

// P1 (review, transcriptPatchOverlay): invalidateTranscriptWindowEntryForPatch
// deliberately no-ops for an item absent from an otherwise-LOADED window — a
// patch carries no authoritative body, so it must never be what teaches the
// window about a new item (see .sealwire/PLAN.md, "Invalidate; do not
// write"). applyLocalTranscriptEntryPatch still appends the item to
// state.session.transcript so it is visible right away, and drives a real
// hydration merge (ensureConversationTranscript) so the window learns about
// it properly. A previous attempt at this ALSO blanket-invalidated every
// OTHER entry already in the window (a blunt whole-window repair) to keep a
// later settle from dropping the new item — that is no longer necessary
// (and no longer happens): renderedTranscriptFromWindow's own array-fallback
// for a window-missing item means an untouched sibling stays trusted.
test("a completion patch for an item a LOADED window has never seen survives a later settle, without invalidating its siblings", () => {
  const ensureConversationTranscriptCalls = [];
  const { clock, state, controller } = makeController({
    ensureConversationTranscript: (session) => {
      ensureConversationTranscriptCalls.push(session);
    },
  });
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["agent-1"];
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0], text: "sibling text", content_state: "full" }],
  ]);

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-2", status: "completed", text: "brand new", thread_id: "thread-1" },
    { defaultStatus: "completed" }
  );

  assert.ok(
    state.session.transcript.some((entry) => entry.item_id === "agent-2"),
    "the new entry must still be visible right away"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1")?.content_state,
    "full",
    "an untouched sibling must not be blanket-invalidated just because a DIFFERENT item was patched"
  );
  assert.equal(
    ensureConversationTranscriptCalls.length,
    1,
    "a real hydration merge must still be driven, so it can repair OTHER already-tracked entries"
  );
  // P1 (review): the pushed session must be the PRE-patch state.session, not
  // a patch-derived nextSession — a patch carries no content_state field, so
  // exposing agent-2's fabricated entry to hydration's tail merge would
  // default the missing field to "full" and poison the window with an
  // empty-but-"full" entry, permanently suppressing the real fetch (see
  // .sealwire/PLAN.md, "Invalidate; do not write" -> "Never route
  // non-authoritative data through the authoritative path").
  assert.ok(
    !ensureConversationTranscriptCalls[0]?.transcript?.some((entry) => entry.item_id === "agent-2"),
    "the session handed to hydration must not mention the patch-only item at all"
  );

  // A later delta for the SIBLING re-arms the pending projection; settling it
  // rebuilds the array from the window — which still has never heard of
  // agent-2. Must not silently drop it.
  controller.applyLocalTranscriptEntryDelta({
    delta: " more",
    item_id: "agent-1",
    text_offset: "sibling text".length,
    thread_id: "thread-1",
  });
  clock.tick(TRANSCRIPT_FLUSH_MIN_WINDOW_MS);

  assert.ok(
    state.session.transcript.some((entry) => entry.item_id === "agent-2"),
    "agent-2 must survive the sibling's later settle, not vanish because the window never tracked it"
  );
});

// P1 (review, transcriptPatchOverlay): a text-replacement patch used to
// change the window's PROJECTION via a side overlay without ever touching
// entries.get's own cached body. A later delta for the SAME item reconciled
// against that untouched, pre-patch body — not the patch's replacement — and,
// on success, cleared the overlay as "stale now". So patching "Hello" ->
// "Jello" then appending "!" at offset 5 (valid against the cached "Hello",
// coincidentally the same length) resolved to "Hello!", silently discarding
// the replacement. Now the patch clears the window's own cached text
// (invalidateTranscriptWindowEntryForPatch), so that same delta's offset (5
// against a blank cache) reads as a gap and is correctly refused instead of
// silently corrupting the text — the replacement survives, uncorrupted; the
// "!" is lost until hydration re-fetches, the "coarser, not cleverer"
// tradeoff .sealwire/PLAN.md accepts.
test("a text-replacement patch is not silently discarded by a later delta for the same item", () => {
  const { controller, state } = makeController();
  state.session.transcript[0].text = "Hello";
  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationEntries = new Map([
    ["agent-1", { ...state.session.transcript[0], content_state: "full" }],
  ]);
  state.transcriptHydrationOrder = ["agent-1"];

  controller.applyLocalTranscriptEntryPatch(
    { item_id: "agent-1", text: "Jello", status: "running", thread_id: "thread-1" }
  );
  assert.equal(state.session.transcript[0].text, "Jello", "the replacement must land immediately");

  controller.applyLocalTranscriptEntryDelta({
    delta: "!",
    item_id: "agent-1",
    text_offset: 5,
    thread_id: "thread-1",
  });
  settleTranscriptProjection(state);

  assert.equal(
    state.session.transcript[0].text,
    "Jello",
    "the replacement must survive a later delta for the same item — never revert to the pre-patch text"
  );
});

// Regression for the shared authoritative-tail-merge primitive
// (shared/authoritative-tail-merge.js): repairActiveTranscriptTail's merge is
// now delegated to it end to end. This proves both of the primitive's
// invariants actually reach the RENDERED transcript through that seam, not
// just the raw patch: an id the repair page does not cover keeps its place
// above the repaired entry, and an unexpectedly shorter authoritative body
// never overwrites already-visible text.
test("a tail repair keeps a retained older id above the repaired entry and never shortens its text, end to end", async () => {
  const fetchFreshTranscriptPage = () =>
    Promise.resolve({
      thread_id: "thread-1",
      entries: [
        {
          item_id: "agent-1",
          kind: "agent_text",
          status: "completed",
          text: "short",
          tool: null,
          turn_id: "turn-1",
        },
      ],
      prev_cursor: "cursor-older",
    });
  const { controller, state } = makeController({ fetchFreshTranscriptPage });

  state.transcriptHydrationThreadId = "thread-1";
  state.transcriptHydrationOrder = ["older", "agent-1"];
  state.transcriptHydrationEntries = new Map([
    [
      "older",
      {
        item_id: "older",
        kind: "user_text",
        status: "completed",
        text: "older retained history",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
    [
      "agent-1",
      {
        item_id: "agent-1",
        kind: "agent_text",
        status: "running",
        text: "hello world, the full streamed message",
        tool: null,
        entry_seq: null,
        content_state: "full",
      },
    ],
  ]);
  state.session.transcript = [
    { item_id: "older", kind: "user_text", status: "completed", text: "older retained history", tool: null, turn_id: null },
    state.session.transcript[0],
  ];

  // A refused (gapped) delta for "agent-1" fires repairActiveTranscriptTail.
  controller.applyLocalTranscriptEntryDelta({
    delta: "z",
    item_id: "agent-1",
    revision: 7,
    text_offset: 100,
    thread_id: "thread-1",
  });

  // The repair fetch is fire-and-forget; flush the microtask queue so its
  // continuation (merge + render) has run.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["older", "agent-1"],
    "the retained id (not covered by the page) must keep its place above the repaired entry"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("agent-1").text,
    "hello world, the full streamed message",
    "the never-shorten rule must survive the repair — a shorter authoritative page must not win"
  );
  assert.deepEqual(
    state.session.transcript.map((entry) => entry.item_id),
    ["older", "agent-1"],
    "the RENDERED transcript reflects the primitive's order, not just the window"
  );
  assert.equal(
    state.session.transcript[1].text,
    "hello world, the full streamed message",
    "the RENDERED transcript carries the never-shortened text, not the fetched page's shorter body"
  );
});

// The repair evicts the query key before refetching so a racing caller cannot attach
// to the request it is superseding. That only works if it evicts the key ordinary
// paging actually uses — generation included. Built without it, the current run's
// in-flight request stays registered and the "fresh" fetch is not fresh at all.
test("the repair evicts the key ordinary paging uses, generation included (real query client)", async () => {
  const queryClient = createRelayQueryClient();
  const inFlight = createDeferred();

  const options = createThreadTranscriptPageQueryOptions({
    before: null,
    fetchPage: () => inFlight.promise,
    generation: "gen-a",
    scope: "local",
    surface: "local",
    threadId: "thread-1",
  });
  const pending = queryClient.fetchQuery(options);

  await fetchThreadTranscriptPageFresh({
    before: null,
    fetchPage: async () => ({ thread_id: "thread-1", entries: [], prev_cursor: null }),
    generation: "gen-a",
    queryClient,
    scope: "local",
    surface: "local",
    threadId: "thread-1",
  });

  const stillRegistered = queryClient
    .getQueryCache()
    .findAll({ queryKey: options.queryKey, exact: true })
    .some((query) => query.state.fetchStatus === "fetching");
  assert.equal(
    stillRegistered,
    false,
    "the in-flight request for this generation must have been evicted"
  );

  inFlight.resolve({ thread_id: "thread-1", entries: [], prev_cursor: null });
  await pending.catch(() => {});
});
