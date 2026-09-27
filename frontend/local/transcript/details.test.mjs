import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExpandedTranscriptDetailEntries,
  cacheTranscriptEntryDetail,
  getFullTranscriptEntryDetail,
  getCachedTranscriptEntryDetail,
  getLiveTranscriptEntryDetail,
  isOmittedFileChangeDetail,
  setLiveTranscriptEntryDetail,
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

test("auto-loaded running file-change entries fetch past a live summary and survive re-sync", () => {
  const state = createState();
  const omittedSnapshot = {
    active_thread_id: "thread-1",
    transcript: [
      {
        item_id: "turn-diff:turn-1",
        kind: "tool_call",
        status: "running",
        tool: {
          item_type: "turnDiff",
          name: "turn_diff",
          file_changes: [{ path: "src/a.rs", change_type: "modify", diff: "" }],
          file_changes_omitted: true,
        },
      },
    ],
  };
  const autoOpts = { autoDetailItemIds: ["turn-diff:turn-1"], threadId: "thread-1" };

  // 1) A running stripped summary gets parked in the live store by snapshot sync.
  // It must NOT be served as resolved detail, so the renderer keeps fetching.
  syncLiveTranscriptEntryDetailsFromSnapshot(state, omittedSnapshot);
  assert.equal(
    isOmittedFileChangeDetail(getLiveTranscriptEntryDetail(state, "thread-1", "turn-diff:turn-1")),
    true
  );
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, autoOpts).has("turn-diff:turn-1"),
    false
  );

  // 2) The fetch stores the FULL detail (a running entry lands in the live store).
  setLiveTranscriptEntryDetail(state, "thread-1", {
    item_id: "turn-diff:turn-1",
    kind: "tool_call",
    status: "running",
    tool: {
      item_type: "turnDiff",
      name: "turn_diff",
      file_changes: [{ path: "src/a.rs", change_type: "modify", diff: "-old\n+new" }],
      file_changes_omitted: false,
    },
  });
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, autoOpts).get("turn-diff:turn-1")?.tool
      ?.file_changes?.[0]?.diff,
    "-old\n+new"
  );

  // 3) A later snapshot re-sync of the summary must NOT clobber the full diff
  // back to a summary (which would force an endless re-fetch loop).
  syncLiveTranscriptEntryDetailsFromSnapshot(state, omittedSnapshot);
  const live = getLiveTranscriptEntryDetail(state, "thread-1", "turn-diff:turn-1");
  assert.equal(isOmittedFileChangeDetail(live), false);
  assert.equal(live?.tool?.file_changes?.[0]?.diff, "-old\n+new");
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, autoOpts).get("turn-diff:turn-1")?.tool
      ?.file_changes?.[0]?.diff,
    "-old\n+new"
  );
});

test("merge keeps a flagless-but-empty file-change entry omitted (content-based, not flag-based)", () => {
  const state = createState();
  // A flagless entry that carries file_changes but no real diff content.
  setLiveTranscriptEntryDetail(state, "thread-1", {
    item_id: "turn-diff:turn-9",
    kind: "tool_call",
    status: "running",
    tool: {
      item_type: "turnDiff",
      name: "turn_diff",
      file_changes: [{ path: "x.rs", change_type: "modify", diff: "" }],
    },
  });
  // Merging an explicit omitted summary on top must NOT make it look full — there
  // is still no real diff, so it stays a summary and keeps fetching.
  setLiveTranscriptEntryDetail(state, "thread-1", {
    item_id: "turn-diff:turn-9",
    kind: "tool_call",
    status: "running",
    tool: {
      item_type: "turnDiff",
      name: "turn_diff",
      file_changes: [{ path: "x.rs", change_type: "modify", diff: "" }],
      file_changes_omitted: true,
    },
  });

  const live = getLiveTranscriptEntryDetail(state, "thread-1", "turn-diff:turn-9");
  assert.equal(isOmittedFileChangeDetail(live), true);
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, {
      autoDetailItemIds: ["turn-diff:turn-9"],
      threadId: "thread-1",
    }).has("turn-diff:turn-9"),
    false
  );
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

// A failed row's output in the snapshot is only its head; the snapshot copy
// parked in the live store must not stand in for the full body.
function failedPreviewSnapshot() {
  return {
    active_thread_id: "thread-1",
    transcript: [
      {
        item_id: "tool:bash-1",
        kind: "tool_call",
        status: "failed",
        content_state: "preview",
        tool: { item_type: "toolCall", name: "Bash", command: "npm test", result_preview: "Exit code 1\nhead..." },
      },
    ],
  };
}

test("a failed row's cut snapshot copy never counts as full, and a fetched body survives re-syncs", () => {
  const state = createState();
  const snapshot = failedPreviewSnapshot();

  syncLiveTranscriptEntryDetailsFromSnapshot(state, snapshot);
  assert.equal(getFullTranscriptEntryDetail(state, "thread-1", "tool:bash-1"), null);
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, { expandedItemIds: new Set(["entry:tool:bash-1"]), threadId: "thread-1" })
      .get("tool:bash-1")?.content_state,
    "preview",
    "with nothing better, an opened row still shows what it has"
  );

  const full = {
    ...snapshot.transcript[0],
    content_state: "full",
    tool: { ...snapshot.transcript[0].tool, result_preview: "Exit code 1\nhead\n...\ntail" },
  };
  setLiveTranscriptEntryDetail(state, "thread-1", full);
  // The next snapshot carries the same cut copy again; it must not demote the full body.
  syncLiveTranscriptEntryDetailsFromSnapshot(state, failedPreviewSnapshot());
  const kept = getFullTranscriptEntryDetail(state, "thread-1", "tool:bash-1");
  assert.equal(kept?.tool?.result_preview, "Exit code 1\nhead\n...\ntail");
  assert.equal(
    buildExpandedTranscriptDetailEntries(state, { autoDetailItemIds: ["tool:bash-1"], threadId: "thread-1" })
      .get("tool:bash-1")?.tool?.result_preview,
    "Exit code 1\nhead\n...\ntail"
  );
});
