import test from "node:test";
import assert from "node:assert/strict";

import {
  applyOlderOrchestratorPage,
  applyRefreshedOrchestratorPage,
  orchestratorRefreshPin,
} from "./orchestrator-transcript-refresh.js";

// The bug this pins, reported as "scroll up, the page appears, then it vanishes
// and gets fetched again": a refresh that waited behind the older-history
// request runs one tick after it, and its merge keeps the paged-in prefix only
// when `historyExtended` says a reader scrolled. The pane never carried that
// flag, so every refresh took the "nobody scrolled" branch.

const THREAD = "orch-1";

function paneShowing(entries, olderCursor) {
  return {
    orchestratorEntriesThreadId: THREAD,
    orchestratorEntries: entries,
    orchestratorOlderCursor: olderCursor,
  };
}

function scrolledUp() {
  const state = paneShowing([{ item_id: "newest", entry_seq: 2 }], "cursor-1");
  applyOlderOrchestratorPage(state, THREAD, {
    thread_id: THREAD,
    entries: [{ item_id: "older", entry_seq: 1 }],
    prev_cursor: "cursor-2",
  });
  return state;
}

// The tail page the server keeps answering with: it covers the newest entry
// only, so everything the reader paged in above it is outside its window.
const TAIL_PAGE = {
  thread_id: THREAD,
  entries: [{ item_id: "newest", entry_seq: 2 }],
  prev_cursor: "cursor-1",
};

function refresh(state) {
  const prior = orchestratorRefreshPin(state, THREAD);
  applyRefreshedOrchestratorPage(state, prior, TAIL_PAGE, THREAD);
}

function assertHistoryKept(state) {
  assert.deepEqual(
    state.orchestratorEntries.map((entry) => entry.item_id),
    ["older", "newest"]
  );
  assert.equal(
    state.orchestratorOlderCursor,
    "cursor-2",
    "a rewound cursor refetches the page the reader just loaded"
  );
}

test("a refresh right after an older page keeps what the reader paged in", () => {
  const state = scrolledUp();
  refresh(state);
  assertHistoryKept(state);
});

// The refresh that discards it need not be the first one: while the Orchestrator
// is working its tail is refetched repeatedly, so the flag has to survive each
// merge, not just be present going into one.
test("and keeps it across a second refresh", () => {
  const state = scrolledUp();
  refresh(state);
  refresh(state);
  assertHistoryKept(state);
});

// An older page the merge declines — a stale response from before a thread
// switch — is meant to leave the pane exactly as it was, so it must not cost the
// reader the history they already loaded one refresh later.
test("an ignored older page leaves the paged-in history alone", () => {
  const state = scrolledUp();

  applyOlderOrchestratorPage(state, THREAD, {
    thread_id: "another-thread",
    entries: [{ item_id: "someone-elses", entry_seq: 9 }],
    prev_cursor: "cursor-9",
  });
  refresh(state);

  assertHistoryKept(state);
});
