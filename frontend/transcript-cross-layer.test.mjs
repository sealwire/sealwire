// Cross-layer regression (P1.7 + P1.8): the frontend hydration model and the
// renderer are driven by a REAL relay-compacted snapshot, not a hand-authored JS
// fixture. The fixture is generated and staleness-guarded by the Rust test
// `protocol_tests::emit_cross_layer_compacted_snapshot_fixture`, so the omitted/
// preview/full wire contract can never silently diverge between the two layers.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptContent } from "./shared/transcript-react.js";
import { hydrateTranscript } from "./shared/transcript-hydration.js";
import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createMergedTranscriptHydrationPagePatch,
  createTranscriptHydrationCompletePatch,
  prepareTranscriptHydrationState,
  restoreHydratedTranscriptSnapshot,
} from "./shared/transcript-hydration-store.js";

const fixture = JSON.parse(
  await readFile(
    new URL("../test-fixtures/protocol/cross_layer_compacted_snapshots.json", import.meta.url),
    "utf8"
  )
);

const h = React.createElement;
const renderTranscript = (entries) =>
  renderToStaticMarkup(h(TranscriptContent, { entries }));

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

test("real relay-compacted omitted shells render as loading, never the shell text or (empty)", () => {
  const snapshot = fixture.remote_omitted_snapshot;
  // Sanity: this is genuinely the omitted scenario from the relay.
  assert.ok(snapshot.transcript.every((entry) => entry.content_state === "omitted"));
  assert.equal(snapshot.transcript_truncated, true);

  const markup = renderTranscript(snapshot.transcript);

  // The user only sees a loading placeholder per omitted entry.
  assert.match(markup, /data-transcript-pending="true"/);
  assert.match(markup, /Loading message/);
  assert.equal((markup.match(/data-transcript-pending="true"/g) || []).length, 2);

  // The 24-character identity shell text never reaches the DOM...
  for (const entry of snapshot.transcript) {
    assert.ok(
      typeof entry.text === "string" && entry.text.length > 0,
      "fixture shells should still carry clipped text on the wire"
    );
    assert.ok(
      !markup.includes(entry.text),
      `omitted shell text must not render: ${JSON.stringify(entry.text)}`
    );
  }
  // ...and neither does the "(empty)" sentinel.
  assert.ok(!markup.includes("(empty)"), "omitted entries must not render (empty)");
  // Identity (item id) is preserved so hydration can replace in place.
  assert.match(markup, /data-transcript-entry-id="a-omitted"/);
});

test("real relay-compacted full text ending in '...' renders verbatim, not as loading", () => {
  const snapshot = fixture.local_preview_snapshot;
  const short = snapshot.transcript.find((entry) => entry.item_id === "a-preview-short");
  const longEntry = snapshot.transcript.find((entry) => entry.item_id === "a-preview-long");
  // The relay classified the genuine "..."-suffixed bodies as full, and only the
  // truly oversized message as a preview.
  assert.equal(short.content_state, "full");
  assert.equal(short.text, "done, hope that helps...");
  assert.equal(longEntry.content_state, "preview");

  const markup = renderTranscript(snapshot.transcript);

  // The full "..."-suffixed messages render as real content, not loading shells.
  assert.match(markup, /done, hope that helps\.\.\./);
  assert.match(markup, /walk me through it\.\.\./);
  assert.ok(!markup.includes("data-transcript-pending"), "full entries are not pending");
  // The preview entry renders its readable (truncated) body.
  assert.ok(markup.includes(longEntry.text.slice(0, 40)));
});

test("real relay-compacted omitted snapshot hydrates and replaces shells with authoritative text", async () => {
  const snapshot = fixture.remote_omitted_snapshot;

  // Cold start: a fresh surface that has never seen this thread must re-hydrate
  // because the snapshot is truncated.
  const coldProbe = prepareTranscriptHydrationState(
    { ...createClearedTranscriptHydrationPatch() },
    snapshot
  );
  assert.equal(coldProbe.shouldHydrate, true, "an omitted cold snapshot must hydrate");

  const store = makeStore();
  const state = { session: null, ...createClearedTranscriptHydrationPatch() };
  state.session = restoreHydratedTranscriptSnapshot(state, snapshot);

  let fetchCount = 0;
  await hydrateTranscript(state, snapshot, store, {
    fetchPage: async () => {
      fetchCount += 1;
      return {
        thread_id: snapshot.active_thread_id,
        prev_cursor: null,
        entries: fixture.remote_omitted_authoritative_entries,
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

  assert.equal(fetchCount, 1, "the omitted tail triggers exactly one authoritative fetch");

  const hydratedAgent = state.session.transcript.find((entry) => entry.item_id === "a-omitted");
  const authoritative = fixture.remote_omitted_authoritative_entries.find(
    (entry) => entry.item_id === "a-omitted"
  );
  assert.equal(hydratedAgent.content_state, "full", "the entry is promoted to full after hydration");
  assert.equal(hydratedAgent.text, authoritative.text, "authoritative text replaces the shell in place");

  // After hydration the renderer shows the real message, no loading placeholder.
  const markup = renderTranscript(state.session.transcript);
  assert.ok(!markup.includes("data-transcript-pending"), "no loading shells remain after hydration");
  assert.ok(markup.includes("The relay boots with the complete provider"));
});
