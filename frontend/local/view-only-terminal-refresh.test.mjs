import assert from "node:assert/strict";
import test from "node:test";

import { createStreamController } from "./session/stream.js";
import { createViewOnlyRefreshOps } from "./view-only-refresh-ops.js";

const LIVE_THREAD = "thread-live";
const BG_THREAD = "thread-bg";

// This file exercises the view-only refresh policy, not the shared flush
// scheduler, so renders fire synchronously rather than stepping a fake clock.
function createSyncTranscriptFlushScheduler(render) {
  return {
    queue: render,
    note() {},
    flushNow: render,
    cancel() {},
    stats: () => ({ renderCount: 0, windowMs: 100, pending: false, pendingChars: 0 }),
  };
}

function session({ threadActivity = [] } = {}) {
  return {
    active_thread_id: LIVE_THREAD,
    transcript: [],
    transcript_revision: 1,
    thread_activity: threadActivity,
  };
}

function createHarness() {
  const state = {
    session: session(),
    viewThreadId: BG_THREAD,
    viewOnlyThread: null,
    viewOnlyGeneration: 0,
  };
  const loads = [];
  let pendingResolve = null;
  let pendingReject = null;
  let pendingTerminal = false;

  const ops = createViewOnlyRefreshOps({
    getState: () => state,
    fetchTranscriptPage: async (threadId) => {
      const load = { threadId, terminal: pendingTerminal };
      loads.push(load);
      pendingTerminal = false;
      return new Promise((resolve, reject) => {
        pendingResolve = (page) => {
          pendingResolve = null;
          pendingReject = null;
          resolve(
            page ?? {
              thread_id: threadId,
              entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "done" }],
              prev_cursor: null,
            }
          );
        };
        pendingReject = (error) => {
          pendingResolve = null;
          pendingReject = null;
          reject(error);
        };
        load.resolve = pendingResolve;
      });
    },
    renderSession: (nextSession) => {
      state.session = nextSession;
      ops.maybeRefreshViewOnly(nextSession);
    },
    logLine: () => {},
    findVisible: () => null,
    reviewSignature: () => null,
    syncWatchedThreads: () => {},
    getOrchestratorWatchIds: () => [],
    isReviewInProgressForThread: () => false,
    isWorkflowInProgressForThread: () => false,
  });
  const loadViewOnlyTranscript = ops.loadViewOnlyTranscript.bind(ops);
  ops.loadViewOnlyTranscript = (threadId, options = {}) => {
    pendingTerminal = options.terminal === true;
    return loadViewOnlyTranscript(threadId, options);
  };

  const streamRenderSession = (nextSession) => {
    state.session = nextSession;
    ops.maybeRefreshViewOnly(nextSession);
  };
  const stream = createStreamController({
    state,
    ensureConversationTranscript: () => {},
    logLine: () => {},
    seedDefaults: () => {},
    renderSession: streamRenderSession,
    handleUnauthorized: () => {},
    applySessionSnapshot: () => {},
    cancelSessionPoll: () => {},
    cancelStreamReconnect: () => {},
    scheduleSessionPoll: () => {},
    scheduleStreamReconnect: () => {},
    transcriptFlushScheduler: createSyncTranscriptFlushScheduler(() => {
      if (state.session) {
        streamRenderSession(state.session);
      }
    }),
  });

  return {
    state,
    ops,
    stream,
    loads,
    completePendingFetch(page) {
      assert.ok(pendingResolve, "expected an in-flight view-only fetch");
      pendingResolve(page);
    },
    failPendingFetch(error = new Error("transcript page unavailable")) {
      assert.ok(pendingReject, "expected an in-flight view-only fetch");
      pendingReject(error);
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("maybeRefreshViewOnly arms loadViewOnlyTranscript when thread_activity clears", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    wasWorking: true,
    lastRefreshAt: Date.now(),
    loading: false,
  };

  h.ops.maybeRefreshViewOnly(session());
  await h.flush();

  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].threadId, BG_THREAD);
});

test("a delta during an initial fetch preserves wasWorking and re-arms terminal refresh", async () => {
  const h = createHarness();

  h.ops.maybeRefreshViewOnly(h.state.session);
  await h.flush();
  assert.equal(h.loads.length, 1, "self-heal must start the first view-only fetch");

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta_kind: "agent_text",
    turn_id: "turn-1",
    delta: "Hello world",
    text_offset: 0,
  });
  assert.equal(h.state.viewOnlyThread.wasWorking, true);

  const idleSession = session();
  h.state.session = idleSession;
  h.completePendingFetch();
  await h.flush();

  assert.equal(
    h.loads.length,
    2,
    "maybeRefreshViewOnly must call loadViewOnlyTranscript again after the first fetch completes"
  );
  assert.equal(h.loads[1].threadId, BG_THREAD);
  assert.equal(h.state.viewOnlyThread.wasWorking, true, "the edge must survive until the terminal fetch");
});

test("a refused delta's tailGap triggers immediate loadViewOnlyTranscript", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    lastRefreshAt: Date.now(),
    loading: false,
  };

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta: "tail",
    text_offset: 99,
  });
  assert.equal(h.state.viewOnlyThread.tailGap, true);

  h.ops.maybeRefreshViewOnly(h.state.session);
  await h.flush();

  assert.equal(h.loads.length, 1, "needsRepair must fetch immediately");
  assert.equal(h.loads[0].threadId, BG_THREAD);
});

test("tailGap survives fetch start on the loading pin", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    tailGap: true,
    lastRefreshAt: Date.now(),
    loading: false,
  };

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();

  assert.equal(h.state.viewOnlyThread.loading, true);
  assert.equal(h.state.viewOnlyThread.tailGap, true);
});

test("pre-fetch tailGap clears after repair fetch completes", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    tailGap: true,
    lastRefreshAt: Date.now(),
    loading: false,
  };

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();
  assert.equal(h.state.viewOnlyThread.loading, true);
  assert.equal(h.state.viewOnlyThread.tailGap, true);

  h.completePendingFetch();
  await h.flush();

  assert.ok(
    !h.state.viewOnlyThread.tailGap,
    "a repair fetch that answered the pre-fetch gap must clear tailGap"
  );

  const loadsBefore = h.loads.length;
  h.ops.maybeRefreshViewOnly(h.state.session);
  await h.flush();

  assert.equal(
    h.loads.length,
    loadsBefore,
    "maybeRefreshViewOnly must not re-arm fetch after the gap was repaired"
  );
});

test("tailGap raised during an in-flight fetch survives fetch completion", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    lastRefreshAt: Date.now(),
    loading: false,
  };

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();
  assert.equal(h.state.viewOnlyThread.loading, true);

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta: "tail",
    text_offset: 99,
  });
  assert.equal(h.state.viewOnlyThread.tailGap, true);

  h.completePendingFetch();
  await h.flush();

  assert.equal(
    h.state.viewOnlyThread.tailGap,
    true,
    "a stale page must not clear a gap the reducer raised during the fetch"
  );
  assert.ok(h.loads.length >= 1, "the first fetch must settle");
});

function pinnedThread(extra = {}) {
  return {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    lastRefreshAt: Date.now(),
    loading: false,
    ...extra,
  };
}

// Nothing on this path is throttled. `shouldRefreshViewedThread` takes
// `elapsedMs` and `historyLoading` and reads neither, and it answers `needsRepair`
// before it looks at anything else -- the 300ms poll that used to pace this was
// deleted on purpose. So an uncleared gap arms a fetch on every render frame, and
// "a settled fetch clears it" is the only thing that ends a repair. A failed
// fetch has settled too: the error pin and its retry backoff are what handle the
// failure, not a gap left armed at frame rate.
test("a pre-fetch tailGap is cleared by a repair fetch that FAILS", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = pinnedThread({ tailGap: true });

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();
  assert.equal(h.state.viewOnlyThread.loading, true);
  assert.equal(h.state.viewOnlyThread.tailGap, true, "the gap rides the loading pin");

  h.failPendingFetch();
  await h.flush();

  assert.equal(h.state.viewOnlyThread.error, true, "the failure is reported on the pin");
  assert.ok(
    !h.state.viewOnlyThread.tailGap,
    "a settled fetch answers the gap whether it succeeded or failed"
  );

  const settled = h.loads.length;
  for (let render = 0; render < 5; render += 1) {
    h.ops.maybeRefreshViewOnly(h.state.session);
    await h.flush();
  }
  assert.equal(h.loads.length, settled, "a cleared gap must not re-arm on later renders");
});

test("a tailGap raised during a fetch survives that fetch FAILING", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = pinnedThread();

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();
  assert.equal(h.state.viewOnlyThread.loading, true);

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta: "tail",
    text_offset: 99,
  });
  assert.equal(h.state.viewOnlyThread.tailGap, true);
  assert.equal(h.state.viewOnlyThread.deltaDuringFetch, true);

  h.failPendingFetch();
  await h.flush();

  assert.equal(
    h.state.viewOnlyThread.tailGap,
    true,
    "a fetch that failed cannot have answered a hole raised while it was in flight"
  );
});

test("a settled repair converges: later renders arm nothing", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = pinnedThread({ tailGap: true });

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();
  h.completePendingFetch();
  await h.flush();
  assert.ok(!h.state.viewOnlyThread.tailGap);

  const settled = h.loads.length;
  for (let render = 0; render < 5; render += 1) {
    h.ops.maybeRefreshViewOnly(h.state.session);
    await h.flush();
  }

  assert.equal(h.loads.length, settled, "one repair per gap, not one per frame");
});

test("a gap that outlived its fetch is repaired by the next one, then stops", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = pinnedThread();

  void h.ops.loadViewOnlyTranscript(BG_THREAD);
  await h.flush();
  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta: "tail",
    text_offset: 99,
  });
  h.completePendingFetch();
  await h.flush();
  assert.equal(h.state.viewOnlyThread.tailGap, true, "the gap outlived the fetch");
  // The settle re-renders, and that render is what arms the repair -- so the
  // chain is one fetch per surviving gap. It terminates only because the next
  // fetch refuses no delta; nothing else would stop it.
  assert.equal(h.loads.length, 2, "the settle's own render arms exactly one repair");

  // No delta is refused this time, so this one answers it for good.
  h.completePendingFetch();
  await h.flush();
  assert.ok(!h.state.viewOnlyThread.tailGap);

  const settled = h.loads.length;
  for (let render = 0; render < 5; render += 1) {
    h.ops.maybeRefreshViewOnly(h.state.session);
    await h.flush();
  }
  assert.equal(h.loads.length, settled, "the repair chain terminates");
});

test("a delta during a terminal fetch preserves wasWorking for a second idle refresh", async () => {
  const h = createHarness();
  h.state.viewOnlyThread = {
    threadId: BG_THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "running" }],
    wasWorking: true,
    lastRefreshAt: Date.now(),
    loading: false,
  };

  void h.ops.loadViewOnlyTranscript(BG_THREAD, { terminal: true });
  await h.flush();
  assert.equal(h.loads.length, 1);
  assert.equal(h.loads[0].terminal, true);

  h.stream.applySessionStreamEvent("transcript_entry_delta", {
    thread_id: BG_THREAD,
    item_id: "item-1",
    delta_kind: "agent_text",
    turn_id: "turn-1",
    delta: " more",
    text_offset: 5,
  });
  assert.equal(h.state.viewOnlyThread.wasWorking, true);
  assert.equal(h.state.viewOnlyThread.deltaDuringFetch, true);

  h.completePendingFetch();
  await h.flush();

  assert.equal(
    h.state.viewOnlyThread.wasWorking,
    true,
    "a delta during the terminal fetch must not be clobbered at completion"
  );

  h.ops.maybeRefreshViewOnly(session());
  await h.flush();

  assert.equal(h.loads.length, 2, "the second idle edge must arm another terminal fetch");
});

test("a resync that lands mid-fetch re-reads only if the fetched page predates it", async () => {
  for (const [pageRevision, expectedLoads] of [[6, 2], [7, 1]]) {
    const h = createHarness();
    h.ops.maybeRefreshViewOnly(h.state.session);
    await h.flush();
    assert.equal(h.loads.length, 1);

    h.stream.applySessionStreamEvent("transcript_resync", {
      thread_id: BG_THREAD,
      revision: 7,
      reason: "rows_not_streamed",
    });
    h.completePendingFetch({
      thread_id: BG_THREAD,
      entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "done" }],
      prev_cursor: null,
      revision: pageRevision,
    });
    await h.flush();

    assert.equal(h.loads.length, expectedLoads, `page at revision ${pageRevision}`);
  }
});
