import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTranscriptPage, refreshedPinPage } from "./pin-page.js";

test("a null response is an empty page, not a crash", () => {
  assert.deepEqual(normalizeTranscriptPage(null, "thread-1").entries, []);
});

// A response for the wrong thread is not an empty result — it is another
// conversation rendered under this one's header. It has to throw, so the caller
// leaves the pin alone rather than adopting someone else's transcript.
test("a page naming a different thread is refused", () => {
  assert.throws(
    () => normalizeTranscriptPage({ thread_id: "other", entries: [] }, "thread-1"),
    /thread mismatch \(expected thread-1, received other\)/
  );
  assert.throws(
    () => normalizeTranscriptPage({ thread_id: "", entries: [] }, "thread-1"),
    /received missing/
  );
});

// The bug this pins for the Orchestrator: its refresh did
// `entries = page.entries`, which discards the older history you paged in and
// any delta that landed while the fetch was in flight.
test("a refresh merges with the pin instead of replacing it", () => {
  const prior = {
    threadId: "thread-1",
    entries: [
      { item_id: "old", entry_seq: 1, text: "paged in earlier" },
      { item_id: "live", entry_seq: 2, text: "streamed" },
    ],
    olderCursor: "cursor-1",
    historyExtended: true,
  };

  const { entries } = refreshedPinPage(
    prior,
    { thread_id: "thread-1", entries: [{ item_id: "live", entry_seq: 2, text: "streamed more" }] },
    "thread-1"
  );

  assert.ok(
    entries.some((entry) => entry.item_id === "old"),
    "the history prefix must survive a tail refresh"
  );
  assert.equal(
    entries.find((entry) => entry.item_id === "live")?.text,
    "streamed more",
    "and the authoritative copy of a live entry must win"
  );
});

// Every caller stores what this returns and feeds it back as the next refresh's
// `prior`, so a field computed and then not returned is a field that survives
// exactly one refresh.
test("a refresh reports whether history is still extended", () => {
  const prior = {
    threadId: "thread-1",
    entries: [{ item_id: "old", entry_seq: 1 }, { item_id: "live", entry_seq: 2 }],
    olderCursor: "cursor-1",
    historyExtended: true,
  };

  const refreshed = refreshedPinPage(
    prior,
    { thread_id: "thread-1", entries: [{ item_id: "live", entry_seq: 2 }], prev_cursor: "cursor-9" },
    "thread-1"
  );

  assert.equal(refreshed.historyExtended, true);
});

test("a first load with no prior pin just adopts the page", () => {
  const { entries, olderCursor } = refreshedPinPage(
    null,
    { thread_id: "thread-1", entries: [{ item_id: "a" }], prev_cursor: "c1" },
    "thread-1"
  );
  assert.deepEqual(entries.map((e) => e.item_id), ["a"]);
  assert.equal(olderCursor, "c1");
});

// ---- older-history paging --------------------------------------------------

// The Orchestrator pane always rendered the history sentinel (TranscriptContent
// emits it unconditionally) but nothing watched it, and `prev_cursor` was
// dropped on the floor — so scrolling up hit a hard wall at the newest
// transport page. It paginates through the SAME merge the view-only pin uses:
// prepend, de-dupe by item id, never assign over the live tail.
const { mergeOlderViewOnlyPage } = await import("./view-only-thread.js");

test("older pages are prepended to what the Orchestrator already shows", () => {
  const pin = {
    threadId: "orch-1",
    entries: [{ item_id: "newest", text: "latest" }],
    olderCursor: "cursor-1",
  };

  const merged = mergeOlderViewOnlyPage(pin, {
    thread_id: "orch-1",
    entries: [{ item_id: "older", text: "earlier" }],
    prev_cursor: "cursor-2",
  });

  assert.deepEqual(merged.entries.map((e) => e.item_id), ["older", "newest"]);
  assert.equal(merged.olderCursor, "cursor-2", "so the next page up is reachable");
  assert.equal(merged.historyExtended, true);
});

test("a re-delivered entry is not prepended twice", () => {
  const pin = {
    threadId: "orch-1",
    entries: [{ item_id: "shared" }, { item_id: "newest" }],
    olderCursor: "c1",
  };

  const merged = mergeOlderViewOnlyPage(pin, {
    thread_id: "orch-1",
    entries: [{ item_id: "older" }, { item_id: "shared" }],
    prev_cursor: null,
  });

  assert.deepEqual(merged.entries.map((e) => e.item_id), ["older", "shared", "newest"]);
  assert.equal(merged.olderCursor, null, "null cursor is the oldest page");
});

test("an older page for a different thread is refused outright", () => {
  const pin = { threadId: "orch-1", entries: [{ item_id: "a" }], olderCursor: "c1" };
  assert.equal(mergeOlderViewOnlyPage(pin, { thread_id: "other", entries: [] }), pin);
});
