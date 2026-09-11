import assert from "node:assert/strict";
import test from "node:test";

import { createStreamController } from "./stream.js";
import { settleTranscriptProjection } from "../transcript/store.js";
import { createViewedThreadRefreshLatch } from "../../shared/viewed-thread-refresh.js";
import {
  applyOrchestratorLoadFinally,
  beginOrchestratorLoad,
  nextOrchestratorRefreshObservations,
  nextOrchestratorWasWorking,
  orchestratorTranscriptRefreshDecision,
  takeDeferredOrchestratorRefresh,
} from "../orchestrator-transcript-refresh.js";

// Both review rounds found bugs my earlier tests missed because they only exercised the
// hydration STORE. The defect lived in the reducer that sits on top of it: it reconciled
// the delta into the store (correctly) and then appended the same delta to the rendered
// transcript again, so a re-delivered chunk rendered as duplicated text.
//
// These tests drive the REAL controller through its real event entry point.

// This file is exercising the delta REDUCER, not the shared flush scheduler
// (transcript-flush-scheduler.test.mjs and session-stream.test.mjs own that),
// so renders fire synchronously and every assertion reads state right after
// delivering an event rather than stepping a fake clock.
function createSyncTranscriptFlushScheduler(render) {
  const calls = [];
  return {
    calls,
    queue(reason) {
      calls.push({ method: "queue", reason });
      render();
    },
    note(chars) {
      calls.push({ method: "note", chars });
    },
    flushNow(reason) {
      calls.push({ method: "flushNow", reason });
      render();
    },
    cancel() {
      calls.push({ method: "cancel" });
    },
    stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
  };
}

function harness({
  threadId = "thread-1",
  itemId = "item-1",
  text = "Hello world",
  status = "running",
  windowLoaded = true,
} = {}) {
  const entry = {
    item_id: itemId,
    kind: "agent_text",
    text,
    status,
    turn_id: "turn-1",
    tool: null,
    content_state: "full",
  };
  const state = {
    session: {
      active_thread_id: threadId,
      transcript: [{ ...entry }],
      transcript_revision: 1,
    },
    transcriptHydrationThreadId: threadId,
    transcriptHydrationEntries: new Map([[itemId, { ...entry }]]),
    transcriptHydrationOrder: [itemId],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: null,
    viewOnlyThread: null,
  };
  if (!windowLoaded) {
    state.transcriptHydrationThreadId = null;
    state.transcriptHydrationEntries = new Map();
    state.transcriptHydrationOrder = [];
  }
  const rendered = [];
  const hydrationCalls = [];
  const renderSession = (session) => rendered.push(session);
  // Late-bound: the scheduler is constructed before the controller it flushes
  // through exists (same seam as session-controller.js's real render callback).
  let controller;
  const transcriptFlushScheduler = createSyncTranscriptFlushScheduler(() => {
    // The window-loaded delta path only bumps transcript_revision; this is
    // what derives the rendered array from the window (once per flush,
    // synchronous here so assertions can read state right after delivering).
    // Mirrors session-controller.js's ctx.renderSession wrapper, which
    // settles state.session in place before rendering.
    if (state.session) {
      settleTranscriptProjection(state);
      renderSession(state.session);
    }
  });
  controller = createStreamController({
    state,
    ensureConversationTranscript: (session) => {
      hydrationCalls.push(session);
    },
    logLine: () => {},
    seedDefaults: () => {},
    renderSession,
    handleUnauthorized: () => {},
    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    // Render synchronously so assertions do not race the scheduler's window.
    transcriptFlushScheduler,
  });
  const deliver = (event) =>
    controller.applySessionStreamEvent("transcript_entry_delta", {
      thread_id: threadId,
      item_id: itemId,
      delta_kind: "agent_text",
      turn_id: "turn-1",
      ...event,
    });
  const renderedText = () =>
    state.session.transcript.find((candidate) => candidate.item_id === itemId)?.text;
  const storedText = () => state.transcriptHydrationEntries.get(itemId)?.text;
  return {
    state,
    deliver,
    renderedText,
    storedText,
    rendered,
    controller,
    hydrationCalls,
    flushCalls: transcriptFlushScheduler.calls,
  };
}

test("a contiguous delta extends both the stored and the rendered text once", () => {
  const h = harness({ text: "Hello" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.storedText(), "Hello world");
  assert.equal(h.renderedText(), "Hello world");
});

// THE BUG: the SSE stream subscribes to deltas before it renders the initial snapshot,
// so a chunk can arrive both inside the snapshot and again as a buffered delta.
test("a re-delivered delta does not render duplicated text", () => {
  const h = harness({ text: "Hello world" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.storedText(), "Hello world", "the store stays correct");
  assert.equal(
    h.renderedText(),
    "Hello world",
    "and the RENDERED transcript must not double-append"
  );
});

test("a partially-overlapping re-delivery renders exactly the missing tail", () => {
  const h = harness({ text: "Hello wor" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.renderedText(), "Hello world");
});

// A gap means earlier text was lost. The reducer must not splice, and must leave the
// entry flagged for an authoritative refetch rather than freezing on a partial body.
test("a gapped delta neither splices nor renders, and marks the entry for repair", () => {
  const h = harness({ text: "Hello" });

  h.deliver({ delta: "tail", text_offset: 99 });

  assert.equal(h.renderedText(), "Hello", "no splice");
  assert.equal(
    h.state.transcriptHydrationEntries.get("item-1").content_state,
    "preview",
    "a refused delta must mark our copy non-authoritative so hydration refetches it"
  );
});

test("a divergent overlap is refused and marked for repair", () => {
  const h = harness({ text: "Hello XXXXX" });

  h.deliver({ delta: " world", text_offset: 5 });

  assert.equal(h.renderedText(), "Hello XXXXX");
  assert.equal(h.state.transcriptHydrationEntries.get("item-1").content_state, "preview");
});

// Command output carries no offset (the relay inserts separators server-side), so it
// stays append-only — but still must not double-append in the render.
test("command output appends once", () => {
  const h = harness({ text: "line 1" });

  h.deliver({ delta: "\nline 2", delta_kind: "command_output" });

  assert.equal(h.storedText(), "line 1\nline 2");
  assert.equal(h.renderedText(), "line 1\nline 2");
});

test("an unhydrated offsetless empty delta is ignored", () => {
  const h = harness({ text: "done", status: "completed", windowLoaded: false });
  const originalSession = h.state.session;

  h.deliver({ delta: "", revision: 2 });

  assert.equal(h.state.session, originalSession, "the no-op must not rebuild the session");
  assert.equal(h.rendered.length, 0, "the no-op must not schedule a render");
  assert.equal(h.renderedText(), "done");
  assert.equal(h.state.session.transcript[0].status, "completed");
  assert.equal(h.state.session.transcript_revision, 1);
});

test("a loaded-window offsetless empty delta advances revision and marks the entry running", () => {
  const h = harness({ text: "done", status: "completed", windowLoaded: true });

  h.deliver({ delta: "", revision: 2 });

  const storedEntry = h.state.transcriptHydrationEntries.get("item-1");
  assert.equal(storedEntry.text, "done");
  assert.equal(storedEntry.status, "running");
  assert.equal(h.renderedText(), "done");
  assert.equal(h.state.session.transcript[0].status, "running");
  assert.equal(h.state.session.transcript_revision, 2);
  assert.deepEqual(
    h.flushCalls.filter((call) => call.method !== "note"),
    [{ method: "queue", reason: "transcript_entry_delta" }],
    "an empty live delta should keep the existing queued render timing"
  );
  assert.equal(h.rendered.length, 1, "the queued render should still paint once");
});

// A first delta for an unknown item that does NOT start at 0 means the opening text was
// lost. Storing that tail as a complete body would present a truncated message as whole.
test("an unknown item arriving mid-stream is flagged instead of shown as complete", () => {
  const h = harness();

  h.deliver({ item_id: "item-late", delta: "middle of a message", text_offset: 42 });

  const late = h.state.transcriptHydrationEntries.get("item-late");
  assert.equal(late.content_state, "preview", "must not claim to be the full body");
  assert.equal(late.text, "", "a body that starts mid-stream must not masquerade as whole");
});

test("an unknown item starting at offset 0 is stored as a full body", () => {
  const h = harness();

  h.deliver({ item_id: "item-new", delta: "a new message", text_offset: 0 });

  const created = h.state.transcriptHydrationEntries.get("item-new");
  assert.equal(created.text, "a new message");
  assert.equal(created.content_state, "full");
});

// Deltas for a thread this surface is not showing must not touch the live transcript.
test("a delta for another thread leaves the rendered transcript alone", () => {
  const h = harness({ text: "Hello" });

  h.deliver({ thread_id: "thread-other", delta: " stray", text_offset: 5 });

  assert.equal(h.renderedText(), "Hello");
});

// REVIEW P1: a lagged broadcast means frames were DROPPED. A compacted snapshot cannot
// repair that on its own — the merge keeps the longer local body over a shorter
// preview, so a stale-but-longer cache would win forever. The stream therefore tells
// the client explicitly, and the client must mark its window for refetch.
test("a lagged stream marks the loaded window for authoritative refetch", () => {
  const h = harness({ text: "a".repeat(1700) });
  assert.equal(h.state.transcriptHydrationEntries.get("item-1").content_state, "full");

  h.controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 12 });

  assert.equal(
    h.state.transcriptHydrationEntries.get("item-1").content_state,
    "preview",
    "a dropped-frame notice must make our cached body non-authoritative"
  );
});

// Marking dirty is NOT convergence. The re-hydration gate only fires on a later render
// whose snapshot still says truncated — and the server merges snapshot and delta frames
// with `stream::select`, so the newest snapshot can arrive BEFORE the lag notice. With
// no further state change afterwards, nothing would ever refetch and the tail would sit
// short forever. The notice must therefore drive the fetch itself.
test("a lagged stream starts an authoritative fetch, not just a dirty flag", () => {
  const h = harness({ text: "a".repeat(1700) });

  h.controller.applySessionStreamEvent("transcript_stream_lagged", { dropped: 3 });

  assert.equal(
    h.hydrationCalls.length,
    1,
    "the lag notice must trigger the transcript fetch itself"
  );
});

// REVIEW P2: a delta already covered by the initial snapshot legitimately arrives after
// it (the stream subscribes before the snapshot renders). Taking its revision verbatim
// walked the cursor BACKWARDS, making later snapshots look stale.
test("an already-covered delta does not roll the revision backwards", () => {
  const h = harness({ text: "Hello world" });
  h.state.session.transcript_revision = 10;

  h.deliver({ delta: " world", text_offset: 5, revision: 9 });

  assert.equal(
    h.state.session.transcript_revision,
    10,
    "the revision cursor must be monotonic"
  );
});

test("a newer delta still advances the revision", () => {
  const h = harness({ text: "Hello" });
  h.state.session.transcript_revision = 10;

  h.deliver({ delta: " world", text_offset: 5, revision: 11 });

  assert.equal(h.state.session.transcript_revision, 11);
  assert.equal(h.renderedText(), "Hello world");
});

// Proof seam for the Cursor active-tail e2e: SSE arrival is not evidence that
// the reducer accepted the frame. Only a successful non-empty active-thread
// apply may report item id and text length before/after.
function withAppliedDeltaSink(run) {
  const previous = globalThis.__appliedLocalTranscriptDeltas;
  const sink = [];
  globalThis.__appliedLocalTranscriptDeltas = sink;
  try {
    return run(sink);
  } finally {
    if (previous === undefined) {
      delete globalThis.__appliedLocalTranscriptDeltas;
    } else {
      globalThis.__appliedLocalTranscriptDeltas = previous;
    }
  }
}

test("accepted active-thread deltas emit applied length, refusals do not", () => {
  withAppliedDeltaSink((sink) => {
    const h = harness({ text: "Hello" });

    h.deliver({ delta: " world", text_offset: 5 });
    assert.deepEqual(sink, [
      {
        itemId: "item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        textLengthBefore: 5,
        textLengthAfter: 11,
      },
    ]);

    // Duplicate re-delivery: already covered by the body.
    h.deliver({ delta: " world", text_offset: 5 });
    // Gap: starts past the end of what we hold.
    h.deliver({ delta: "tail", text_offset: 99 });
    // Rejected: same range, different bytes.
    h.deliver({ delta: " XXXXX", text_offset: 5 });
    // Other thread: routed away from the active transcript.
    h.deliver({ thread_id: "thread-other", delta: " stray", text_offset: 5 });

    assert.deepEqual(
      sink,
      [
        {
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
          textLengthBefore: 5,
          textLengthAfter: 11,
        },
      ],
      "duplicate, gapped, rejected, and other-thread frames must not emit"
    );
  });
});

// ---- the Orchestrator's transcript -----------------------------------------

// The Orchestrator is drawn BESIDE the conversation, so while you are reading a
// session it is never the active thread. Every non-active delta was routed to
// `state.viewOnlyThread` — the CONVERSATION's pin — and with no pin of its own
// the Orchestrator's deltas were dropped on the floor. Its pane then moved only
// when something re-fetched the whole page, which reads as "no streaming".
//
// The fix reuses `applyDeltaToViewOnlyPin` rather than growing a second reducer:
// offset reconciliation, gap refusal and thread-id ownership get decided once.
function orchHarness({ orchThreadId = "orch-1", entries = null } = {}) {
  const state = {
    session: {
      active_thread_id: "thread-1",
      transcript: [],
      transcript_revision: 1,
    },
    viewOnlyThread: null,
    orchestratorEntriesThreadId: orchThreadId,
    orchestratorEntries: entries ?? [
      { item_id: "orch-item-1", kind: "agent_text", text: "Look", status: "running" },
    ],
  };
  const rendered = [];
  const renderSession = (session) => rendered.push(session);
  const controller = createStreamController({
    state,
    ensureConversationTranscript: () => {},
    logLine: () => {},
    seedDefaults: () => {},
    renderSession,
    handleUnauthorized: () => {},
    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    transcriptFlushScheduler: createSyncTranscriptFlushScheduler(() => {
      if (state.session) {
        renderSession(state.session);
      }
    }),
  });
  const deliver = (event) =>
    controller.applySessionStreamEvent("transcript_entry_delta", {
      item_id: "orch-item-1",
      delta_kind: "agent_text",
      turn_id: "orch-turn-1",
      ...event,
    });
  const orchText = () =>
    state.orchestratorEntries.find((entry) => entry.item_id === "orch-item-1")?.text;
  return { state, deliver, orchText, rendered };
}

test("a delta for the Orchestrator extends its entries and repaints", () => {
  const h = orchHarness();

  h.deliver({ thread_id: "orch-1", delta: "ing at it", text_offset: 4 });

  assert.equal(h.orchText(), "Looking at it");
  assert.equal(h.rendered.length, 1, "the pane must be repainted, not just mutated");
});

test("the Orchestrator gets the same offset reconciliation as a pinned thread", () => {
  const h = orchHarness();

  // Re-delivery of a chunk the entries already carry must not double-append.
  h.deliver({ thread_id: "orch-1", delta: "ok", text_offset: 4 });
  h.deliver({ thread_id: "orch-1", delta: "ok", text_offset: 4 });

  assert.equal(h.orchText(), "Lookok");
});

test("a delta for the Orchestrator leaves the conversation's own pin alone", () => {
  const h = orchHarness();
  h.state.viewOnlyThread = {
    threadId: "pinned-1",
    entries: [{ item_id: "pinned-item", text: "untouched", status: "running" }],
  };
  const pinBefore = h.state.viewOnlyThread;

  h.deliver({ thread_id: "orch-1", delta: "ing", text_offset: 4 });

  assert.equal(h.state.viewOnlyThread, pinBefore, "the pin object must not be replaced");
});

test("a delta for some third thread touches neither", () => {
  const h = orchHarness();

  h.deliver({ thread_id: "someone-else", delta: "nope", text_offset: 4 });

  assert.equal(h.orchText(), "Look");
  assert.equal(h.rendered.length, 0);
});

test("nothing happens when the Tasks screen has never loaded a transcript", () => {
  const h = orchHarness({ entries: [] });
  h.state.orchestratorEntriesThreadId = null;

  h.deliver({ thread_id: "orch-1", delta: "hi", text_offset: 0 });

  assert.deepEqual(h.state.orchestratorEntries, []);
  assert.equal(h.rendered.length, 0);
});

// The bug this pins: the reducer returns `wasWorking: true` and an
// `activeTurnId` alongside the entries (view-only-thread.js:146-148) precisely
// so a pin carrying live deltas is known to be mid-turn. The Orchestrator's
// routing kept only `.entries` and threw the rest away, and then derived
// "was working" from `thread_activity` instead. When that array does not list
// the Orchestrator -- or the Tasks screen is not mounted for the frame that
// carries the phase -- the working->idle refresh never fires and the last
// message renders as forever-streaming.
test("a streamed delta marks the Orchestrator as mid-turn", () => {
  const h = orchHarness();
  assert.notEqual(h.state.orchestratorWasWorking, true);

  h.deliver({ thread_id: "orch-1", delta: "ing", text_offset: 4 });

  assert.equal(h.state.orchestratorWasWorking, true, "text is arriving, so it is working");
  assert.equal(h.state.orchestratorDeltaRaisedWorking, true);
});

test("a delta for another thread does not mark the Orchestrator working", () => {
  const h = orchHarness();

  h.deliver({ thread_id: "someone-else", delta: "x", text_offset: 4 });

  assert.notEqual(h.state.orchestratorWasWorking, true);
});

const ORCH_THREAD = "orch-1";
const LIVE_THREAD = "thread-1";

function orchSession({ threadActivity = [] } = {}) {
  return {
    active_thread_id: LIVE_THREAD,
    orchestrator_thread_id: ORCH_THREAD,
    thread_activity: threadActivity,
  };
}

// Drive the same refresh decision renderTaskTeam uses. Deltas land through the
// stream controller; the Tasks pane applies the policy on the next render.
function maybeRefreshOrchestrator(state, session, loads, latch = null) {
  const orchId = state.orchestratorEntriesThreadId;
  const decision = orchestratorTranscriptRefreshDecision(state, session, orchId);
  state.orchestratorWasWorking = nextOrchestratorWasWorking(state, decision.orchWorking);
  Object.assign(state, nextOrchestratorRefreshObservations(state, decision.orchWorking));
  if (decision.defer) {
    latch?.defer(orchId);
  } else if (decision.refresh) {
    loads.push({ threadId: orchId, terminal: decision.terminal, repair: decision.repair });
  }
}

// The other half of that call site: render-session.js:2524-2545. Both answers
// that need no fetch are modelled, because both used to leave the loader without
// reaching the settle. There the two share one `finally`; here the fetch is only
// started rather than awaited, so the settle is written out on each.
function loadOrchestratorTranscript(
  state,
  threadId,
  { terminal = false, repair = false, canFetch = true } = {}
) {
  const generation = beginOrchestratorLoad(state, { repair });
  if (!threadId || !canFetch) {
    state.orchestratorEntries = [];
    state.orchestratorEntriesThreadId = threadId || null;
    applyOrchestratorLoadFinally(state, generation, threadId, state.session, { terminal });
    return null;
  }
  if (state.session?.active_thread_id === threadId) {
    state.orchestratorEntries = state.session.transcript || [];
    state.orchestratorEntriesThreadId = threadId;
    applyOrchestratorLoadFinally(state, generation, threadId, state.session, { terminal });
    return null;
  }
  return generation;
}

// render-session.js:2238-2250 again, this time including the tail of it: the
// load's promise re-renders the pane when it settles, so a decision the load
// does not answer is simply retaken on the next frame. Bounded, so a policy
// that never converges fails with a count instead of hanging the run.
function renderUntilQuiet(state, session, { canFetch = true, maxRenders = 6 } = {}) {
  const loads = [];
  for (let render = 0; render < maxRenders; render += 1) {
    const before = loads.length;
    maybeRefreshOrchestrator(state, session, loads);
    if (loads.length === before) {
      break;
    }
    const scheduled = loads[loads.length - 1];
    loadOrchestratorTranscript(state, scheduled.threadId, {
      terminal: scheduled.terminal,
      repair: scheduled.repair,
      canFetch,
    });
  }
  return loads;
}

test("orchestrator idle refresh fires when thread_activity clears after a delta", () => {
  const h = orchHarness();

  h.deliver({ thread_id: ORCH_THREAD, delta: "ing", text_offset: 4 });
  assert.equal(h.state.orchestratorWasWorking, true);

  const loads = [];
  const workingSession = orchSession({
    threadActivity: [{ thread_id: ORCH_THREAD, phase: "tool", tool: "Bash" }],
  });
  maybeRefreshOrchestrator(h.state, workingSession, loads);
  assert.equal(loads.length, 0, "no refresh while the orchestrator is still working");
  assert.equal(h.state.orchestratorWasWorking, true);

  const idleSession = orchSession();
  maybeRefreshOrchestrator(h.state, idleSession, loads);
  assert.equal(loads.length, 1, "phase clearing must trigger an authoritative refetch");
  assert.equal(loads[0].threadId, ORCH_THREAD);
  assert.equal(loads[0].terminal, true);
});

test("a fresh orchestrator delta is not mistaken for an observed idle edge", () => {
  const h = orchHarness();

  h.deliver({ thread_id: ORCH_THREAD, delta: "ing", text_offset: 4 });
  assert.equal(h.state.orchestratorWasWorking, true);
  assert.equal(h.state.orchestratorDeltaRaisedWorking, true);

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);

  assert.equal(loads.length, 0, "thread_activity omission must not arm a terminal fetch mid-turn");
  assert.equal(h.state.orchestratorWasWorking, true);
  assert.equal(h.state.orchestratorDeltaRaisedWorking, false, "the suppression latch is consumed on render");

  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads.length, 1, "a later idle render must still refetch");
  assert.equal(loads[0].terminal, true);
});

test("orchestrator idle refresh survives thread_activity omitting the orchestrator during work", () => {
  const h = orchHarness();
  h.state.orchestratorEntriesLoading = true;

  h.deliver({ thread_id: ORCH_THREAD, delta: "ing", text_offset: 4 });
  assert.equal(h.state.orchestratorWasWorking, true);

  const loads = [];
  const workingSession = orchSession();
  maybeRefreshOrchestrator(h.state, workingSession, loads);

  assert.equal(loads.length, 0, "an in-flight page load must not swallow the idle edge");
  assert.equal(
    h.state.orchestratorWasWorking,
    true,
    "thread_activity must not clobber a delta-raised working latch"
  );

  h.state.orchestratorEntriesLoading = false;
  maybeRefreshOrchestrator(h.state, workingSession, loads);
  assert.equal(loads.length, 1, "the settled working→idle edge must refetch");
  assert.equal(loads[0].threadId, ORCH_THREAD);
  assert.equal(loads[0].terminal, true);
});

test("orchestrator tailGap triggers refresh even while entries are loading", () => {
  const h = orchHarness();
  h.state.orchestratorEntriesLoading = true;

  h.deliver({ thread_id: ORCH_THREAD, delta: "tail", text_offset: 99 });
  assert.equal(h.state.orchestratorTailGap, true);

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);

  assert.equal(loads.length, 1, "a refused delta must not wait behind orchestratorEntriesLoading");
  assert.equal(loads[0].threadId, ORCH_THREAD);
  assert.equal(loads[0].repair, true);
});

test("orchestrator tailGap repair does not start a second fetch while one is in flight", () => {
  const h = orchHarness();
  h.state.orchestratorTailGap = true;

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads.length, 1);
  loadOrchestratorTranscript(h.state, ORCH_THREAD, { repair: true });
  assert.equal(h.state.orchestratorTailGapRepairing, true, "the fetch that began holds the latch");

  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads.length, 1, "tail-gap repair must be single-flight while the gap remains");
});

// The latch has exactly one release, `applyOrchestratorLoadFinally`, and it runs
// in the loader's `finally`. So a load that returns before the `try` must not
// have taken the latch -- it would stay set for the life of the page, and
// `needsTailGapRepair = tailGap && !tailGapRepairing` would be false forever.
// This early return is reachable: the decision reads the session argument
// renderTaskTeam was called with, the loader reads `state.session`, and the two
// disagree while a thread switch is settling.
test("a repair that answered without fetching must not disable repair forever", () => {
  const h = orchHarness();
  h.state.orchestratorTailGap = true;

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads[0].repair, true, "the gap asked for a repair");

  // `state.session` says the Orchestrator is the active thread, so the loader
  // answers from the live transcript and never fetches.
  h.state.session = {
    ...h.state.session,
    active_thread_id: ORCH_THREAD,
    transcript: h.state.orchestratorEntries,
  };
  const generation = loadOrchestratorTranscript(h.state, ORCH_THREAD, { repair: true });
  assert.equal(generation, null, "no fetch began, so there is no settle coming");

  // It goes back to the background and the next delta is refused: a fresh hole,
  // which must be repairable no matter how the previous one was answered.
  h.state.session = { ...h.state.session, active_thread_id: LIVE_THREAD };
  h.deliver({ thread_id: ORCH_THREAD, delta: "tail", text_offset: 99 });
  assert.equal(h.state.orchestratorTailGap, true);

  const later = [];
  maybeRefreshOrchestrator(h.state, orchSession(), later);

  assert.equal(later.length, 1, "the new gap must still be repairable");
  assert.equal(later[0].repair, true);
});

// Nothing throttles tail-gap repair -- `shouldRefreshViewedThread` returns true
// on `needsRepair` before it looks at anything else, and the poll that used to
// pace this was deliberately removed. So "settled" is the only thing that ends a
// repair, and a load that answers without fetching has to settle too. Left
// unsettled, the load's promise re-renders, the gap is still there, and the pane
// schedules another repair on every frame for the life of the page.
test("a repair with no fetcher settles instead of re-arming on every render", () => {
  const h = orchHarness();
  h.state.orchestratorTailGap = true;

  const loads = renderUntilQuiet(h.state, orchSession(), { canFetch: false });

  assert.equal(loads.length, 1, "one attempt, then quiet");
  assert.equal(h.state.orchestratorTailGap, false, "a gap nothing can fetch must not stay armed");
});

test("a repair the live transcript answers settles instead of re-arming", () => {
  const h = orchHarness();
  h.state.orchestratorTailGap = true;
  // The disagreement that makes this reachable: the decision reads the session
  // renderTaskTeam was handed, which still has the Orchestrator in the
  // background, while the loader reads `state.session`, where it is already the
  // active thread.
  h.state.session = {
    ...h.state.session,
    active_thread_id: ORCH_THREAD,
    transcript: h.state.orchestratorEntries,
  };

  const loads = renderUntilQuiet(h.state, orchSession());

  assert.equal(loads.length, 1, "one attempt, then quiet");
  assert.equal(h.state.orchestratorTailGap, false, "the live transcript is the answer");
});

test("a superseded orchestrator load must not clear tail-gap repair flags", () => {
  const state = {
    orchestratorLoadGeneration: 2,
    orchestratorEntriesLoading: true,
    orchestratorTailGapRepairing: true,
    orchestratorTailGap: true,
    orchestratorEntriesThreadId: ORCH_THREAD,
    orchestratorWasWorking: false,
    orchestratorDeltaDuringFetch: false,
    session: orchSession(),
  };

  const settled = applyOrchestratorLoadFinally(state, 1, ORCH_THREAD, state.session, {
    terminal: false,
  });

  assert.equal(settled, false, "stale generation must not mutate loading/repair state");
  assert.equal(state.orchestratorEntriesLoading, true);
  assert.equal(state.orchestratorTailGapRepairing, true);
});

// The settle is the ONE place that answers "does the hole still exist?", for the
// same reason the view-only pin decides it in one place
// (view-only-refresh-ops.js:139-142): the page the server built cannot describe
// a delta that was refused after it was built. The loader's success branch used
// to answer it too, unconditionally, and its answer landed first -- so a delta
// refused mid-fetch had its gap wiped and the hole was never repaired.
function settleOrchestratorLoad(state, generation, { terminal = false } = {}) {
  return applyOrchestratorLoadFinally(state, generation, ORCH_THREAD, state.session, {
    terminal,
  });
}

test("a gap raised while an orchestrator fetch is in flight survives the settle", () => {
  const h = orchHarness();
  h.state.session = { ...h.state.session, ...orchSession() };
  h.state.orchestratorLoadGeneration = 1;
  h.state.orchestratorEntriesLoading = true;

  // Refused after the server built the page, before the promise resolved.
  h.deliver({ thread_id: ORCH_THREAD, delta: "tail", text_offset: 99 });
  assert.equal(h.state.orchestratorTailGap, true);
  assert.equal(h.state.orchestratorDeltaDuringFetch, true);

  settleOrchestratorLoad(h.state, 1, { terminal: true });

  assert.equal(h.state.orchestratorTailGap, true, "the page never covered this delta");

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads);
  assert.equal(loads.length, 1, "the surviving gap must schedule the repair");
  assert.equal(loads[0].repair, true);
});

test("a settled orchestrator load clears a gap no delta re-raised", () => {
  const state = {
    orchestratorLoadGeneration: 1,
    orchestratorEntriesLoading: true,
    orchestratorTailGapRepairing: true,
    orchestratorTailGap: true,
    orchestratorEntriesThreadId: ORCH_THREAD,
    orchestratorWasWorking: false,
    orchestratorDeltaDuringFetch: false,
    session: orchSession(),
  };

  settleOrchestratorLoad(state, 1, { terminal: true });

  assert.equal(state.orchestratorTailGap, false, "this fetch answered the gap it was sent to repair");

  const loads = [];
  maybeRefreshOrchestrator(state, orchSession(), loads);
  assert.equal(loads.length, 0, "an uncleared gap re-fetches on every frame -- there is no throttle");
});

// `orchestratorDeltaDuringFetch` decides both answers, so the settle has to read
// it before it clears it. It used to clear first and then call
// `orchestratorWasWorkingAfterFetch`, which reads that same field -- always false.
test("the settle reads deltaDuringFetch before clearing it", () => {
  const state = {
    orchestratorLoadGeneration: 1,
    orchestratorEntriesLoading: true,
    orchestratorTailGapRepairing: false,
    orchestratorTailGap: false,
    orchestratorEntriesThreadId: ORCH_THREAD,
    orchestratorWasWorking: true,
    orchestratorDeltaDuringFetch: true,
    session: orchSession(),
  };

  settleOrchestratorLoad(state, 1, { terminal: true });

  assert.equal(
    state.orchestratorWasWorking,
    true,
    "a delta landed mid-fetch, so this terminal refresh did not observe the idle edge"
  );
  assert.equal(state.orchestratorDeltaDuringFetch, false, "and the flag is consumed");
});

// Scrolling up starts an older-history fetch that validates itself against
// `orchestratorLoadGeneration`. Any refresh landing mid-flight bumps that
// counter, so the history page is thrown away on arrival — and nothing asks
// again, because the sentinel that requested it has already backed off. The user
// scrolls up and the page simply never comes.
//
// The view-only pane solves this by deferring the refresh instead of firing it
// (`maybeRefreshViewOnly` + the `finally` of `loadOlderViewOnlyTranscript`), and
// re-running the decision once history settles. Same latch, same policy here.
test("a repair refresh defers rather than superseding an older-history fetch", () => {
  const h = orchHarness();
  const latch = createViewedThreadRefreshLatch();
  h.state.orchestratorLoadGeneration = 7;
  h.state.orchestratorOlderLoading = true;
  h.state.orchestratorTailGap = true;

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads, latch);

  assert.equal(loads.length, 0, "a repair must not fire on top of an in-flight history page");
  assert.equal(
    h.state.orchestratorLoadGeneration,
    7,
    "and so the generation that page validates against still holds"
  );

  // The history request settles and hands the deferred decision back.
  h.state.orchestratorOlderLoading = false;
  assert.equal(latch.take(), ORCH_THREAD, "the deferred refresh must be remembered");

  maybeRefreshOrchestrator(h.state, orchSession(), loads, latch);
  assert.equal(loads.length, 1, "and then actually run");
  assert.equal(loads[0].repair, true);
});

// A repair never reaches `shouldRefreshViewedThread`'s `wasWorking` test, and a
// terminal refresh never reaches its `needsRepair` test, so neither covers the
// other -- both have to defer.
test("a terminal refresh defers rather than superseding an older-history fetch", () => {
  const h = orchHarness();
  const latch = createViewedThreadRefreshLatch();
  h.state.orchestratorOlderLoading = true;

  h.deliver({ thread_id: ORCH_THREAD, delta: "ing", text_offset: 4 });
  assert.equal(h.state.orchestratorWasWorking, true);
  // Consume the delta-raised suppression so the next render sees a real edge.
  maybeRefreshOrchestrator(h.state, orchSession(), [], latch);

  const loads = [];
  maybeRefreshOrchestrator(h.state, orchSession(), loads, latch);
  assert.equal(loads.length, 0, "the idle edge must wait for history, not race it");
  assert.equal(h.state.orchestratorWasWorking, true, "the edge is not spent by deferring");

  h.state.orchestratorOlderLoading = false;
  assert.equal(latch.take(), ORCH_THREAD);

  maybeRefreshOrchestrator(h.state, orchSession(), loads, latch);
  assert.equal(loads.length, 1, "the deferred terminal refresh runs once history settles");
  assert.equal(loads[0].terminal, true);
});

test("a deferred refresh for a thread the pane no longer shows is dropped", () => {
  const h = orchHarness();
  const latch = createViewedThreadRefreshLatch();
  h.state.orchestratorOlderLoading = true;
  h.state.orchestratorTailGap = true;

  maybeRefreshOrchestrator(h.state, orchSession(), [], latch);

  // The pane moved to another Orchestrator thread while history was in flight.
  h.state.orchestratorEntriesThreadId = "orch-2";
  assert.equal(
    takeDeferredOrchestratorRefresh(h.state, latch),
    null,
    "the deferred decision belonged to the thread that is gone"
  );
  assert.equal(latch.take(), null, "and it is consumed either way");
});

// stream.js writes the hydration window directly, outside the store, via
// applyAcceptedEmptyOffsetlessDeltaToWindow — which pushes a new id at the tail.
// These pin down WHY that cannot break the cached keyed proof: the store's own
// writer runs first and owns every new row, so the direct writer only ever sees
// rows the window already holds. Both assertions are about the composed path,
// which is the thing that actually has to hold.
test("an offsetless empty delta for an unknown item is placed by number by the store writer", () => {
  const h = harness({ windowLoaded: true });
  const S = 1 << 20;
  h.state.transcriptHydrationEntries.set("item-1", {
    ...h.state.transcriptHydrationEntries.get("item-1"),
    order_seq: 0,
  });
  h.state.transcriptHydrationEntries.set("item-late", {
    item_id: "item-late",
    kind: "agent_text",
    text: "later",
    status: "completed",
    order_seq: 2 * S,
  });
  h.state.transcriptHydrationOrder = ["item-1", "item-late"];
  h.state.transcriptHydrationKeyed = true;

  h.deliver({ item_id: "item-mid", delta: "", order_seq: S, revision: 2 });

  assert.deepEqual(
    h.state.transcriptHydrationOrder,
    ["item-1", "item-mid", "item-late"],
    "a blind tail push would render it below a row it was born before"
  );
  assert.equal(h.state.transcriptHydrationKeyed, true, "a numbered row keeps the proof");
});

test("an offsetless empty delta with NO number still revokes the keyed proof", () => {
  const h = harness({ windowLoaded: true });
  h.state.transcriptHydrationEntries.set("item-1", {
    ...h.state.transcriptHydrationEntries.get("item-1"),
    order_seq: 0,
  });
  h.state.transcriptHydrationKeyed = true;

  h.deliver({ item_id: "item-unnumbered", delta: "", revision: 2 });

  assert.equal(
    h.state.transcriptHydrationKeyed,
    false,
    "an unnumbered row must not sit in a window still claiming to be keyed"
  );
});
