import assert from "node:assert/strict";
import test from "node:test";
import { createViewOnlyRefreshOps } from "./view-only-refresh-ops.js";
import { applyDeltaToViewOnlyPin } from "./view-only-thread.js";
import { clearTranscriptHydration } from "./transcript/store.js";
import { relayError } from "../shared/transcript-protocol.js";

function harness() {
  const state = {
    session: { active_thread_id: "live", transcript_generation: "run-1", thread_activity: [] },
    viewThreadId: "a",
    viewOnlyGeneration: 0,
    viewOnlyThread: null,
  };
  const pending = [];
  const ops = createViewOnlyRefreshOps({
    getState: () => state,
    fetchTranscriptPage: (threadId, options) => new Promise((resolve, reject) => {
      pending.push({ threadId, options, resolve, reject });
    }),
    renderSession: () => {},
  });
  return { state, pending, ops };
}

function page(threadId, text, { cursor = null, revision = 1 } = {}) {
  return {
    thread_id: threadId,
    transcript_generation: "run-1",
    revision,
    entries: [{ item_id: `${threadId}-1`, kind: "agent_text", text, status: "running", turn_id: "turn-1" }],
    prev_cursor: cursor,
  };
}

function numberedPage(start, end) {
  return {
    thread_id: "a", transcript_generation: "run-1", revision: 2,
    prev_cursor: start ? `before-${start}` : null,
    entries: Array.from({ length: end - start }, (_, offset) => ({
      item_id: `a-${start + offset}`, order_seq: (start + offset) * 1048576,
      kind: "agent_text", text: `message ${start + offset}`, status: "completed",
    })),
  };
}

for (const becameLive of [false, true]) {
  test(`a cached window reconnects to a nearby tail after ${becameLive ? "becoming live" : "running in the background"}`, async () => {
    const { state, pending, ops } = harness();
    const first = ops.loadViewOnlyTranscript("a");
    pending.shift().resolve(numberedPage(20, 30));
    await first;
    const older = ops.loadOlderViewOnlyTranscript();
    pending.shift().resolve(numberedPage(10, 20));
    await older;

    if (becameLive) state.session.active_thread_id = "a";
    else state.viewThreadId = "live";
    ops.maybeRefreshViewOnly(state.session);
    assert.equal(state.viewOnlyThread, null);
    state.session.active_thread_id = "live";
    state.viewThreadId = "a";
    const returning = ops.loadViewOnlyTranscript("a");
    assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(10, 30).entries.map(row => row.item_id));
    pending.shift().resolve(numberedPage(50, 60));
    await Promise.resolve();
    for (let start = 40; start >= 20; start -= 10) {
      const request = pending.shift();
      assert.ok(request, "the missing middle must be fetched before retaining the old history cursor");
      assert.equal(request.options.before, `before-${start + 10}`);
      request.resolve(numberedPage(start, start + 10));
      for (let tick = 0; tick < 8; tick++) await Promise.resolve();
    }
    await returning;
    assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(10, 60).entries.map(row => row.item_id));
    assert.equal(state.viewOnlyThread.olderCursor, "before-10");
    const oldest = ops.loadOlderViewOnlyTranscript();
    assert.equal(pending[0].options.before, "before-10");
    pending.shift().resolve(numberedPage(0, 10));
    await oldest;
    assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(0, 60).entries.map(row => row.item_id));
  });
}

function retainedWindow(state) {
  state.viewOnlyThread = {
    threadId: "a", relayGeneration: "run-1", generation: 0, loading: false,
    entries: numberedPage(10, 30).entries, olderCursor: "before-10", historyExtended: true,
  };
}

async function settle() {
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
}

test("a very large gap gives way to the latest page after three history reads", async () => {
  const { state, pending, ops } = harness();
  retainedWindow(state);
  const returning = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(numberedPage(5000, 5010));
  await settle();
  state.viewOnlyThread = applyDeltaToViewOnlyPin(state.viewOnlyThread, {
    thread_id: "a", transcript_generation: "run-1", item_id: "a-5010", turn_id: "turn-new",
    delta_kind: "agent_text", text_offset: 0, delta: "message 5010", order_seq: 5010 * 1048576,
  });
  for (const start of [4990, 4980, 4970]) {
    const request = pending.shift();
    assert.equal(request.options.before, `before-${start + 10}`);
    request.resolve(numberedPage(start, start + 10));
    await settle();
  }
  assert.equal(pending.length, 0, "automatic backfill must stop after three reads");
  await returning;
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(5000, 5011).entries.map(row => row.item_id), "the latest page and a new streamed row survive dropping disconnected history");
  assert.equal(state.viewOnlyThread.olderCursor, "before-5000");
  assert.equal(state.viewOnlyThread.historyExtended, false);
  const older = ops.loadOlderViewOnlyTranscript();
  assert.equal(pending[0].options.before, "before-5000", "the missing middle is reachable from the latest page's cursor");
  pending.shift().resolve(numberedPage(4990, 5000));
  await older;
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(4990, 5011).entries.map(row => row.item_id));
});

test("a pending history read does not delay the latest page with repeated retries", async () => {
  const { state, pending, ops } = harness();
  retainedWindow(state);
  const returning = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(numberedPage(5000, 5010));
  await settle();
  pending.shift().reject(relayError("still reading history", "transcript_history_pending"));
  await returning;
  assert.equal(pending.length, 0);
  assert.equal(state.viewOnlyThread.loading, false);
  assert.equal(state.viewOnlyThread.error, false);
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(5000, 5010).entries.map(row => row.item_id));
  assert.equal(state.viewOnlyThread.olderCursor, "before-5000");
});

test("a failed gap page settles on the saved window and a subsequent retry can finish", async () => {
  const { state, pending, ops } = harness();
  retainedWindow(state);
  const returning = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(numberedPage(50, 60));
  await settle();
  pending.shift().reject(new Error("history unavailable"));
  await returning;
  assert.equal(state.viewOnlyThread.loading, false);
  assert.equal(state.viewOnlyThread.error, true);
  assert.equal(state.viewOnlyThread.loadError, "history unavailable");
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(10, 30).entries.map(row => row.item_id));
  assert.equal(state.viewOnlyThread.olderCursor, "before-10");
  ops.maybeRefreshViewOnly(state.session);
  assert.equal(pending.length, 0, "a failed read must settle before any later retry");
  const retry = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(numberedPage(50, 60));
  await settle();
  for (const start of [40, 30, 20]) {
    pending.shift().resolve(numberedPage(start, start + 10));
    await settle();
  }
  await retry;
  assert.equal(pending.length, 0);
  assert.equal(state.viewOnlyThread.error, false);
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.item_id), numberedPage(10, 60).entries.map(row => row.item_id));
});

test("leaving a tab during gap backfill cannot overwrite the newer tab", async () => {
  const { state, pending, ops } = harness();
  state.viewOnlyThread = {
    threadId: "a", relayGeneration: "run-1", generation: 0, loading: false,
    entries: numberedPage(10, 30).entries, olderCursor: "before-10", historyExtended: true,
  };
  const returning = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(numberedPage(90, 100));
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  const backfill = pending.shift();
  assert.equal(backfill.options.before, "before-90");
  state.viewThreadId = "b";
  const newer = ops.loadViewOnlyTranscript("b");
  pending.shift().resolve(page("b", "newer tab"));
  await newer;
  backfill.resolve(numberedPage(80, 90));
  await returning;
  assert.equal(state.viewOnlyThread.threadId, "b");
  assert.equal(state.viewOnlyThread.entries[0].text, "newer tab");
  assert.equal(pending.length, 0, "backfill stops when the viewed thread changes");
});

test("switching tabs restores loaded older rows before the new tail arrives", async () => {
  const { state, pending, ops } = harness();
  const first = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(page("a", "tail", { cursor: "older" }));
  await first;
  const older = ops.loadOlderViewOnlyTranscript();
  const request = pending.shift();
  assert.equal(request.options.before, "older");
  request.resolve({ ...page("a", "history"), entries: [{ item_id: "a-old", kind: "user_text", text: "history" }] });
  await older;

  state.viewThreadId = "b";
  ops.maybeRefreshViewOnly(state.session);
  pending.shift().resolve(page("b", "other tab"));
  await Promise.resolve();
  state.viewThreadId = "a";
  ops.maybeRefreshViewOnly(state.session);
  assert.equal(state.viewOnlyThread.loading, true);
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.text), ["history", "tail"]);
  assert.equal(state.viewOnlyThread.historyExtended, true);
  assert.equal(state.viewOnlyThread.olderCursor, null);
  assert.equal(pending.length, 1, "the latest tail is still fetched");
  pending.shift().resolve(page("a", "fresh tail", { revision: 2 }));
  await Promise.resolve();
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.text), ["history", "fresh tail"]);
});

test("rapid A-B-A navigation and a streamed delta survive a stale tail response", async () => {
  const { state, pending, ops } = harness();
  const first = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(page("a", "Hello"));
  await first;
  state.viewThreadId = "b";
  const b = ops.loadViewOnlyTranscript("b");
  state.viewThreadId = "a";
  const a = ops.loadViewOnlyTranscript("a");
  assert.equal(state.viewOnlyThread.entries[0].text, "Hello");
  state.viewOnlyThread = applyDeltaToViewOnlyPin(state.viewOnlyThread, {
    thread_id: "a", transcript_generation: "run-1", item_id: "a-2", turn_id: "turn-1",
    base_revision: 1, revision: 2, delta_kind: "agent_text", text_offset: 0, delta: "streamed next row",
  });
  pending[1].resolve(page("a", "Hello"));
  await a;
  pending[0].resolve(page("b", "late B"));
  await b;
  assert.equal(state.viewOnlyThread.threadId, "a");
  assert.deepEqual(state.viewOnlyThread.entries.map(row => row.text), ["Hello", "streamed next row"]);
});

test("a pin's last server-read row survives deltas, loading, older pages and a failed refresh", async () => {
  const { state, pending, ops } = harness();
  const first = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(numberedPage(20, 30));
  await first;
  const returning = ops.loadViewOnlyTranscript("a");
  assert.equal(state.viewOnlyThread.lastReadOrderSeq, 29 * 1048576);
  state.viewOnlyThread = applyDeltaToViewOnlyPin(state.viewOnlyThread, {
    thread_id: "a", transcript_generation: "run-1", item_id: "a-40", order_seq: 40 * 1048576,
    turn_id: "turn-1", delta_kind: "agent_text", text_offset: 0, delta: "streamed ahead",
  });
  pending.shift().resolve(numberedPage(25, 35));
  await returning;
  assert.equal(state.viewOnlyThread.entries.at(-1).item_id, "a-40");
  assert.equal(state.viewOnlyThread.lastReadOrderSeq, 34 * 1048576, "merged deltas must not advance the server-read boundary");
  const older = ops.loadOlderViewOnlyTranscript();
  pending.shift().resolve(numberedPage(15, 25));
  await older;
  assert.equal(state.viewOnlyThread.lastReadOrderSeq, 34 * 1048576);
  const failed = ops.loadViewOnlyTranscript("a");
  pending.shift().reject(new Error("offline"));
  await failed;
  assert.equal(state.viewOnlyThread.lastReadOrderSeq, 34 * 1048576);
});

test("a failed background refresh keeps cached messages visible", async () => {
  const { state, pending, ops } = harness();
  const first = ops.loadViewOnlyTranscript("a");
  pending.shift().resolve(page("a", "cached"));
  await first;
  state.viewThreadId = "live";
  ops.maybeRefreshViewOnly(state.session);
  state.viewThreadId = "a";
  const restored = ops.loadViewOnlyTranscript("a");
  pending.shift().reject(new Error("offline"));
  await restored;
  assert.equal(state.viewOnlyThread.entries[0].text, "cached");
  assert.equal(state.viewOnlyThread.loadError, "offline");
});

for (const reset of ["relay restart", "session teardown"]) {
  test(`${reset} drops cached messages before a tab is restored`, async () => {
    const { state, pending, ops } = harness();
    const first = ops.loadViewOnlyTranscript("a");
    pending.shift().resolve(page("a", "old run"));
    await first;
    state.viewThreadId = "live";
    ops.maybeRefreshViewOnly(state.session);
    if (reset === "relay restart") state.session.transcript_generation = "run-2";
    else clearTranscriptHydration(state);
    state.viewThreadId = "a";
    const next = ops.loadViewOnlyTranscript("a");
    assert.deepEqual(state.viewOnlyThread.entries, []);
    pending.shift().resolve({ ...page("a", "new run"), transcript_generation: state.session.transcript_generation });
    await next;
    assert.equal(state.viewOnlyThread.entries[0].text, "new run");
  });
}
