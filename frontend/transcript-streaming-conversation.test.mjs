// Sequence-level coverage for the transcript hydration state machine across the
// MULTIPLE compacted snapshots of a single realistic conversation turn.
//
// The pre-existing tests only checked the pure store helpers against single,
// hand-crafted snapshots, so they missed the bug where a long FINAL assistant
// message — arriving after an earlier oversized snapshot already latched
// `transcriptHydrationTailReady=true` — was never re-hydrated and stayed frozen
// on its "…" preview until the thread was switched away and back.
//
// These tests drive the real `hydrateTranscript` orchestrator + the real store
// helpers (via a faithful in-memory store, the same shape as
// frontend/remote/transcript/store.js) through snapshot sequences that mirror
// how the relay actually streams a turn: each snapshot is the backend's
// compacted view (entries over the per-entry budget are "…"-truncated and
// `transcript_truncated` is set), and every `fetchPage` returns the authoritative
// full text.

import test from "node:test";
import assert from "node:assert/strict";

import { hydrateTranscript } from "./shared/transcript-hydration.js";
import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createMergedTranscriptHydrationPagePatch,
  createTranscriptHydrationCompletePatch,
  prepareTranscriptHydrationState,
  restoreHydratedTranscriptSnapshot,
} from "./shared/transcript-hydration-store.js";

// RemoteSurface per-entry budget (crates/relay-server/src/protocol.rs).
const PER_ENTRY_CHARS = 1200;

function makeStore() {
  return {
    prepareTranscriptHydration(state, snapshot) {
      const prepared = prepareTranscriptHydrationState(state, snapshot);
      if (prepared.patch) Object.assign(state, prepared.patch);
      return prepared;
    },
    beginTranscriptHydration(state, status = "loading") {
      state.transcriptHydrationStatus = status;
    },
    setTranscriptHydrationPromise(state, promise) {
      state.transcriptHydrationPromise = promise;
    },
    clearTranscriptHydrationPromise(state, signature) {
      if (state.transcriptHydrationSignature === signature) {
        state.transcriptHydrationPromise = null;
      }
    },
    setTranscriptHydrationIdle(state) {
      state.transcriptHydrationStatus = "idle";
    },
    markTranscriptHydrationComplete(state) {
      Object.assign(state, createTranscriptHydrationCompletePatch());
    },
    mergeTranscriptHydrationPage(state, page, { prepend = false } = {}) {
      Object.assign(state, createMergedTranscriptHydrationPagePatch(state, page, { prepend }));
    },
    getTranscriptHydrationThreadId: (state) => state.transcriptHydrationThreadId,
    getTranscriptHydrationSignature: (state) => state.transcriptHydrationSignature,
    buildHydratedTranscriptProgress,
  };
}

// A conversation whose authoritative (full-text) transcript lives on the
// "backend"; the frontend only ever sees compacted snapshots + page fetches.
function createConversation(threadId, { perEntryChars = PER_ENTRY_CHARS } = {}) {
  const store = makeStore();
  const state = { session: null, ...createClearedTranscriptHydrationPatch() };
  const backend = [];
  let revision = 0;
  let fetchCount = 0;
  let activeTurnId = null;

  function addEntry(entry) {
    backend.push({ tool: null, status: "completed", ...entry });
  }

  function compactedSnapshot() {
    let truncated = false;
    const transcript = backend.map((entry) => {
      if (typeof entry.text === "string" && entry.text.length > perEntryChars) {
        truncated = true;
        // Mirror the real relay: an ellipsis-truncated entry carries the
        // explicit `content_state: "preview"` so the client re-hydrates from the
        // content_state, not from the trailing "...".
        return {
          ...entry,
          text: `${entry.text.slice(0, perEntryChars - 3)}...`,
          content_state: "preview",
        };
      }
      return { ...entry, content_state: "full" };
    });
    revision += 1;
    return {
      active_thread_id: threadId,
      active_turn_id: activeTurnId,
      transcript_revision: revision,
      transcript_truncated: truncated,
      transcript,
    };
  }

  async function deliverSnapshot(snapshot) {
    // Mirror the hydration-relevant half of applySessionSnapshot:
    //   restoreHydratedTranscript -> renderSession -> hydrateActiveTranscript.
    const effective = restoreHydratedTranscriptSnapshot(state, snapshot);
    state.session = effective;
    await hydrateTranscript(state, snapshot, store, {
      fetchPage: async ({ before }) => {
        fetchCount += 1;
        // Whole thread fits one page here (full text, newest-inclusive tail).
        void before;
        return {
          thread_id: threadId,
          prev_cursor: null,
          entries: backend.map((entry) => ({ ...entry })),
        };
      },
      incompletePageError: "incomplete transcript page",
      missingTailError: "missing transcript tail",
      progressBeforeFetch: true,
      minInitialEntries: 12,
      maxInitialPages: 12,
      onProgress: (hydrated) => {
        state.session = hydrated;
      },
    });
  }

  return {
    state,
    setTurn(turnId) {
      activeTurnId = turnId;
    },
    add(entry) {
      addEntry(entry);
    },
    // Append entries (if any) then push the compacted snapshot for the turn.
    async stream(entries = []) {
      for (const entry of entries) {
        addEntry(entry);
      }
      await deliverSnapshot(compactedSnapshot());
    },
    fetchCount: () => fetchCount,
    rendered: () => state.session,
    renderedText: (itemId) =>
      state.session?.transcript?.find((entry) => entry.item_id === itemId)?.text ?? null,
    lastRenderedText: () => state.session?.transcript?.at(-1)?.text ?? null,
  };
}

const longText = (label, n = 5000) => `${label}:${"x".repeat(n)}`;

test("long final assistant message after earlier output loads full text live", async () => {
  const convo = createConversation("thread-1");
  convo.setTurn("turn-1");

  // Early in the turn an oversized preamble already trips compaction + hydration.
  await convo.stream([
    { item_id: "u1", kind: "user_text", text: "do the thing", turn_id: "turn-1" },
    { item_id: "a1", kind: "agent_text", text: longText("PREAMBLE"), turn_id: "turn-1" },
  ]);
  assert.equal(convo.fetchCount(), 1, "first oversized snapshot hydrates");
  assert.equal(convo.renderedText("a1"), longText("PREAMBLE"));

  // The long FINAL assistant message arrives. Before the fix this stayed frozen
  // on its "…" preview because the gate was already "complete".
  await convo.stream([
    { item_id: "a2", kind: "agent_text", text: longText("FINAL-ANSWER"), turn_id: "turn-1" },
  ]);

  assert.equal(convo.renderedText("a2"), longText("FINAL-ANSWER"), "final long message is full");
  assert.equal(convo.rendered().transcript_truncated, false);
  assert.equal(convo.fetchCount(), 2, "a single extra fetch resolved the new tail");
});

test("two assistant messages in a row, the second long, both end up full", async () => {
  const convo = createConversation("thread-1");
  convo.setTurn("turn-1");
  await convo.stream([
    { item_id: "u1", kind: "user_text", text: "hi", turn_id: "turn-1" },
    { item_id: "a1", kind: "agent_text", text: longText("FIRST"), turn_id: "turn-1" },
  ]);
  await convo.stream([
    { item_id: "a2", kind: "agent_text", text: longText("SECOND"), turn_id: "turn-1" },
  ]);

  assert.equal(convo.renderedText("a1"), longText("FIRST"));
  assert.equal(convo.renderedText("a2"), longText("SECOND"));
});

test("a follow-up user turn then another long reply loads full; short entries skip the fetch", async () => {
  const convo = createConversation("thread-1");

  convo.setTurn("turn-1");
  await convo.stream([
    { item_id: "u1", kind: "user_text", text: "first question", turn_id: "turn-1" },
    { item_id: "a1", kind: "agent_text", text: longText("REPLY-1"), turn_id: "turn-1" },
  ]);
  assert.equal(convo.fetchCount(), 1);

  // A short user message is a new entry but is fully present in the snapshot, so
  // it must NOT trigger a wasteful re-fetch.
  convo.setTurn("turn-2");
  await convo.stream([
    { item_id: "u2", kind: "user_text", text: "second question", turn_id: "turn-2" },
  ]);
  assert.equal(convo.fetchCount(), 1, "adding a short, complete entry does not re-fetch");
  assert.equal(convo.renderedText("a1"), longText("REPLY-1"), "earlier full text is retained");

  // The next long reply is a new oversized entry -> exactly one more fetch.
  await convo.stream([
    { item_id: "a2", kind: "agent_text", text: longText("REPLY-2"), turn_id: "turn-2" },
  ]);
  assert.equal(convo.fetchCount(), 2);
  assert.equal(convo.renderedText("a2"), longText("REPLY-2"));
});

test("long command output followed by a long final message both hydrate", async () => {
  const convo = createConversation("thread-1");
  convo.setTurn("turn-1");
  await convo.stream([
    { item_id: "u1", kind: "user_text", text: "run tests", turn_id: "turn-1" },
    { item_id: "c1", kind: "command", text: longText("TEST-OUTPUT"), turn_id: "turn-1" },
  ]);
  await convo.stream([
    { item_id: "a1", kind: "agent_text", text: longText("SUMMARY"), turn_id: "turn-1" },
  ]);

  assert.equal(convo.renderedText("c1"), longText("TEST-OUTPUT"));
  assert.equal(convo.renderedText("a1"), longText("SUMMARY"));
});

test("a short conversation never truncates and never fetches", async () => {
  const convo = createConversation("thread-1");
  convo.setTurn("turn-1");
  await convo.stream([
    { item_id: "u1", kind: "user_text", text: "ping", turn_id: "turn-1" },
    { item_id: "a1", kind: "agent_text", text: "pong", turn_id: "turn-1" },
  ]);

  assert.equal(convo.fetchCount(), 0, "non-truncated snapshots need no hydration");
  assert.equal(convo.rendered().transcript_truncated, false);
  assert.equal(convo.renderedText("a1"), "pong");
});

test("re-compacting an unchanged tail (preview churn) does not re-fetch", async () => {
  const convo = createConversation("thread-1");
  convo.setTurn("turn-1");
  await convo.stream([
    { item_id: "u1", kind: "user_text", text: "hello", turn_id: "turn-1" },
    { item_id: "a1", kind: "agent_text", text: longText("ANSWER"), turn_id: "turn-1" },
  ]);
  assert.equal(convo.fetchCount(), 1);

  // Deliver several more snapshots of the SAME structure (only the compacted
  // preview text differs run-to-run). The signature is unchanged, so the cached
  // full text is reused and no extra fetch fires.
  await convo.stream([]);
  await convo.stream([]);
  await convo.stream([]);

  assert.equal(convo.fetchCount(), 1, "stable structure never re-fetches");
  assert.equal(convo.renderedText("a1"), longText("ANSWER"));
});

test("turn completion alone does not re-fetch when the tail is already full", async () => {
  const convo = createConversation("thread-1");
  convo.setTurn("turn-1");
  await convo.stream([
    { item_id: "u1", kind: "user_text", text: "hello", turn_id: "turn-1" },
    { item_id: "a1", kind: "agent_text", text: longText("ANSWER"), turn_id: "turn-1" },
  ]);
  assert.equal(convo.fetchCount(), 1);

  // Turn completes (active_turn_id -> null): the signature changes, but every
  // tail entry's full text is already cached, so we must not waste a fetch.
  convo.setTurn(null);
  await convo.stream([]);

  assert.equal(convo.fetchCount(), 1);
  assert.equal(convo.renderedText("a1"), longText("ANSWER"));
  assert.equal(convo.rendered().transcript_truncated, false);
});
