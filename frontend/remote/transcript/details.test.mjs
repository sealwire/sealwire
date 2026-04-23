import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

function installBrowserStubs() {
  const store = new Map();
  globalThis.window = {
    crypto: webcrypto,
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      removeItem(key) {
        store.delete(key);
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
    },
  };
  globalThis.localStorage = globalThis.window.localStorage;
  globalThis.document = {
    body: {
      dataset: {},
    },
  };
}

test("prepareTranscriptEntryForSurface previews completed commands and caches small details", async () => {
  installBrowserStubs();
  const { state } = await import("../state.js");
  const { applyRemoteSurfacePatch } = await import("../surface-state.js");
  const {
    getCachedTranscriptEntryDetail,
    prepareTranscriptEntryForSurface,
  } = await import("./details.js");

  applyRemoteSurfacePatch({
    transcriptEntryDetailCache: new Map(),
    transcriptEntryDetailOrder: [],
  });

  const fullText = `npm test\n${"x".repeat(2048)}`;
  const prepared = prepareTranscriptEntryForSurface(state, "thread-1", {
    item_id: "cmd-1",
    kind: "command",
    status: "completed",
    text: fullText,
  });

  assert.notEqual(prepared.entry.text, fullText);
  assert.match(prepared.entry.text, /\.\.\.|…/);
  assert.doesNotMatch(prepared.entry.text, /\n/);
  assert.equal(
    getCachedTranscriptEntryDetail(state, "thread-1", "cmd-1")?.text,
    fullText
  );
});

test("prepareTranscriptEntryForSurface avoids caching oversized command details", async () => {
  installBrowserStubs();
  const { state } = await import("../state.js");
  const { applyRemoteSurfacePatch } = await import("../surface-state.js");
  const {
    getCachedTranscriptEntryDetail,
    prepareTranscriptEntryForSurface,
    TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES,
  } = await import("./details.js");

  applyRemoteSurfacePatch({
    transcriptEntryDetailCache: new Map(),
    transcriptEntryDetailOrder: [],
  });

  const fullText = `npm test\n${"x".repeat(TRANSCRIPT_ENTRY_DETAIL_INLINE_CACHE_MAX_BYTES + 1024)}`;
  const prepared = prepareTranscriptEntryForSurface(state, "thread-1", {
    item_id: "cmd-2",
    kind: "command",
    status: "completed",
    text: fullText,
  });

  assert.notEqual(prepared.entry.text, fullText);
  assert.doesNotMatch(prepared.entry.text, /\n/);
  assert.equal(getCachedTranscriptEntryDetail(state, "thread-1", "cmd-2"), null);
});

test("prepareTranscriptEntryForSurface caches completed tool call details without rewriting preview text", async () => {
  installBrowserStubs();
  const { state } = await import("../state.js");
  const { applyRemoteSurfacePatch } = await import("../surface-state.js");
  const {
    getCachedTranscriptEntryDetail,
    prepareTranscriptEntryForSurface,
  } = await import("./details.js");

  applyRemoteSurfacePatch({
    transcriptEntryDetailCache: new Map(),
    transcriptEntryDetailOrder: [],
  });

  const entry = {
    item_id: "tool-1",
    kind: "tool_call",
    status: "completed",
    text: "Read frontend/remote/main.js",
    tool: {
      item_type: "mcpToolCall",
      name: "Read",
      title: "Read frontend/remote/main.js",
      path: "frontend/remote/main.js",
      input_preview: "{\"path\":\"frontend/remote/main.js\"}",
      result_preview: "{\"text\":\"file contents\"}",
    },
  };

  const prepared = prepareTranscriptEntryForSurface(state, "thread-1", entry);

  assert.equal(prepared.entry.text, entry.text);
  assert.deepEqual(
    getCachedTranscriptEntryDetail(state, "thread-1", "tool-1")?.tool,
    entry.tool
  );
});

test("setLiveTranscriptEntryDetail preserves diff metadata from later tool detail fetches", async () => {
  installBrowserStubs();
  const { state } = await import("../state.js");
  const { applyRemoteSurfacePatch } = await import("../surface-state.js");
  const {
    getLiveTranscriptEntryDetail,
    setLiveTranscriptEntryDetail,
  } = await import("./details.js");

  applyRemoteSurfacePatch({
    transcriptLiveEntryDetails: new Map(),
    transcriptLiveEntryThreadId: null,
  });

  setLiveTranscriptEntryDetail(state, "thread-1", {
    item_id: "tool-2",
    kind: "tool_call",
    status: "running",
    tool: {
      item_type: "fileChange",
      name: "File change",
      title: "Codex changed frontend/app.js.",
    },
  });
  setLiveTranscriptEntryDetail(state, "thread-1", {
    item_id: "tool-2",
    kind: "tool_call",
    status: "completed",
    tool: {
      item_type: "fileChange",
      name: "File change",
      title: "Codex changed frontend/app.js.",
      diff: "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new",
      file_changes: [
        {
          path: "frontend/app.js",
          change_type: "update",
          diff: "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new",
        },
      ],
    },
  });

  assert.equal(
    getLiveTranscriptEntryDetail(state, "thread-1", "tool-2")?.tool?.diff,
    "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new"
  );
  assert.deepEqual(
    getLiveTranscriptEntryDetail(state, "thread-1", "tool-2")?.tool?.file_changes,
    [
      {
        path: "frontend/app.js",
        change_type: "update",
        diff: "diff --git a/frontend/app.js b/frontend/app.js\n@@ -1 +1 @@\n-old\n+new",
      },
    ]
  );
});
