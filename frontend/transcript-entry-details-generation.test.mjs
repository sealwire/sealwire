// The detail stores are the last transcript store deciding validity by thread id
// alone. Across a restart `history-3` can name a DIFFERENT message, so a held or
// in-flight detail from the old run must never be served, merged, or spliced.
import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchTranscriptEntryDetailViaRequester } from "./shared/transcript-entry-detail.js";
import {
  cacheTranscriptEntryDetail,
  createClearedTranscriptEntryDetailsPatch,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  setLiveTranscriptEntryDetail,
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./shared/transcript-entry-details-state.js";

const THREAD = "thread-1";

function completedCommand(itemId, text) {
  return { item_id: itemId, kind: "command", status: "completed", text, tool: null, turn_id: null };
}

function runningCommand(itemId, text) {
  return { item_id: itemId, kind: "command", status: "running", text, tool: null, turn_id: null };
}

function stateAtGeneration(generation) {
  return {
    ...createClearedTranscriptEntryDetailsPatch(),
    session: { active_thread_id: THREAD, transcript_generation: generation },
  };
}

function apply(state, patch) {
  if (patch) {
    Object.assign(state, patch);
  }
}

test("a cached detail from another run is not served under the same item id", () => {
  const state = stateAtGeneration("run-a");
  apply(state, cacheTranscriptEntryDetail(state, THREAD, completedCommand("history-3", "run A body")).patch);
  assert.ok(
    getCachedTranscriptEntryDetail(state, THREAD, "history-3"),
    "the same run must still be served from cache"
  );

  state.session = { ...state.session, transcript_generation: "run-b" };
  assert.equal(
    getCachedTranscriptEntryDetail(state, THREAD, "history-3"),
    null,
    "run B's history-3 can be a different message; serving run A's detail attaches the wrong body to it"
  );
});

test("a cache write under the new run does not carry the old run's entries", () => {
  const state = stateAtGeneration("run-a");
  apply(state, cacheTranscriptEntryDetail(state, THREAD, completedCommand("history-3", "run A body")).patch);

  state.session = { ...state.session, transcript_generation: "run-b" };
  const { patch } = cacheTranscriptEntryDetail(state, THREAD, completedCommand("history-9", "run B body"));
  assert.equal(
    patch.transcriptEntryDetailCache.size,
    1,
    "the rebuilt cache must hold only the new run's entry, not inherit run A's"
  );
});

test("a live detail from another run is neither served nor merged into the new run's map", () => {
  const state = stateAtGeneration("run-a");
  apply(state, setLiveTranscriptEntryDetail(state, THREAD, runningCommand("history-3", "run A body")).patch);

  state.session = { ...state.session, transcript_generation: "run-b" };
  assert.equal(
    getLiveTranscriptEntryDetail(state, THREAD, "history-3"),
    null,
    "run B must not read run A's live detail for a same-named row"
  );

  const { patch } = setLiveTranscriptEntryDetail(state, THREAD, runningCommand("history-9", "run B body"));
  assert.equal(patch.transcriptLiveEntryDetails.size, 1, "the live map must be rebuilt, not merged across runs");
  assert.equal(patch.transcriptLiveEntryDetails.get("history-3"), undefined);
});

test("snapshot sync across a restart does not graft the old run's longer text", () => {
  const state = stateAtGeneration("run-a");
  apply(
    state,
    setLiveTranscriptEntryDetail(
      state,
      THREAD,
      runningCommand("history-3", "run A's much longer body that selectLongerString would prefer")
    ).patch
  );

  const snapshot = {
    active_thread_id: THREAD,
    transcript_generation: "run-b",
    transcript: [runningCommand("history-3", "new")],
  };
  const { patch } = syncLiveTranscriptEntryDetailsFromSnapshot(state, snapshot);
  assert.equal(
    patch.transcriptLiveEntryDetails.get("history-3").text,
    "new",
    "merging keeps the longer text, so run A's body would silently replace run B's message"
  );
});

test("detail assembly refuses a response from another run", async () => {
  const detail = await fetchTranscriptEntryDetailViaRequester({
    itemId: "history-3",
    threadId: THREAD,
    currentGeneration: () => "run-b",
    requestDetail: async () => ({
      transcript_generation: "run-a",
      entry: completedCommand("history-3", "run A body"),
      pending_fields: [],
    }),
  });
  assert.equal(detail, null, "a stale response cached under the new run poisons the new run's cache");
});

test("detail assembly refuses to splice chunks across a restart", async () => {
  let generation = "run-a";
  const responses = [
    {
      transcript_generation: "run-a",
      entry: completedCommand("history-3", "part1"),
      pending_fields: [{ field: "text", next_cursor: 5, total_chars: 10 }],
    },
    {
      transcript_generation: "run-b",
      chunk: { field: "text", text: "OTHER", next_cursor: null, total_chars: 10 },
    },
  ];
  const detail = await fetchTranscriptEntryDetailViaRequester({
    itemId: "history-3",
    threadId: THREAD,
    currentGeneration: () => generation,
    requestDetail: async () => {
      const response = responses.shift();
      // The relay restarts between the two requests.
      generation = "run-b";
      return response;
    },
  });
  assert.equal(detail, null, "a spliced body mixes two runs' content under one id");
});

test("a restart after the last chunk but before return refuses the assembled entry", async () => {
  let generation = "run-a";
  const detail = await fetchTranscriptEntryDetailViaRequester({
    itemId: "history-3",
    threadId: THREAD,
    currentGeneration: () => generation,
    requestDetail: async () => {
      const response = {
        transcript_generation: "run-a",
        entry: completedCommand("history-3", "run A body"),
        pending_fields: [],
      };
      // The relay restarts while the response is on the wire.
      generation = "run-b";
      return response;
    },
  });
  assert.equal(detail, null, "the caller caches under run B state, so run A content must not be returned");
});

test("a relay too old to stamp still assembles and serves (both sides empty)", async () => {
  const state = stateAtGeneration("");
  apply(state, cacheTranscriptEntryDetail(state, THREAD, completedCommand("item-1", "body")).patch);
  assert.ok(getCachedTranscriptEntryDetail(state, THREAD, "item-1"));

  const detail = await fetchTranscriptEntryDetailViaRequester({
    itemId: "item-1",
    threadId: THREAD,
    currentGeneration: () => "",
    requestDetail: async () => ({ entry: completedCommand("item-1", "body"), pending_fields: [] }),
  });
  assert.ok(detail, "unstamped relay + unstamped client is the pre-existing contract");
});
