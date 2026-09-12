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

import { relayResolvesForkPoints } from "./shared/fork-fields.js";
import { TranscriptContent } from "./shared/transcript-react.js";
import { hydrateTranscript } from "./shared/transcript-hydration.js";
import {
  buildHydratedTranscriptProgress,
  createClearedTranscriptHydrationPatch,
  createClearedTranscriptHydrationFetchedRevisionPatch,
  createClearedTranscriptHydrationPromisePatch,
  createMergedTranscriptHydrationPagePatch,
  createOwnedTranscriptHydrationIdlePatch,
  createTranscriptHydrationCompletePatch,
  createTranscriptHydrationRevisionPatch,
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
    clearTranscriptHydrationPromise(state, promise) {
      Object.assign(
        state,
        createClearedTranscriptHydrationPromisePatch(state, promise) || {}
      );
    },
    setTranscriptHydrationIdle(state, promise) {
      Object.assign(state, createOwnedTranscriptHydrationIdlePatch(state, promise) || {});
    },
    clearTranscriptHydrationFetchedRevision(state) {
      Object.assign(state, createClearedTranscriptHydrationFetchedRevisionPatch());
    },
    // Same shape as the real stores, including the revision each answers for:
    // `fetchedRevision` gates the once-per-revision re-arm, `bodyRevision`
    // records which revision the cached bodies came from.
    markTranscriptHydrationComplete(state, fetchedRevision) {
      Object.assign(state, createTranscriptHydrationCompletePatch(fetchedRevision));
    },
    recordTranscriptHydrationRevision(state, bodyRevision) {
      Object.assign(state, createTranscriptHydrationRevisionPatch(bodyRevision));
    },
    mergeTranscriptHydrationPage(state, page, { prepend = false } = {}) {
      Object.assign(state, createMergedTranscriptHydrationPagePatch(state, page, { prepend }));
    },
    getTranscriptHydrationThreadId: (state) => state.transcriptHydrationThreadId,
    getTranscriptHydrationSignature: (state) => state.transcriptHydrationSignature,
    buildHydratedTranscriptProgress,
  };
}

test("real emergency tail drops bodyless reasoning while omitted bodies render as loading", () => {
  const snapshot = fixture.remote_omitted_snapshot;
  // Sanity: this is genuinely the mixed emergency-tail shape from the relay.
  const bodyless = snapshot.transcript.find((entry) => entry.item_id === "r-empty-full");
  const bodylessAgent = snapshot.transcript.find(
    (entry) => entry.item_id === "a-empty-omitted"
  );
  const omitted = snapshot.transcript.filter((entry) => entry.content_state === "omitted");
  assert.equal(bodyless.content_state, "full");
  assert.equal(bodyless.text, null);
  assert.equal(bodylessAgent.content_state, "omitted");
  assert.equal(bodylessAgent.text, null);
  assert.equal(omitted.length, 2);
  assert.equal(snapshot.transcript_truncated, true);

  const markup = renderTranscript(snapshot.transcript);

  // The user only sees a loading placeholder per genuinely omitted entry. A
  // settled, fully-loaded empty reasoning marker carries no information and is
  // dropped instead of becoming the phantom ellipsis this fixture guards.
  assert.match(markup, /data-transcript-pending="true"/);
  assert.match(markup, /Loading message/);
  assert.equal((markup.match(/data-transcript-pending="true"/g) || []).length, 2);
  assert.ok(!markup.includes('data-transcript-entry-id="r-empty-full"'));
  assert.match(markup, /data-transcript-entry-id="a-empty-omitted"/);

  // The 24-character identity shell text never reaches the DOM...
  const textBearingOmitted = omitted.filter(
    (entry) => typeof entry.text === "string" && entry.text.length > 0
  );
  assert.ok(
    textBearingOmitted.length > 0,
    "fixture must retain at least one clipped omitted shell"
  );
  for (const entry of textBearingOmitted) {
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

test("a turn-end signature change discards an in-flight tail fetch and re-arms at the same revision", async () => {
  const snapshot = fixture.remote_omitted_snapshot;
  const REVISION = snapshot.transcript_revision ?? 99;
  const omittedEntry = snapshot.transcript.find((entry) => entry.item_id === "a-omitted");
  const olderEntry = snapshot.transcript.find((entry) => entry.item_id !== "a-omitted");
  const authoritative = fixture.remote_omitted_authoritative_entries.find(
    (entry) => entry.item_id === "a-omitted"
  );

  const store = makeStore();
  const state = {
    session: {
      active_thread_id: snapshot.active_thread_id,
      active_turn_id: "turn-live",
    },
    ...createClearedTranscriptHydrationPatch(),
    transcriptHydrationThreadId: snapshot.active_thread_id,
    transcriptHydrationEntries: new Map([[olderEntry.item_id, olderEntry]]),
    transcriptHydrationOrder: [olderEntry.item_id],
    transcriptHydrationOlderCursor: "older-cursor",
    transcriptHydrationSignature: `${snapshot.active_thread_id}|prior`,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
  };

  const midTurnSnapshot = {
    ...snapshot,
    active_turn_id: "turn-live",
    transcript_revision: REVISION,
    transcript: [olderEntry, omittedEntry],
  };
  const turnEndSnapshot = {
    ...midTurnSnapshot,
    active_turn_id: null,
    transcript: [olderEntry, { ...omittedEntry, text: null }],
  };

  let fetchCalls = 0;
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  const fetchPage = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      await pageGate;
      return {
        thread_id: snapshot.active_thread_id,
        prev_cursor: "older-cursor",
        entries: [
          olderEntry,
          {
            ...omittedEntry,
            text: "stale mid-turn body from the first fetch",
            content_state: "full",
          },
        ],
      };
    }
    return {
      thread_id: snapshot.active_thread_id,
      prev_cursor: "older-cursor",
      entries: fixture.remote_omitted_authoritative_entries,
    };
  };
  const onProgress = (hydrated) => {
    state.session = hydrated;
  };

  const firstPromise = hydrateTranscript(state, midTurnSnapshot, store, {
    fetchPage,
    incompletePageError: "incomplete transcript page",
    missingTailError: "missing transcript tail",
    onProgress,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    state.transcriptHydrationFetchedRevision,
    REVISION,
    "mid-turn snapshot arms fetch at revision R"
  );
  assert.equal(fetchCalls, 1, "first fetch is in flight");

  const concurrentPromise = hydrateTranscript(state, turnEndSnapshot, store, {
    fetchPage,
    incompletePageError: "incomplete transcript page",
    missingTailError: "missing transcript tail",
    onProgress,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    fetchCalls,
    1,
    "turn-end snapshot reuses the in-flight fetch, it does not start a second one yet"
  );

  releasePage();
  await Promise.all([firstPromise, concurrentPromise]);

  assert.equal(
    state.transcriptHydrationFetchedRevision,
    null,
    "discarding a stale page must clear the once-per-revision arm"
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "a-omitted")?.text,
    null,
    "stale mid-turn page must be discarded, not merged"
  );

  state.transcriptHydrationTailReady = true;

  await hydrateTranscript(state, turnEndSnapshot, store, {
    fetchPage,
    incompletePageError: "incomplete transcript page",
    missingTailError: "missing transcript tail",
    onProgress,
  });

  assert.equal(
    fetchCalls,
    2,
    "turn-end must re-arm a second fetch after the stale page is discarded"
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "a-omitted")?.text,
    authoritative.text,
    "the re-armed fetch must land the authoritative turn-end text"
  );
});

// A page requested before a relay restart can land after it. Its item ids come from
// the previous run and name the SAME messages differently, so merging it renders each
// of them twice. The page says which run produced it; the merge has to check.
test("a page that arrives from the previous relay generation is dropped, not merged", async () => {
  const snapshot = {
    ...fixture.remote_omitted_snapshot,
    transcript_generation: "gen-b",
  };

  const store = makeStore();
  const state = { session: null, ...createClearedTranscriptHydrationPatch() };
  state.session = restoreHydratedTranscriptSnapshot(state, snapshot);

  await hydrateTranscript(state, snapshot, store, {
    fetchPage: async () => ({
      thread_id: snapshot.active_thread_id,
      prev_cursor: null,
      // In flight since before the restart.
      transcript_generation: "gen-a",
      entries: fixture.remote_omitted_authoritative_entries,
    }),
    incompletePageError: "incomplete transcript page",
    missingTailError: "missing transcript tail",
    progressBeforeFetch: true,
    minInitialEntries: 12,
    maxInitialPages: 12,
    onProgress: (hydrated) => {
      state.session = hydrated;
    },
  });

  assert.equal(
    state.transcriptHydrationOrder.length,
    0,
    `the previous run's page must not enter the window: ${JSON.stringify(state.transcriptHydrationOrder)}`
  );
});

test("a page from the CURRENT generation still merges", async () => {
  const snapshot = {
    ...fixture.remote_omitted_snapshot,
    transcript_generation: "gen-b",
  };

  const store = makeStore();
  const state = { session: null, ...createClearedTranscriptHydrationPatch() };
  state.session = restoreHydratedTranscriptSnapshot(state, snapshot);

  await hydrateTranscript(state, snapshot, store, {
    fetchPage: async () => ({
      thread_id: snapshot.active_thread_id,
      prev_cursor: null,
      transcript_generation: "gen-b",
      entries: fixture.remote_omitted_authoritative_entries,
    }),
    incompletePageError: "incomplete transcript page",
    missingTailError: "missing transcript tail",
    progressBeforeFetch: true,
    minInitialEntries: 12,
    maxInitialPages: 12,
    onProgress: (hydrated) => {
      state.session = hydrated;
    },
  });

  assert.ok(state.transcriptHydrationOrder.length > 0);
});

// The fork-point capability crosses the same Rust/JS boundary as the content
// states above, and it is read by exactly one JS function. If the Rust field were
// renamed, or the JS accessor's spelling drifted, the client would silently fall
// back to guessing a provider id shape off a row key — with no error anywhere,
// against a relay that no longer needs the guess. A hand-authored JS fixture could
// not catch that; this snapshot is emitted by the Rust layer itself.
test("the relay's fork-point capability is read under the name Rust serializes", () => {
  for (const [name, snapshot] of [
    ["local_preview_snapshot", fixture.local_preview_snapshot],
    ["remote_omitted_snapshot", fixture.remote_omitted_snapshot],
  ]) {
    assert.equal(
      relayResolvesForkPoints(snapshot),
      true,
      `${name}: the relay says it resolves fork points, so the client must see that`,
    );
  }

  // And the other direction, which is what version skew actually looks like: a
  // pre-R4 relay omits the field entirely rather than sending false.
  const { relay_resolves_fork_points: _omitted, ...preR4 } = fixture.local_preview_snapshot;
  assert.equal("relay_resolves_fork_points" in preR4, false, "the fixture must have carried it");
  assert.equal(
    relayResolvesForkPoints(preR4),
    false,
    "absence must read as an older relay, so the client keeps its own pre-flight rule",
  );
});
