// Does an answered question really go back where it came from — not just on the
// next render, but after the transcript is thrown away and re-fetched?
//
// Pinning an unanswered question to the bottom is a RENDER-time move: the
// hydration window is never reordered, so the entry's real position survives by
// construction. That argument spans three layers though (server order -> page
// merge -> renderer), and each layer is tested on its own. These tests close the
// loop, driving the real `hydrateTranscript` orchestrator and the real renderer
// over one thread's lifecycle:
//
//   1. pending -> pinned; answered -> back in place; and STILL in place after a
//      full re-hydration from pages (the switch-away / reload path).
//   2. a question that is still unanswered when the reader comes back gets
//      re-pinned, because the pin is derived from the live snapshot each render.

import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";
import { hydrateTranscript } from "./shared/transcript-hydration.js";
import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createClearedTranscriptHydrationPromisePatch,
  createMergedTranscriptHydrationPagePatch,
  createOwnedTranscriptHydrationIdlePatch,
  createTranscriptHydrationCompletePatch,
  prepareTranscriptHydrationState,
  restoreHydratedTranscriptSnapshot,
  restoreTranscriptHydrationForThread,
  stashTranscriptHydrationForThread,
} from "./shared/transcript-hydration-store.js";

const h = React.createElement;

const ASK_ITEM_ID = "tool:askuser-1";
const QUESTION_TEXT = "Which approach should we take?";
const TRAILING_TEXT = "Meanwhile, here is some context.";

const PENDING_QUESTION = {
  request_id: "req-ask-1",
  tool_use_id: "askuser-1",
  thread_id: "thread-1",
  questions: [
    {
      question: QUESTION_TEXT,
      header: "Approach",
      multiSelect: false,
      options: [{ label: "Option A" }, { label: "Option B" }],
    },
  ],
};

function askEntry({ answered = false } = {}) {
  return {
    item_id: ASK_ITEM_ID,
    kind: "tool_call",
    text: null,
    status: answered ? "completed" : "running",
    turn_id: "turn-1",
    content_state: "full",
    tool: {
      item_type: "toolCall",
      name: "AskUserQuestion",
      title: "AskUserQuestion",
      input_preview: JSON.stringify({
        questions: [
          {
            question: QUESTION_TEXT,
            header: "Approach",
            multiSelect: false,
            options: [
              { label: "Option A", description: "Take the direct route" },
              { label: "Option B", description: "Take the careful route" },
            ],
          },
        ],
      }),
      result_preview: answered
        ? `Your questions have been answered: "${QUESTION_TEXT}"="Option B". You can now continue.`
        : null,
    },
  };
}

const plainEntry = (itemId, kind, text) => ({
  item_id: itemId,
  kind,
  text,
  status: "completed",
  turn_id: "turn-1",
  tool: null,
  content_state: "full",
});

// The server's persisted order — the question sits where the conversation put
// it, with the trailing message AFTER it. This is what a page re-fetch returns.
const persistedOrder = ({ answered }) => [
  plainEntry("u1", "user_text", "Investigate this bug"),
  askEntry({ answered }),
  plainEntry("a1", "agent_text", TRAILING_TEXT),
];

function renderThread(entries, pendingAskUserQuestions) {
  return renderToStaticMarkup(
    h(TranscriptContent, { entries, options: { pendingAskUserQuestions } })
  );
}

// Where each landmark sits in the rendered markup.
function positions(markup) {
  return {
    question: markup.indexOf(QUESTION_TEXT),
    trailing: markup.indexOf(TRAILING_TEXT),
    cards: (markup.match(/chat-message-ask-user[" ]/g) || []).length,
  };
}

// A faithful in-memory store, same shape as the per-surface stores
// (frontend/local/transcript/store.js, frontend/remote/transcript/store.js).
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
    clearTranscriptHydrationPromise(state, promise) {
      Object.assign(
        state,
        createClearedTranscriptHydrationPromisePatch(state, promise) || {}
      );
    },
    setTranscriptHydrationIdle(state, promise) {
      Object.assign(state, createOwnedTranscriptHydrationIdlePatch(state, promise) || {});
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

function freshState() {
  return {
    ...createClearedTranscriptHydrationPatch(),
    session: { active_thread_id: "thread-1" },
  };
}

// The relay's compacted view: entries are shells and `transcript_truncated` is
// set, so hydration fetches the authoritative page.
function compactedSnapshot({ answered, pending }) {
  return {
    active_thread_id: "thread-1",
    active_turn_id: answered ? null : "turn-1",
    transcript_revision: answered ? 2 : 1,
    transcript_truncated: true,
    pending_ask_user_questions: pending ? [PENDING_QUESTION] : [],
    transcript: persistedOrder({ answered }).map((entry) => ({
      ...entry,
      text: entry.text ? `${entry.text.slice(0, 6)}...` : entry.text,
      content_state: "preview",
      // Strip the answer from the compacted shell. The round-trip assertion is
      // about the PAGE supplying it; leaving a copy here would let that
      // assertion pass without the page ever being consulted.
      ...(entry.tool ? { tool: { ...entry.tool, result_preview: null } } : {}),
    })),
  };
}

async function hydrateFromPages(state, snapshot, { answered }) {
  const store = makeStore();
  await hydrateTranscript(state, snapshot, store, {
    async fetchPage() {
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: persistedOrder({ answered }),
      };
    },
    incompletePageError: "incomplete",
    missingTailError: "missing tail",
    onProgress(next) {
      state.session = next;
    },
  });
  return restoreHydratedTranscriptSnapshot(state, snapshot);
}

test("an answered question is still in its original position after a full re-hydration", async () => {
  const state = freshState();

  // --- while pending: hydrated from pages, then pinned to the bottom ---------
  const pendingSnapshot = compactedSnapshot({ answered: false, pending: true });
  const pendingView = await hydrateFromPages(state, pendingSnapshot, { answered: false });
  assert.deepEqual(
    pendingView.transcript.map((entry) => entry.item_id),
    ["u1", ASK_ITEM_ID, "a1"],
    "the WINDOW keeps the server's order — the pin never touches the data"
  );
  const pinned = positions(renderThread(pendingView.transcript, [PENDING_QUESTION]));
  assert.equal(pinned.cards, 1);
  assert.ok(
    pinned.question > pinned.trailing,
    "sanity: an unanswered question renders below the message that follows it"
  );

  // --- answered: same window, no pending request ----------------------------
  const answeredSnapshot = compactedSnapshot({ answered: true, pending: false });
  const answeredView = restoreHydratedTranscriptSnapshot(state, answeredSnapshot);
  const unpinned = positions(renderThread(answeredView.transcript, []));
  assert.equal(unpinned.cards, 1);
  assert.ok(
    unpinned.question < unpinned.trailing,
    "answering drops it straight back above the trailing message"
  );

  // --- the round trip: throw the window away and re-fetch from pages --------
  // This is the switch-away / reload path. If the position only survived because
  // the live window happened to still hold it, this is where it would break.
  const reloaded = freshState();
  const reloadedView = await hydrateFromPages(reloaded, answeredSnapshot, { answered: true });
  assert.deepEqual(
    reloadedView.transcript.map((entry) => entry.item_id),
    ["u1", ASK_ITEM_ID, "a1"],
    "a re-fetched window carries the server's order"
  );
  const afterReload = positions(renderThread(reloadedView.transcript, []));
  assert.equal(afterReload.cards, 1, "still exactly one question card");
  assert.ok(
    afterReload.question < afterReload.trailing,
    "and it is STILL in its original position after re-hydration"
  );
  // The snapshot shell carries no answer (see compactedSnapshot), so this can
  // only have come from the re-fetched page.
  assert.equal(
    answeredSnapshot.transcript[1].tool.result_preview,
    null,
    "precondition: the compacted shell must not leak the answer"
  );
  assert.match(
    reloadedView.transcript[1].tool.result_preview,
    /Option B/,
    "the answer that was given survives the round trip, sourced from the page"
  );
});

test("a question still unanswered on switch-back is re-pinned", async () => {
  // The pin is derived from the live snapshot on every render, so coming back to
  // a thread that is still blocked must put the question at the bottom again —
  // the retained window itself is in natural order and stays that way.
  const state = freshState();
  const pendingSnapshot = compactedSnapshot({ answered: false, pending: true });
  await hydrateFromPages(state, pendingSnapshot, { answered: false });

  // Leave for another thread, then come back.
  stashTranscriptHydrationForThread(state);
  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-2"));
  assert.equal(
    state.transcriptHydrationOrder.length,
    0,
    "sanity: the other thread starts with an empty window"
  );
  Object.assign(state, restoreTranscriptHydrationForThread(state, "thread-1"));

  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["u1", ASK_ITEM_ID, "a1"],
    "the retained window is restored in natural order, not pin order"
  );
  const restoredView = restoreHydratedTranscriptSnapshot(state, pendingSnapshot);
  const repinned = positions(renderThread(restoredView.transcript, [PENDING_QUESTION]));
  assert.equal(repinned.cards, 1, "one card, not a duplicate of the retained one");
  assert.ok(
    repinned.question > repinned.trailing,
    "a still-unanswered question is pinned to the bottom again on switch-back"
  );
});
