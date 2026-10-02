import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExpandedTranscriptDetailEntries,
  cacheTranscriptEntryDetail,
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


const summary = (text, extra, clipped = false) => ({
  row_id: "agent:summary",
  item_id: "agent:summary",
  kind: "agent_text",
  status: "completed",
  content_state: "full",
  text,
  injection: { kind: "handover_summary", handover: { id: "h", status: "done" }, ...(clipped ? { text_clipped: true } : {}) },
  ...extra,
});

function cache(state, entry) {
  const result = cacheTranscriptEntryDetail(state, "thread-1", entry);
  if (result.patch) Object.assign(state, result.patch);
  return result;
}

// A card row is fetched for its body like a tool call is for its output.
test("a card's fetched body is held whole, and the list's short copy never passes for it", () => {
  const state = createState();
  assert.equal(cache(state, summary("## Goal\nPart", {}, true)).cached, true);
  assert.equal(
    getFullTranscriptEntryDetail(state, "thread-1", "agent:summary"),
    null,
    "a copy the relay says it shortened is not the body"
  );

  cache(state, summary("## Goal\nPart and the rest"));
  assert.equal(getFullTranscriptEntryDetail(state, "thread-1", "agent:summary")?.text, "## Goal\nPart and the rest");
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, {
      autoDetailItemIds: ["agent:summary"],
      threadId: "thread-1",
    }).get("agent:summary")?.text,
    "## Goal\nPart and the rest"
  );
});

// Only tool rows grow while they run; a card's text row is not parked as its own detail.
test("a snapshot does not park a running card row as if it were its detail", () => {
  const state = createState();
  sync(state, summary("## Goal\nStill wri", { status: "in_progress" }));
  assert.equal(getLiveTranscriptEntryDetail(state, "thread-1", "agent:summary"), null);
});

// The phone caches each page row as it lands; a page's short copy must not replace the
// body already fetched for that row.
test("a page's short copy never replaces a body already held whole", () => {
  const state = createState();
  cache(state, summary("## Goal\nPart and the rest"));
  cache(state, summary("## Goal\nPart", {}, true));
  assert.equal(getFullTranscriptEntryDetail(state, "thread-1", "agent:summary")?.text, "## Goal\nPart and the rest");
});
