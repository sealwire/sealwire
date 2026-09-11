// The Orchestrator pane keeps its own entries buffer, written by three paths:
// a live delta, an older page, and a refreshed tail. The older/tail paths reuse
// the view-only merges and were carried over with them; the DELTA path appends
// to a plain array and is the last positional guess in the buffer.
//
// Generation ownership (orchestratorEntriesGeneration) and in-flight load
// cancellation (orchestratorLoadGeneration) sit above ordering and are asserted
// here to stay that way.
import test from "node:test";
import assert from "node:assert/strict";

import { applyDeltaToViewOnlyPin } from "./view-only-thread.js";
import {
  applyOlderOrchestratorPage,
  applyRefreshedOrchestratorPage,
} from "./orchestrator-transcript-refresh.js";

const S = 1 << 20;

function row(itemId, orderSeq, extra = {}) {
  return {
    item_id: itemId,
    order_seq: orderSeq,
    kind: "agent_text",
    text: itemId,
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    ...extra,
  };
}

function deltaFor(itemId, orderSeq, text, extra = {}) {
  return {
    thread_id: "orch",
    item_id: itemId,
    order_seq: orderSeq,
    entry_seq: 7,
    delta: text,
    delta_kind: "agent_text",
    text_offset: 0,
    turn_id: "turn-1",
    ...extra,
  };
}

function orchestratorState(entries, extra = {}) {
  return {
    session: { transcript_generation: "gen-a" },
    orchestratorEntries: entries,
    orchestratorEntriesThreadId: "orch",
    orchestratorEntriesGeneration: "gen-a",
    orchestratorOlderCursor: "cursor",
    orchestratorHistoryExtended: false,
    ...extra,
  };
}

test("a delta for a mid-numbered row lands in its slot in the Orchestrator buffer", () => {
  const pin = { threadId: "orch", entries: [row("a", 0), row("c", 2 * S)] };

  const next = applyDeltaToViewOnlyPin(pin, deltaFor("b", S, "born earlier, streamed later"));

  assert.deepEqual(next.entries.map((entry) => entry.item_id), ["a", "b", "c"]);
  assert.equal(next.entries[1].order_seq, S, "the number must be recorded, not just used");
});

test("an unnumbered Orchestrator buffer still appends, so an old relay degrades", () => {
  const unnumbered = (id) => {
    const entry = row(id, 0);
    delete entry.order_seq;
    return entry;
  };
  const pin = { threadId: "orch", entries: [unnumbered("a"), unnumbered("c")] };

  const next = applyDeltaToViewOnlyPin(pin, { ...deltaFor("b", undefined, "x"), order_seq: undefined });

  assert.deepEqual(next.entries.map((entry) => entry.item_id), ["a", "c", "b"]);
});

test("an older Orchestrator page interleaves by number and keeps generation ownership", () => {
  const state = orchestratorState([row("b", -S), row("d", S)]);

  const merged = applyOlderOrchestratorPage(state, "orch", {
    thread_id: "orch",
    transcript_generation: "gen-a",
    entries: [row("a", -2 * S), row("c", 0)],
    prev_cursor: 4,
  });

  assert.deepEqual(merged.entries.map((entry) => entry.item_id), ["a", "b", "c", "d"]);
  assert.equal(state.orchestratorOlderCursor, 4);

  // A page from another run must still be refused outright, ordering or not.
  const foreign = applyOlderOrchestratorPage(
    { ...state, orchestratorEntriesGeneration: "gen-b" },
    "orch",
    { thread_id: "orch", transcript_generation: "gen-a", entries: [row("z", -9 * S)], prev_cursor: null }
  );
  assert.equal(foreign, null, "a cross-generation page is refused, not merged");
});

test("a refreshed Orchestrator tail keeps the reader's history and stamps the generation", () => {
  const state = orchestratorState([row("a", 0), row("live", 2 * S)], {
    orchestratorHistoryExtended: true,
    orchestratorOlderCursor: 3,
  });
  const prior = {
    threadId: "orch",
    entries: state.orchestratorEntries,
    olderCursor: 3,
    historyExtended: true,
  };

  const refreshed = applyRefreshedOrchestratorPage(state, prior, {
    thread_id: "orch",
    entries: [row("b", S), row("c", 3 * S)],
    prev_cursor: 9,
  }, "orch");

  assert.deepEqual(
    refreshed.entries.map((entry) => entry.item_id),
    ["a", "b", "live", "c"],
    "a tail page is authoritative for its own rows, not for where the rest sit"
  );
  assert.equal(state.orchestratorEntriesGeneration, "gen-a", "every write restamps ownership");
  assert.equal(state.orchestratorEntriesThreadId, "orch");
});
