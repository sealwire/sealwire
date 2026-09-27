import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExpandedTranscriptDetailEntries,
  getFullTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  prepareTranscriptEntryForSurface,
  setLiveTranscriptEntryDetail,
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./transcript-entry-details-state.js";

function createState() {
  return {
    transcriptEntryDetailCache: new Map(),
    transcriptEntryDetailOrder: [],
    transcriptLiveEntryDetails: new Map(),
    transcriptLiveEntryThreadId: null,
  };
}

function sync(state, entry) {
  const { patch } = syncLiveTranscriptEntryDetailsFromSnapshot(state, {
    active_thread_id: "thread-1",
    transcript: [entry],
  });
  if (patch) Object.assign(state, patch);
}

function set(state, entry) {
  const { patch } = setLiveTranscriptEntryDetail(state, "thread-1", entry);
  if (patch) Object.assign(state, patch);
}

const bash = (status, content_state, result) => ({
  item_id: "tool:bash-1",
  kind: "tool_call",
  status,
  content_state,
  tool: { item_type: "toolCall", name: "Bash", command: "npm test", result_preview: result },
});

// Watched live: the row is complete while it runs, then fails with an output the
// snapshot has to cut. The earlier "complete" must not vouch for the later cut copy.
test("a row seen running and then failing cut is not taken for the full body", () => {
  const state = createState();
  sync(state, bash("running", "full", ""));
  sync(state, bash("failed", "preview", "Exit code 1\nhead..."));
  assert.equal(getFullTranscriptEntryDetail(state, "thread-1", "tool:bash-1"), null);
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, { autoDetailItemIds: ["tool:bash-1"], threadId: "thread-1" }).size,
    0
  );
});

test("a fetched body stays full across later cut copies, until the row moves on", () => {
  const state = createState();
  sync(state, bash("failed", "preview", "Exit code 1\nhead..."));
  set(state, bash("failed", "full", "Exit code 1\nhead\nbody\ntail"));
  sync(state, bash("failed", "preview", "Exit code 1\nhead..."));
  assert.equal(
    getFullTranscriptEntryDetail(state, "thread-1", "tool:bash-1")?.tool?.result_preview,
    "Exit code 1\nhead\nbody\ntail"
  );

  const running = createState();
  set(running, bash("running", "full", "partial so far"));
  sync(running, bash("failed", "preview", "Exit code 1\nlonger head..."));
  assert.equal(
    getFullTranscriptEntryDetail(running, "thread-1", "tool:bash-1"),
    null,
    "a body fetched while running is not the body it ended with"
  );
});

// Opening a finished row must not show the output-less copy it had while running.
test("a row that finishes drops the copy it was parked under while running", () => {
  const state = createState();
  sync(state, bash("running", "full", ""));
  sync(state, bash("completed", "full", "ok"));
  assert.equal(getLiveTranscriptEntryDetail(state, "thread-1", "tool:bash-1"), null);
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, {
      expandedItemIds: new Set(["entry:tool:bash-1"]),
      threadId: "thread-1",
    }).get("tool:bash-1")?.status,
    undefined
  );
});

// The remote surface squeezes a command's text to one line; that copy is cut.
test("a command squeezed for the surface says it is cut", () => {
  const long = `npm test\n${"x".repeat(400)}`;
  const failed = prepareTranscriptEntryForSurface(createState(), "thread-1", {
    item_id: "cmd-1",
    kind: "command",
    status: "failed",
    content_state: "full",
    text: long,
  }).entry;
  assert.equal(failed.content_state, "preview");

  const short = prepareTranscriptEntryForSurface(createState(), "thread-1", {
    item_id: "cmd-2",
    kind: "command",
    status: "failed",
    content_state: "full",
    text: "ls",
  }).entry;
  assert.equal(short.content_state, "full", "nothing was cut, so nothing is claimed");
});

