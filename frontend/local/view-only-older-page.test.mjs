import assert from "node:assert/strict";
import test from "node:test";

import { relayError } from "../shared/transcript-protocol.js";
import { createViewOnlyRefreshOps } from "./view-only-refresh-ops.js";

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function pinHarness({ fetchOlder, waitBeforeHistoryRetry = async () => {} }) {
  const state = {
    session: {
      active_thread_id: "thread-live",
      transcript: [],
      transcript_revision: 1,
      thread_activity: [],
    },
    viewThreadId: "thread-bg",
    viewOnlyGeneration: 1,
    viewOnlyThread: {
      threadId: "thread-bg",
      entries: [
        { item_id: "scrolled-in", kind: "agent_text", text: "Old", status: "done", order_seq: 0 },
      ],
      olderCursor: "tc1.held.0",
      historyExtended: true,
      generation: 1,
      relayGeneration: "",
      loading: false,
      lastRefreshAt: Date.now(),
    },
  };
  const requested = [];
  const ops = createViewOnlyRefreshOps({
    getState: () => state,
    fetchTranscriptPage: async (threadId, { before = null } = {}) => {
      requested.push(before);
      if (before != null) {
        return fetchOlder(requested.length);
      }
      return {
        thread_id: threadId,
        entries: [
          { item_id: "tail", kind: "agent_text", text: "Tail", status: "done", order_seq: 1048576 },
        ],
        prev_cursor: "tc1.fresh.0",
        revision: 3,
      };
    },
    renderSession: () => {},
    logLine: () => {},
    findVisible: () => null,
    reviewSignature: () => null,
    syncWatchedThreads: () => {},
    getOrchestratorWatchIds: () => [],
    isReviewInProgressForThread: () => false,
    isWorkflowInProgressForThread: () => false,
    waitBeforeHistoryRetry,
  });
  return { state, requested, ops };
}

// Retrying a cursor the relay can no longer read sends the same dead cursor forever;
// the pin has to start over from the latest page, which mints a cursor that works.
test("a rejected older-page cursor reloads the pin from its latest page", async () => {
  const { state, requested, ops } = pinHarness({
    fetchOlder: () => {
      throw relayError("transcript cursor has expired", "transcript_cursor_rejected");
    },
  });

  assert.equal(await ops.loadOlderViewOnlyTranscript(), null);
  await settle();

  assert.deepEqual(requested, ["tc1.held.0", null]);
  assert.equal(state.viewOnlyThread.olderCursor, "tc1.fresh.0");
  assert.deepEqual(state.viewOnlyThread.entries.map((entry) => entry.item_id), ["tail"]);
});

test("an older page the relay is still reading is asked for again without a new gesture", async () => {
  const { state, requested, ops } = pinHarness({
    fetchOlder: (attempt) => {
      if (attempt === 1) {
        throw relayError("still reading", "transcript_history_pending");
      }
      return {
        thread_id: "thread-bg",
        entries: [
          { item_id: "older", kind: "agent_text", text: "Older", status: "done", order_seq: -1048576 },
        ],
        prev_cursor: null,
      };
    },
  });

  assert.equal(await ops.loadOlderViewOnlyTranscript(), false, "the oldest page arrived");
  assert.deepEqual(requested, ["tc1.held.0", "tc1.held.0"]);
  assert.deepEqual(
    state.viewOnlyThread.entries.map((entry) => entry.item_id),
    ["older", "scrolled-in"]
  );
});

test("leaving the pinned thread during the wait stops asking for its page", async () => {
  const harness = pinHarness({
    fetchOlder: () => {
      throw relayError("still reading", "transcript_history_pending");
    },
    waitBeforeHistoryRetry: async () => {
      harness.state.viewThreadId = "thread-other";
    },
  });

  assert.equal(await harness.ops.loadOlderViewOnlyTranscript(), null);
  assert.deepEqual(harness.requested, ["tc1.held.0"]);
});
