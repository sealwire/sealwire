import assert from "node:assert/strict";
import test from "node:test";

import { createViewOnlyRefreshOps } from "./view-only-refresh-ops.js";

const THREAD = "thread-reviewer";
const REFUSAL = "workspace /repo-feature is outside this relay's allowed roots";

function createHarness() {
  const state = {
    session: { active_thread_id: "thread-live", transcript: [], thread_activity: [] },
    viewThreadId: THREAD,
    viewOnlyThread: null,
    viewOnlyGeneration: 0,
  };
  const pending = [];
  const ops = createViewOnlyRefreshOps({
    getState: () => state,
    fetchTranscriptPage: () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject })),
    renderSession: () => {},
  });
  return { state, ops, pending };
}

// A failed load must say why, and keep saying it while the automatic retry is in flight,
// or the reader sees "Loading" forever with no hint that anything went wrong.
test("a failed read-only load keeps its reason until a load succeeds", async () => {
  const h = createHarness();

  const first = h.ops.loadViewOnlyTranscript(THREAD);
  h.pending.shift().reject(new Error(REFUSAL));
  await first;
  assert.equal(h.state.viewOnlyThread.loadError, REFUSAL);

  const retry = h.ops.loadViewOnlyTranscript(THREAD);
  assert.equal(h.state.viewOnlyThread.loading, true);
  assert.equal(h.state.viewOnlyThread.loadError, REFUSAL, "still explained while retrying");

  h.pending.shift().resolve({
    thread_id: THREAD,
    entries: [{ item_id: "item-1", kind: "agent_text", text: "Hello", status: "done" }],
    prev_cursor: null,
  });
  await retry;
  assert.equal(h.state.viewOnlyThread.loadError, null);
});
