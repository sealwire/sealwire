import test from "node:test";
import assert from "node:assert/strict";

// transcript.js imports dom.js, which queries the document at import time.
const node = () => ({
  dataset: {},
  style: {},
  classList: { add() {}, contains: () => false, remove() {}, toggle() {} },
  addEventListener() {},
  removeEventListener() {},
  setAttribute() {},
  querySelector: () => null,
  querySelectorAll: () => [],
});
globalThis.document = {
  querySelector: node,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  createElement: node,
  body: node(),
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { origin: "http://relay.test" },
};

const { createTranscriptController } = await import("./transcript.js");
const { cacheTranscriptEntryDetail, getFullTranscriptEntryDetail } = await import("../transcript/details.js");

const reviewRow = (findings) => ({
  row_id: "review",
  item_id: "review",
  kind: "user_text",
  status: "completed",
  text: "findings",
  content_state: "full",
  injection: { kind: "review_result", review: { id: "r", round: 1, rounds: [{ round: 1, findings }] } },
});

// A card asks only while what it draws is still short, so a held copy it could not use
// (its round was run again since) must not stop the fetch.
test("a card's load fetches again even when an older whole copy is held", async () => {
  const requests = [];
  const state = {
    session: { active_thread_id: "thread-1", transcript_generation: "" },
    transcriptEntryDetailCache: new Map(),
    transcriptEntryDetailOrder: [],
    transcriptLiveEntryDetails: new Map(),
    transcriptLiveEntryThreadId: null,
    localUiStore: { getState: () => ({ startTranscriptDetailLoading() {}, finishTranscriptDetailLoading() {} }) },
  };
  cacheTranscriptEntryDetail(state, "thread-1", reviewRow([{ severity: "high", text: "older" }]));
  const fresh = reviewRow([{ severity: "high", text: "newer" }]);
  const controller = createTranscriptController({
    state,
    apiFetch: async (url) => {
      requests.push(String(url));
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { thread_id: "thread-1", transcript_generation: "", row_id: "review", item_id: "review", entry: fresh, pending_fields: [], chunk: null },
        }),
      };
    },
    queryClient: null,
    logLine() {},
    renderSession() {},
    isViewingConversation: () => true,
  });

  await controller.loadEntryDetail("review");

  assert.equal(requests.length, 1);
  assert.equal(getFullTranscriptEntryDetail(state, "thread-1", "review").injection.review.rounds[0].findings[0].text, "newer");
});
