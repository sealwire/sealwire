// The Orchestrator buffer is a plain array plus a thread id, so before this it had no
// way to say WHICH run of the relay minted the ids in it. A restart renumbers them,
// and the delta path would then append a second row for messages already buffered.
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyOlderOrchestratorPage,
  applyRefreshedOrchestratorPage,
} from "./orchestrator-transcript-refresh.js";

const THREAD = "orchestrator-thread";

function stateHolding(generation, entries) {
  return {
    session: { active_thread_id: "other", transcript_generation: generation },
    orchestratorEntries: entries,
    orchestratorEntriesThreadId: THREAD,
    orchestratorEntriesGeneration: generation,
    orchestratorOlderCursor: 5,
    orchestratorHistoryExtended: true,
  };
}

test("a refreshed page stamps the run that minted its ids", () => {
  const state = stateHolding("gen-a", [{ item_id: "old", kind: "user_text", text: "old" }]);
  state.session.transcript_generation = "gen-b";

  applyRefreshedOrchestratorPage(state, null, {
    thread_id: THREAD,
    entries: [{ item_id: "new", kind: "user_text", text: "new" }],
    prev_cursor: null,
  }, THREAD);

  assert.equal(state.orchestratorEntriesGeneration, "gen-b");
});

test("an older page from another run is not prepended onto this run's buffer", () => {
  const state = stateHolding("gen-b", [{ item_id: "new", kind: "user_text", text: "new" }]);

  const merged = applyOlderOrchestratorPage(state, THREAD, {
    thread_id: THREAD,
    transcript_generation: "gen-a",
    entries: [{ item_id: "old", kind: "user_text", text: "old" }],
    prev_cursor: null,
  });

  assert.equal(merged, null, "the page must be refused");
  assert.deepEqual(
    state.orchestratorEntries.map((entry) => entry.item_id),
    ["new"],
    "the buffer must be untouched"
  );
});

test("an older page from THIS run still prepends", () => {
  const state = stateHolding("gen-b", [{ item_id: "new", kind: "user_text", text: "new" }]);

  const merged = applyOlderOrchestratorPage(state, THREAD, {
    thread_id: THREAD,
    transcript_generation: "gen-b",
    entries: [{ item_id: "older", kind: "user_text", text: "older" }],
    prev_cursor: null,
  });

  assert.ok(merged, "the page must be accepted");
  assert.deepEqual(
    state.orchestratorEntries.map((entry) => entry.item_id),
    ["older", "new"]
  );
});

// The buffer itself can be from a previous run while the page is fine.
test("an older page is refused when the BUFFER is the stale side", () => {
  const state = stateHolding("gen-a", [{ item_id: "old", kind: "user_text", text: "old" }]);
  state.session.transcript_generation = "gen-b";

  const merged = applyOlderOrchestratorPage(state, THREAD, {
    thread_id: THREAD,
    transcript_generation: "gen-b",
    entries: [{ item_id: "older", kind: "user_text", text: "older" }],
    prev_cursor: null,
  });

  assert.equal(merged, null);
});
