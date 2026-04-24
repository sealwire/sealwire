import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExpandedTranscriptDetailEntries,
  cacheTranscriptEntryDetail,
  getCachedTranscriptEntryDetail,
  syncLiveTranscriptEntryDetailsFromSnapshot,
} from "./details.js";

function createState(overrides = {}) {
  return {
    transcriptEntryDetailCache: new Map(),
    transcriptEntryDetailOrder: [],
    transcriptLiveEntryDetails: new Map(),
    transcriptLiveEntryThreadId: null,
    ...overrides,
  };
}

test("local transcript details cache completed command entries and expose them for expanded items", () => {
  const state = createState();

  cacheTranscriptEntryDetail(state, "thread-1", {
    item_id: "cmd-1",
    kind: "command",
    status: "completed",
    text: "npm test\nfull output",
  });

  assert.equal(
    getCachedTranscriptEntryDetail(state, "thread-1", "cmd-1")?.text,
    "npm test\nfull output"
  );

  const detailEntries = buildExpandedTranscriptDetailEntries(state, {
    expandedItemIds: new Set(["entry:cmd-1"]),
    threadId: "thread-1",
  });

  assert.equal(detailEntries.get("cmd-1")?.text, "npm test\nfull output");
});

test("local transcript details prefer live entries for running expanded items", () => {
  const state = createState();

  syncLiveTranscriptEntryDetailsFromSnapshot(state, {
    active_thread_id: "thread-2",
    transcript: [
      {
        item_id: "tool-1",
        kind: "tool_call",
        status: "running",
        tool: {
          item_type: "fileChange",
          name: "File change",
          title: "Codex changed frontend/app.js.",
        },
      },
    ],
  });

  const detailEntries = buildExpandedTranscriptDetailEntries(state, {
    expandedItemIds: new Set(["entry:tool-1"]),
    threadId: "thread-2",
  });

  assert.equal(detailEntries.get("tool-1")?.status, "running");
  assert.equal(detailEntries.get("tool-1")?.tool?.title, "Codex changed frontend/app.js.");
});
