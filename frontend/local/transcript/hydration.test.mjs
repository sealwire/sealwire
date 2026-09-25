import test from "node:test";
import assert from "node:assert/strict";

import {
  hydrateLocalTranscript,
  loadOlderLocalTranscript,
} from "./hydration.js";
import {
  appendTranscriptDelta,
  clearTranscriptHydration,
  restoreHydratedTranscript,
  switchTranscriptHydrationThread,
} from "./store.js";
import { relayError } from "../../shared/transcript-protocol.js";

function createState(overrides = {}) {
  return {
    session: {
      active_thread_id: "thread-1",
    },
    transcriptHydrationBaseSnapshot: null,
    transcriptHydrationEntries: new Map(),
    transcriptHydrationOrder: [],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: false,
    transcriptHydrationThreadId: null,
    ...overrides,
  };
}

test("hydrateLocalTranscript replaces a truncated tail with the full tail page", async () => {
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "hello...",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };
  const progress = [];

  await hydrateLocalTranscript(state, snapshot, {
    async fetchPage({ threadId, before }) {
      assert.equal(threadId, "thread-1");
      assert.equal(before, null);
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-2",
            kind: "agent_text",
            text: "hello world",
            status: "completed",
            turn_id: "turn-2",
            tool: null,
          },
        ],
      };
    },
    onProgress(nextSnapshot) {
      progress.push(nextSnapshot);
      state.session = nextSnapshot;
    },
  });

  assert.equal(state.transcriptHydrationStatus, "complete");
  assert.equal(state.transcriptHydrationOlderCursor, null);
  assert.deepEqual(
    progress.at(-1)?.transcript?.map((entry) => entry.text),
    ["hello world"]
  );
});

// The relay rebuilt the thread between the tail read and the backfill that followed it.
test("a backfill whose cursor is rejected asks for a reload rather than reporting a failure", async () => {
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "hello...",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };
  const errors = [];
  const rejected = [];

  await hydrateLocalTranscript(state, snapshot, {
    async fetchPage({ before }) {
      if (before != null) {
        throw relayError("transcript cursor has expired", "transcript_cursor_rejected");
      }
      return {
        thread_id: "thread-1",
        prev_cursor: "tc1.rebuilt-away.0",
        entries: [
          {
            item_id: "item-2",
            kind: "agent_text",
            text: "hello world",
            status: "completed",
            turn_id: "turn-2",
            tool: null,
          },
        ],
      };
    },
    onError(error) {
      errors.push(error.message);
    },
    onCursorRejected(error) {
      rejected.push(error.code);
    },
    onProgress(nextSnapshot) {
      state.session = nextSnapshot;
    },
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(rejected, ["transcript_cursor_rejected"]);
  assert.equal(state.transcriptHydrationPromise, null);
});

test("hydrateLocalTranscript backfills sparse oversized tail pages", async () => {
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-12",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-12",
        kind: "tool_call",
        text: null,
        status: "completed",
        turn_id: "turn-12",
        tool: {
          item_type: "file_change",
          diff: "+".repeat(90_000),
        },
      },
    ],
  };
  const requestedBefore = [];
  const pages = [
    {
      thread_id: "thread-1",
      prev_cursor: "c8",
      entries: [
        {
          item_id: "item-12",
          kind: "tool_call",
          text: null,
          status: "completed",
          turn_id: "turn-12",
          tool: {
            item_type: "file_change",
            diff: "+".repeat(90_000),
          },
        },
      ],
    },
    {
      thread_id: "thread-1",
      prev_cursor: "c4",
      entries: Array.from({ length: 4 }, (_, index) => ({
        item_id: `item-${index + 8}`,
        kind: "agent_text",
        text: `older reply ${index + 8}`,
        status: "completed",
        turn_id: `turn-${index + 8}`,
        tool: null,
      })),
    },
    {
      thread_id: "thread-1",
      prev_cursor: "c1",
      entries: Array.from({ length: 4 }, (_, index) => ({
        item_id: `item-${index + 4}`,
        kind: "user_text",
        text: `older prompt ${index + 4}`,
        status: "completed",
        turn_id: `turn-${index + 4}`,
        tool: null,
      })),
    },
  ];
  const progress = [];

  await hydrateLocalTranscript(state, snapshot, {
    async fetchPage({ before }) {
      requestedBefore.push(before);
      return pages.shift();
    },
    onProgress(nextSnapshot) {
      progress.push(nextSnapshot);
      state.session = nextSnapshot;
    },
  });

  assert.deepEqual(requestedBefore, [null, "c8", "c4"]);
  assert.deepEqual(
    state.session.transcript.map((entry) => entry.item_id),
    [
      "item-4",
      "item-5",
      "item-6",
      "item-7",
      "item-8",
      "item-9",
      "item-10",
      "item-11",
      "item-12",
    ]
  );
  assert.equal(state.transcriptHydrationOlderCursor, "c1");
  assert.equal(state.session.transcript_truncated, true);
  assert.deepEqual(
    progress.at(-1)?.transcript?.map((entry) => entry.item_id),
    state.session.transcript.map((entry) => entry.item_id)
  );
});

test("hydrateLocalTranscript does nothing for non-truncated snapshots", async () => {
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: false,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "hello world",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };

  let fetchCalls = 0;
  let progressCalls = 0;

  const result = await hydrateLocalTranscript(state, snapshot, {
    async fetchPage() {
      fetchCalls += 1;
      return null;
    },
    onProgress() {
      progressCalls += 1;
    },
  });

  assert.equal(result, null);
  assert.equal(fetchCalls, 0);
  assert.equal(progressCalls, 0);
});

test("hydrateLocalTranscript re-entry during progress reuses the in-flight promise", async () => {
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "hello...",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };

  let fetchCalls = 0;
  let reenteredPromise = null;
  let reentered = false;

  const hydrationPromise = hydrateLocalTranscript(state, snapshot, {
    async fetchPage() {
      fetchCalls += 1;
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-2",
            kind: "agent_text",
            text: "hello world",
            status: "completed",
            turn_id: "turn-2",
            tool: null,
          },
        ],
      };
    },
    onProgress(nextSnapshot) {
      state.session = nextSnapshot;
      if (!reentered) {
        reentered = true;
        reenteredPromise = hydrateLocalTranscript(state, nextSnapshot, {
          async fetchPage() {
            fetchCalls += 1;
            throw new Error("should not refetch during hydration re-entry");
          },
        });
      }
    },
  });

  await hydrationPromise;
  await reenteredPromise;
  assert.equal(fetchCalls, 1);
  assert.ok(reenteredPromise instanceof Promise);
});

test("hydrateLocalTranscript does not recurse while a re-hydration fetch is already in flight", async () => {
  // Reproduces the hard freeze (markdown/transcript-perf-freeze-analysis.md):
  // a thread with an already-hydrated window receives a streaming snapshot whose
  // live tail is an `omitted` shell, so `reHydrateTail` arms a fetch. While that
  // fetch is pending, hydrateTranscript synchronously fires onProgress, and
  // render-session.js re-calls ensureConversationTranscript because the snapshot
  // is still `transcript_truncated`. That re-entry must REUSE the in-flight fetch
  // (return the existing promise) — never start another one and re-fire onProgress.
  // Pre-fix, `reHydrateTail` nulls the in-flight promise and re-arms on every
  // re-entry, so onProgress -> renderSession -> hydrate recurses synchronously
  // without bound (the snapshot stays truncated until the fetch RESOLVES), which
  // overflows the stack and freezes the tab.
  const fullOlder = {
    item_id: "item-1",
    kind: "agent_text",
    text: "older full body",
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    content_state: "full",
  };
  const state = createState({
    // renderSession sets state.session to the rendered snapshot before calling
    // ensureConversationTranscript, so it carries the same active_turn_id the base
    // snapshot does — keep that here so the rebuilt progress snapshot's signature
    // matches the base (otherwise the in-flight fetch bails on a phantom signature
    // drift at transcript-hydration.js:58).
    session: { active_thread_id: "thread-1", active_turn_id: "turn-2" },
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map([["item-1", fullOlder]]),
    transcriptHydrationOrder: ["item-1"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "thread-1|prior",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
  });

  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: true,
    transcript: [
      fullOlder,
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "emergency shell...",
        status: "running",
        turn_id: "turn-2",
        tool: null,
        content_state: "omitted",
      },
    ],
  };
  const page = {
    thread_id: "thread-1",
    prev_cursor: null,
    entries: [
      fullOlder,
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "the full streamed assistant body",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };

  let fetchCalls = 0;
  let reentryDepth = 0;
  // Safety cap so the PRE-FIX synchronous recursion can't overflow the stack and
  // crash the runner — it instead surfaces as a clean fetchCalls assertion failure.
  const MAX_REENTRY = 50;

  function onProgress(nextSnapshot) {
    state.session = nextSnapshot;
    // Mirror render-session.js:380 — a still-truncated snapshot re-runs hydration.
    if (!nextSnapshot?.transcript_truncated || reentryDepth >= MAX_REENTRY) {
      return;
    }
    reentryDepth += 1;
    void hydrateLocalTranscript(state, nextSnapshot, {
      async fetchPage() {
        fetchCalls += 1;
        return page;
      },
      onProgress,
    });
  }

  await hydrateLocalTranscript(state, snapshot, {
    async fetchPage() {
      fetchCalls += 1;
      return page;
    },
    onProgress,
  });

  assert.equal(
    fetchCalls,
    1,
    "a re-hydration fetch already in flight must be reused, not restarted on every synchronous onProgress re-entry"
  );
  assert.ok(
    reentryDepth <= 1,
    "onProgress must not re-trigger hydration unboundedly while the first fetch is pending"
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "item-2")?.text,
    "the full streamed assistant body",
    "the in-flight fetch still completes and replaces the omitted shell with full text"
  );
});

test("a stale tail page that lost a concurrently-joined entry must not drop it from the order", async () => {
  // Codex review finding 1: item-A is hydrated (omitted/running). A tail fetch
  // starts. While it is in flight, item-B (a newer message) joins via a concurrent
  // snapshot and is merged into the order. The in-flight fetch then returns a STALE
  // tail page that predates item-B. A non-prepend merge resets the order to the
  // page's ids, which would drop item-B from the order while leaving it orphaned in
  // the entries map — a later same-id merge never re-adds a map-present id, so once
  // item-B arrives `full` (needsFullText=false) it is permanently missing. The fetch
  // must detect it went stale (signature changed mid-flight) and discard the page
  // BEFORE merging, leaving item-B ordered and visible.
  const itemA = {
    item_id: "item-A",
    kind: "agent_text",
    text: null,
    status: "running",
    turn_id: "turn-1",
    tool: null,
    content_state: "omitted",
  };
  const state = createState({
    session: { active_thread_id: "thread-1", active_turn_id: "turn-1" },
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map([["item-A", { ...itemA }]]),
    transcriptHydrationOrder: ["item-A"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "thread-1|turn-1|1|item-A|agent_text|turn-1||||",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: 10,
  });

  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  const snapshotA = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
    transcript_revision: 11,
    transcript_truncated: true,
    transcript: [{ ...itemA, text: "shell..." }],
  };
  const hydrationPromise = hydrateLocalTranscript(state, snapshotA, {
    async fetchPage() {
      await pageGate;
      // Stale: this page was built before item-B joined — it has only item-A.
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-A",
            kind: "agent_text",
            text: "A full body",
            status: "completed",
            turn_id: "turn-1",
            tool: null,
          },
        ],
      };
    },
    onProgress(next) {
      state.session = next;
    },
  });

  // While the fetch is in flight, item-B joins via a concurrent snapshot.
  await new Promise((resolve) => setImmediate(resolve));
  let concurrentFetchCalled = false;
  const reentryPromise = hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      active_turn_id: "turn-2",
      transcript_revision: 12,
      transcript_truncated: true,
      transcript: [
        { ...itemA, text: "shell..." },
        {
          item_id: "item-B",
          kind: "agent_text",
          text: "newer...",
          status: "running",
          turn_id: "turn-2",
          tool: null,
          content_state: "omitted",
        },
      ],
    },
    {
      async fetchPage() {
        concurrentFetchCalled = true;
        return { thread_id: "thread-1", prev_cursor: null, entries: [] };
      },
      onProgress(next) {
        state.session = next;
      },
    }
  );

  assert.equal(
    concurrentFetchCalled,
    false,
    "the concurrent snapshot reuses the in-flight fetch, it does not start a new one"
  );
  assert.ok(
    state.transcriptHydrationOrder.includes("item-B"),
    "precondition: item-B joined the order while the fetch was in flight"
  );

  releasePage();
  await Promise.all([hydrationPromise, reentryPromise]);

  assert.ok(
    state.transcriptHydrationOrder.includes("item-B"),
    "a concurrently-joined entry must survive a stale tail-page merge (not be orphaned out of the order)"
  );
});

test("hydrateLocalTranscript clears its in-flight promise on settle even if the signature changed mid-flight", async () => {
  // A new entry joining the tail during a fetch re-keys the hydration signature
  // (the merged concurrent snapshot updates it). The settling fetch must still
  // clear ITS OWN promise. Keying the clear off the now-changed signature leaks
  // the promise — and a parked promise makes loadOlderTranscript bail
  // (transcript-hydration.js: `if (state.transcriptHydrationPromise || ...) return`),
  // so scroll-up to load older history silently stalls.
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "shell...",
        status: "running",
        turn_id: "turn-2",
        tool: null,
        content_state: "omitted",
      },
    ],
  };
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });

  const hydrationPromise = hydrateLocalTranscript(state, snapshot, {
    async fetchPage() {
      await pageGate;
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-2",
            kind: "agent_text",
            text: "the full streamed body",
            status: "completed",
            turn_id: "turn-2",
            tool: null,
          },
        ],
      };
    },
    onProgress(next) {
      state.session = next;
    },
  });

  // While the fetch is in flight, a concurrent snapshot's new entry re-keys the
  // signature (what createMergedSnapshotTailPatch does on a same-thread merge).
  await new Promise((resolve) => setImmediate(resolve));
  state.transcriptHydrationSignature = "thread-1|turn-3|re-keyed-by-a-new-entry";

  releasePage();
  await hydrationPromise;

  assert.equal(
    state.transcriptHydrationPromise,
    null,
    "the settled fetch must clear its own promise so loadOlderTranscript (scroll-up) is not blocked"
  );
});

test("a stale-thread early return releases loading when the settling request still owns the hydration slot", async () => {
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-A",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-A",
        kind: "agent_text",
        text: "shell...",
        status: "running",
        turn_id: "turn-A",
        tool: null,
        content_state: "omitted",
      },
    ],
  };
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });

  const hydrationPromise = hydrateLocalTranscript(state, snapshot, {
    async fetchPage() {
      await pageGate;
      return {
        thread_id: "thread-A",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-A",
            kind: "agent_text",
            text: "stale thread-A body",
            status: "completed",
            turn_id: "turn-A",
            tool: null,
          },
        ],
      };
    },
    onProgress() {},
  });

  assert.equal(state.transcriptHydrationStatus, "loading");
  // Only the visible session moved. No replacement hydration request owns the
  // slot, so this request is still responsible for releasing its own loading
  // status when the stale-page gate returns before merge.
  state.session = { active_thread_id: "thread-B" };
  releasePage();
  await hydrationPromise;

  assert.equal(state.transcriptHydrationPromise, null);
  assert.equal(
    state.transcriptHydrationStatus,
    "idle",
    "the shared finally path must release an owned loading status even when no merge ran"
  );
});

test("a synchronous tail-fetch failure still releases the promise and loading status it owns", async () => {
  const state = createState();
  const errors = [];

  await hydrateLocalTranscript(state, {
    active_thread_id: "thread-1",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: "shell...",
        status: "running",
        turn_id: "turn-1",
        tool: null,
        content_state: "omitted",
      },
    ],
  }, {
    fetchPage() {
      throw new Error("synchronous fetch setup failure");
    },
    onError(error) {
      errors.push(error.message);
    },
    onProgress() {},
  });

  assert.deepEqual(errors, ["synchronous fetch setup failure"]);
  assert.equal(state.transcriptHydrationPromise, null);
  assert.equal(state.transcriptHydrationStatus, "idle");
});

test("hydrateLocalTranscript does not publish a new emergency shell while its full page is pending", async () => {
  const state = createState();
  const previousSnapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-1",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: "Earlier assistant mess...",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
        content_state: "preview",
      },
    ],
  };

  await hydrateLocalTranscript(state, previousSnapshot, {
    async fetchPage() {
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-1",
            kind: "agent_text",
            text: "Earlier assistant message that is already hydrated.",
            status: "completed",
            turn_id: "turn-1",
            tool: null,
          },
        ],
      };
    },
    onProgress(nextSnapshot) {
      state.session = nextSnapshot;
    },
  });

  const emergencyShell = "The relay boots with ...";
  const nextSnapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-1",
        kind: "agent_text",
        text: "Earlier assistant mess...",
        status: "completed",
        turn_id: "turn-1",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-2",
        kind: "agent_text",
        text: emergencyShell,
        status: "completed",
        turn_id: "turn-2",
        tool: null,
        content_state: "omitted",
      },
    ],
  };
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  const renderedWhilePending = [];

  const hydrationPromise = hydrateLocalTranscript(state, nextSnapshot, {
    async fetchPage() {
      await pageGate;
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-1",
            kind: "agent_text",
            text: "Earlier assistant message that is already hydrated.",
            status: "completed",
            turn_id: "turn-1",
            tool: null,
          },
          {
            item_id: "item-2",
            kind: "agent_text",
            text: "The relay boots with the complete provider and transcript state.",
            status: "completed",
            turn_id: "turn-2",
            tool: null,
          },
        ],
      };
    },
    onProgress(nextRenderedSnapshot) {
      renderedWhilePending.push(nextRenderedSnapshot);
      state.session = nextRenderedSnapshot;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const pendingText = renderedWhilePending
    .at(-1)
    ?.transcript?.find((entry) => entry.item_id === "item-2")?.text;

  releasePage();
  await hydrationPromise;

  assert.equal(
    pendingText,
    null,
    "the renderer must receive an unloaded entry, not a 24-character emergency shell"
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "item-2")?.text,
    "The relay boots with the complete provider and transcript state.",
    "the authoritative page must replace the unloaded entry with full text"
  );
});

test("loadOlderLocalTranscript prepends older hydrated entries", async () => {
  const state = createState({
    session: {
      active_thread_id: "thread-1",
      transcript: [
        {
          item_id: "item-2",
          kind: "agent_text",
          text: "latest reply",
          status: "completed",
          turn_id: "turn-2",
          tool: null,
        },
        {
          item_id: "item-3",
          kind: "user_text",
          text: "thanks",
          status: "completed",
          turn_id: "turn-3",
          tool: null,
        },
      ],
      transcript_truncated: true,
    },
    transcriptHydrationBaseSnapshot: {
      active_thread_id: "thread-1",
      transcript: [
        {
          item_id: "item-2",
          kind: "agent_text",
          text: "latest...",
          status: "completed",
          turn_id: "turn-2",
          tool: null,
        },
        {
          item_id: "item-3",
          kind: "user_text",
          text: "thanks",
          status: "completed",
          turn_id: "turn-3",
          tool: null,
        },
      ],
      transcript_truncated: true,
    },
    transcriptHydrationEntries: new Map([
      ["item-2", {
        item_id: "item-2",
        kind: "agent_text",
        text: "latest reply",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      }],
      ["item-3", {
        item_id: "item-3",
        kind: "user_text",
        text: "thanks",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      }],
    ]),
    transcriptHydrationOrder: ["item-2", "item-3"],
    transcriptHydrationOlderCursor: "c1",
    transcriptHydrationSignature: "signature-1",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  });
  const progress = [];

  await loadOlderLocalTranscript(state, {
    async fetchPage({ threadId, before }) {
      assert.equal(threadId, "thread-1");
      assert.equal(before, "c1");
      return {
        thread_id: "thread-1",
        prev_cursor: null,
        entries: [
          {
            item_id: "item-1",
            kind: "user_text",
            text: "older question",
            status: "completed",
            turn_id: "turn-1",
            tool: null,
          },
        ],
      };
    },
    onProgress(nextSnapshot) {
      progress.push(nextSnapshot);
      state.session = nextSnapshot;
    },
  });

  assert.equal(state.transcriptHydrationOlderCursor, null);
  assert.equal(state.transcriptHydrationStatus, "complete");
  assert.deepEqual(
    progress.at(-1)?.transcript?.map((entry) => entry.item_id),
    ["item-1", "item-2", "item-3"]
  );
});

test("a synchronous older-page fetch failure releases its owned loading gate", async () => {
  const state = createState({
    transcriptHydrationOlderCursor: "older-cursor",
    transcriptHydrationStatus: "idle",
  });
  const errors = [];

  const result = await loadOlderLocalTranscript(state, {
    fetchPage() {
      throw new Error("synchronous older-page setup failure");
    },
    onError(error) {
      errors.push(error.message);
    },
    onProgress() {},
  });

  assert.equal(result, null);
  assert.deepEqual(errors, ["synchronous older-page setup failure"]);
  assert.equal(state.transcriptHydrationPromise, null);
  assert.equal(state.transcriptHydrationStatus, "idle");
});

// A cursor the relay can no longer read is not a failure to retry: retrying sends the
// same dead cursor. The surface rebuilds the window from the latest page instead.
test("a rejected older-page cursor asks for a reload rather than reporting a failure", async () => {
  const state = createState({
    transcriptHydrationOlderCursor: "tc1.gone.0",
    transcriptHydrationStatus: "idle",
  });
  const errors = [];
  const rejected = [];

  const result = await loadOlderLocalTranscript(state, {
    async fetchPage() {
      throw relayError("transcript cursor has expired", "transcript_cursor_rejected");
    },
    onError(error) {
      errors.push(error.message);
    },
    onCursorRejected(error) {
      rejected.push(error.code);
    },
    onProgress() {},
  });

  assert.equal(result, null);
  assert.deepEqual(errors, []);
  assert.deepEqual(rejected, ["transcript_cursor_rejected"]);
  assert.equal(state.transcriptHydrationPromise, null);
  assert.equal(state.transcriptHydrationStatus, "idle");
});

function windowWithOlderHistory() {
  const tail = {
    item_id: "item-2",
    kind: "agent_text",
    text: "latest reply",
    status: "completed",
    turn_id: "turn-2",
    tool: null,
  };
  return createState({
    session: { active_thread_id: "thread-1", transcript: [tail], transcript_truncated: true },
    transcriptHydrationBaseSnapshot: {
      active_thread_id: "thread-1",
      transcript: [tail],
      transcript_truncated: true,
    },
    transcriptHydrationEntries: new Map([["item-2", tail]]),
    transcriptHydrationOrder: ["item-2"],
    transcriptHydrationOlderCursor: "c1",
    transcriptHydrationSignature: "signature-1",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  });
}

const olderQuestionPage = {
  thread_id: "thread-1",
  prev_cursor: null,
  entries: [
    {
      item_id: "item-1",
      kind: "user_text",
      text: "older question",
      status: "completed",
      turn_id: "turn-1",
      tool: null,
    },
  ],
};

// The relay spent its provider budget on pages with no rows. Waiting for the reader to
// scroll again is the stall this answer exists to avoid: the loader asks again itself.
test("an older page the relay is still reading is asked for again without a new gesture", async () => {
  const state = windowWithOlderHistory();
  const requested = [];
  const errors = [];

  const result = await loadOlderLocalTranscript(state, {
    async fetchPage({ before }) {
      requested.push(before);
      if (requested.length === 1) {
        throw relayError("still reading", "transcript_history_pending");
      }
      return olderQuestionPage;
    },
    waitBeforeRetry: async () => {},
    onError(error) {
      errors.push(error.message);
    },
    onProgress(nextSnapshot) {
      state.session = nextSnapshot;
    },
  });

  assert.equal(result, false, "the oldest page arrived");
  assert.deepEqual(requested, ["c1", "c1"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(state.transcriptHydrationOrder, ["item-1", "item-2"]);
});

test("a thread switch during the wait stops asking for the page it left", async () => {
  const state = windowWithOlderHistory();
  const requested = [];

  const result = await loadOlderLocalTranscript(state, {
    async fetchPage({ before }) {
      requested.push(before);
      throw relayError("still reading", "transcript_history_pending");
    },
    waitBeforeRetry: async () => {
      state.session = { ...state.session, active_thread_id: "thread-2" };
    },
    onError() {},
    onProgress() {},
  });

  assert.equal(result, null);
  assert.deepEqual(requested, ["c1"]);
  assert.deepEqual(state.transcriptHydrationOrder, ["item-2"]);
});

test("an older-page request made during a streaming tail refresh pages once the refresh settles", async () => {
  // A streaming reply keeps the slot busy with tail refreshes; handing back the
  // tail's `undefined` made the loader back off as if nothing could load.
  const shellEntry = {
    item_id: "item-2",
    kind: "agent_text",
    text: "streaming...",
    status: "running",
    turn_id: "turn-2",
    tool: null,
    content_state: "omitted",
  };
  // A full window, so the refresh does not also backfill older pages itself.
  const loaded = Array.from({ length: 12 }, (_, index) => ({
    item_id: `loaded-${index}`,
    kind: "agent_text",
    text: `loaded ${index}`,
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    content_state: "full",
  }));
  const state = createState({
    session: { active_thread_id: "thread-1", active_turn_id: "turn-2" },
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map(
      [...loaded, shellEntry].map((entry) => [entry.item_id, entry])
    ),
    transcriptHydrationOrder: [...loaded.map((entry) => entry.item_id), "item-2"],
    transcriptHydrationOlderCursor: "cursor-older",
    transcriptHydrationSignature: "thread-1|prior",
    transcriptHydrationTailReady: true,
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_truncated: true,
    transcript: [...loaded, shellEntry],
  };
  let releaseTail;
  const tailSettled = hydrateLocalTranscript(state, snapshot, {
    fetchPage: () => new Promise((resolve) => {
      releaseTail = () => resolve({
        thread_id: "thread-1",
        prev_cursor: "cursor-older",
        entries: [...loaded, { ...shellEntry, text: "streaming body so far", content_state: "full" }],
      });
    }),
    onProgress(nextSnapshot) {
      state.session = nextSnapshot;
    },
  });
  assert.equal(state.transcriptHydrationStatus, "loading", "precondition: the tail refresh holds the slot");

  const olderRequests = [];
  const older = loadOlderLocalTranscript(state, {
    async fetchPage({ threadId, before }) {
      olderRequests.push(before);
      return {
        thread_id: threadId,
        prev_cursor: "cursor-oldest",
        entries: [{
          item_id: "item-1",
          kind: "user_text",
          text: "older question",
          status: "completed",
          turn_id: "turn-1",
          tool: null,
        }],
      };
    },
    onProgress(nextSnapshot) {
      state.session = nextSnapshot;
    },
  });
  releaseTail();
  await tailSettled;

  assert.equal(await older, true, "the older page loads after the tail refresh instead of reporting no progress");
  assert.deepEqual(olderRequests, ["cursor-older"]);
  assert.deepEqual(
    state.session.transcript.map((entry) => entry.item_id),
    ["item-1", ...loaded.map((entry) => entry.item_id), "item-2"]
  );
});

test("clearTranscriptHydration resets local hydration state", () => {
  const state = createState({
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationEntries: new Map([["item-1", { item_id: "item-1" }]]),
    transcriptHydrationOrder: ["item-1"],
    transcriptHydrationOlderCursor: "c5",
    transcriptHydrationPromise: Promise.resolve(),
    transcriptHydrationSignature: "signature-1",
    transcriptHydrationStatus: "loading",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  });

  clearTranscriptHydration(state);

  assert.equal(state.transcriptHydrationBaseSnapshot, null);
  assert.equal(state.transcriptHydrationEntries.size, 0);
  assert.deepEqual(state.transcriptHydrationOrder, []);
  assert.equal(state.transcriptHydrationOlderCursor, null);
  assert.equal(state.transcriptHydrationPromise, null);
  assert.equal(state.transcriptHydrationSignature, null);
  assert.equal(state.transcriptHydrationStatus, "idle");
  assert.equal(state.transcriptHydrationTailReady, false);
  assert.equal(state.transcriptHydrationThreadId, null);
});

test("switching local threads retains the loaded window and restores it on switch-back", () => {
  const olderEntry = (id) => ({
    item_id: id,
    kind: "agent_text",
    text: `body-${id}`,
    status: "completed",
    turn_id: `turn-${id}`,
    tool: null,
    content_state: "full",
  });
  const state = createState({
    session: { active_thread_id: "thread-A" },
    transcriptHydrationThreadId: "thread-A",
    transcriptHydrationEntries: new Map([
      ["a1", olderEntry("a1")],
      ["a2", olderEntry("a2")],
      ["a3", olderEntry("a3")],
    ]),
    transcriptHydrationOrder: ["a1", "a2", "a3"],
    transcriptHydrationOlderCursor: "c5",
    transcriptHydrationSignature: "thread-A|sig",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
  });

  // Switch to thread B: A's window is stashed, the live slot is cleared for B.
  switchTranscriptHydrationThread(state, "thread-B");
  assert.deepEqual(state.transcriptHydrationOrder, []);
  assert.equal(state.transcriptHydrationThreadId, "thread-B");

  // B loads only its tail.
  state.transcriptHydrationEntries = new Map([["b1", olderEntry("b1")]]);
  state.transcriptHydrationOrder = ["b1"];
  state.transcriptHydrationOlderCursor = null;
  state.transcriptHydrationTailReady = true;

  // Switch back to A: the older window is restored without a refetch.
  switchTranscriptHydrationThread(state, "thread-A");
  assert.deepEqual(state.transcriptHydrationOrder, ["a1", "a2", "a3"]);
  assert.equal(state.transcriptHydrationOlderCursor, "c5");
  assert.equal(state.transcriptHydrationTailReady, true);

  // A fresh compact snapshot for A merges its live tail onto the restored window
  // (older history kept, newest entry added) — not a tail-only reset.
  state.session = { active_thread_id: "thread-A" };
  const merged = restoreHydratedTranscript(state, {
    active_thread_id: "thread-A",
    transcript_revision: 40,
    transcript_truncated: true,
    transcript: [olderEntry("a4")],
  });
  assert.deepEqual(
    merged.transcript.map((entry) => entry.item_id),
    ["a1", "a2", "a3", "a4"],
    "the restored older window coexists with the freshly-merged tail"
  );
});

test("a DELTA-joined entry must also survive a stale tail-page merge", async () => {
  // The sibling test above covers the snapshot flavor of this race, and it passes
  // only because a concurrent SNAPSHOT re-keys `transcriptHydrationSignature`, so
  // hydrateTranscript's freshness gate catches the stale page and discards it.
  //
  // A live SSE delta is invisible to that gate: `applyTranscriptDeltaToWindow`
  // writes `entries`/`order` IN PLACE and never touches the signature. So the
  // gate sees nothing changed, the stale tail page merges anyway, the merge
  // resets `order` to the page's ids, and the delta's entry is orphaned in the
  // map forever — the reply the user is watching stream simply vanishes.
  const itemA = {
    item_id: "item-A",
    kind: "agent_text",
    text: null,
    status: "running",
    turn_id: "turn-1",
    tool: null,
    content_state: "omitted",
  };
  const state = createState({
    session: { active_thread_id: "thread-1", active_turn_id: "turn-1" },
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map([["item-A", { ...itemA }]]),
    transcriptHydrationOrder: ["item-A"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "thread-1|turn-1|1|item-A|agent_text|turn-1||||",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: 10,
  });

  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  const hydrationPromise = hydrateLocalTranscript(
    state,
    {
      active_thread_id: "thread-1",
      active_turn_id: "turn-1",
      transcript_revision: 11,
      transcript_truncated: true,
      transcript: [{ ...itemA, text: "shell..." }],
    },
    {
      async fetchPage() {
        await pageGate;
        // Stale: built before item-B existed, so it carries only item-A.
        return {
          thread_id: "thread-1",
          prev_cursor: null,
          entries: [
            {
              item_id: "item-A",
              kind: "agent_text",
              text: "A full body",
              status: "completed",
              turn_id: "turn-1",
              tool: null,
            },
          ],
        };
      },
      onProgress(next) {
        state.session = next;
      },
    }
  );

  // While the fetch is in flight the next turn's reply starts streaming over SSE.
  await new Promise((resolve) => setImmediate(resolve));
  appendTranscriptDelta(state, {
    thread_id: "thread-1",
    item_id: "item-B",
    delta: "the reply is streaming",
    delta_kind: "agent_text",
    text_offset: 0,
    turn_id: "turn-2",
  });
  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["item-A", "item-B"],
    "precondition: the delta joined the order while the fetch was in flight"
  );

  releasePage();
  await hydrationPromise;

  assert.deepEqual(
    state.transcriptHydrationOrder,
    ["item-A", "item-B"],
    "a delta-joined entry must survive the tail-page merge, in place"
  );
  assert.equal(
    state.transcriptHydrationEntries.get("item-B")?.text,
    "the reply is streaming",
    "and keep the streamed body it had accumulated"
  );
});

// The bug this pins, reported as "codex/cursor can't render the last message
// after a long task; Cmd+R fixes it". Both surfaces, and waiting never helps.
//
// The tail fetch is armed at revision R, which sets
// `transcriptHydrationFetchedRevision = R` at ARM time. The turn then ends. The
// turn-end snapshot clears `active_turn_id`, which is part of the hydration
// SIGNATURE — but the relay bumps `transcript_revision` only on transcript
// WRITES, so the revision is still R. The in-flight page therefore resolves
// against a changed signature and is discarded.
//
// Discarding is right (merging a page fetched against a stale tail would orphan
// a concurrently-joined entry). What is wrong is that the discard left
// `fetchedRevision` at R, so the once-per-revision re-arm gate reads
// "already fetched at R" forever — and no later snapshot advances the revision,
// because the transcript is finished. The final entry stays `omitted` and
// renders as the `•••` shell until a reload, whose cold window bypasses the
// gate entirely.

// The bug this pins, from review: the settled-turn tail repair records WHICH
// revision the cached bodies came from, and that recording was folded into a
// branch that only runs when the tail page has no older history above it
// (`prev_cursor == null`). Every long conversation's tail page has older
// history — which is exactly the "long task" case the repair exists for — so
// the revision was never recorded, the freshness check bailed on its own
// null-guard, and the stale mid-turn body was kept. The fix skipped its target.
//
// `prev_cursor == null` answers "have we reached the top of history", which is
// a different question from "which revision are these bodies from".
test("a turn-end signature change discards an in-flight tail fetch and re-arms at the same revision", async () => {
  const REVISION = 42;
  const olderEntry = {
    item_id: "item-older",
    kind: "user_text",
    text: "start the task",
    status: "completed",
    turn_id: "turn-1",
    tool: null,
    content_state: "full",
  };
  const omittedTail = {
    item_id: "item-final",
    kind: "agent_text",
    text: "The relay boots with ...",
    status: "completed",
    turn_id: "turn-final",
    tool: null,
    content_state: "omitted",
  };
  const state = createState({
    session: { active_thread_id: "thread-1", active_turn_id: "turn-final" },
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationEntries: new Map([["item-older", olderEntry]]),
    transcriptHydrationOrder: ["item-older"],
    transcriptHydrationOlderCursor: "older-cursor",
    transcriptHydrationSignature: "thread-1|prior",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
  });
  const midTurnSnapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-final",
    transcript_revision: REVISION,
    transcript_truncated: true,
    transcript: [olderEntry, omittedTail],
  };
  const turnEndSnapshot = {
    active_thread_id: "thread-1",
    active_turn_id: null,
    transcript_revision: REVISION,
    transcript_truncated: true,
    transcript: [olderEntry, { ...omittedTail, text: null }],
  };
  const fullText =
    "The relay boots with the complete provider and transcript state.";

  let tailFetchCalls = 0;
  let releasePage;
  const pageGate = new Promise((resolve) => {
    releasePage = resolve;
  });
  const fetchPage = async ({ before }) => {
    if (before != null) {
      return { thread_id: "thread-1", prev_cursor: null, entries: [] };
    }
    tailFetchCalls += 1;
    if (tailFetchCalls === 1) {
      await pageGate;
      return {
        thread_id: "thread-1",
        prev_cursor: "older-cursor",
        entries: [
          olderEntry,
          {
            item_id: "item-final",
            kind: "agent_text",
            text: "mid-turn stale body from the first fetch",
            status: "completed",
            turn_id: "turn-final",
            tool: null,
          },
        ],
      };
    }
    return {
      thread_id: "thread-1",
      prev_cursor: "older-cursor",
      entries: [
        olderEntry,
        {
          item_id: "item-final",
          kind: "agent_text",
          text: fullText,
          status: "completed",
          turn_id: "turn-final",
          tool: null,
        },
      ],
    };
  };
  const onProgress = (next) => {
    state.session = next;
  };

  const firstPromise = hydrateLocalTranscript(state, midTurnSnapshot, {
    fetchPage,
    onProgress,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    state.transcriptHydrationFetchedRevision,
    REVISION,
    "mid-turn snapshot arms fetch at revision R"
  );
  assert.equal(tailFetchCalls, 1, "first tail fetch is in flight");

  const concurrentPromise = hydrateLocalTranscript(state, turnEndSnapshot, {
    fetchPage,
    onProgress,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    tailFetchCalls,
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
    state.session.transcript.find((entry) => entry.item_id === "item-final")?.text,
    null,
    "stale mid-turn page must be discarded, not merged"
  );

  // The merge path would have set tailReady after a successful page; after a
  // signature-mismatch discard the window is still considered ready for render.
  state.transcriptHydrationTailReady = true;

  await hydrateLocalTranscript(state, turnEndSnapshot, { fetchPage, onProgress });

  assert.equal(
    tailFetchCalls,
    2,
    "turn-end must re-arm a second tail fetch after the stale page is discarded"
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "item-final")?.text,
    fullText,
    "the re-armed fetch must land the authoritative turn-end text"
  );
});

test("a stale thread-A tail fetch must not clear thread-B's fetched-revision arm after a switch", async () => {
  const REVISION_A = 10;
  const REVISION_B = 20;
  const omittedA = {
    item_id: "a-tail",
    kind: "agent_text",
    text: "thread A shell...",
    status: "running",
    turn_id: "turn-a",
    tool: null,
    content_state: "omitted",
  };
  const omittedB = {
    item_id: "b-tail",
    kind: "agent_text",
    text: "thread B shell...",
    status: "running",
    turn_id: "turn-b",
    tool: null,
    content_state: "omitted",
  };
  const state = createState({
    session: { active_thread_id: "thread-A", active_turn_id: "turn-a" },
    transcriptHydrationThreadId: "thread-A",
    transcriptHydrationEntries: new Map([["a-tail", { ...omittedA }]]),
    transcriptHydrationOrder: ["a-tail"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationSignature: "thread-A|prior",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
  });
  const snapshotA = {
    active_thread_id: "thread-A",
    active_turn_id: "turn-a",
    transcript_revision: REVISION_A,
    transcript_truncated: true,
    transcript: [{ ...omittedA, text: null }],
  };
  const snapshotB = {
    active_thread_id: "thread-B",
    active_turn_id: "turn-b",
    transcript_revision: REVISION_B,
    transcript_truncated: true,
    transcript: [{ ...omittedB, text: null }],
  };
  const fullB = "thread B authoritative body after the switch";

  let releasePageA;
  let releasePageB;
  const pageGateA = new Promise((resolve) => {
    releasePageA = resolve;
  });
  const pageGateB = new Promise((resolve) => {
    releasePageB = resolve;
  });
  let tailFetchCallsB = 0;
  const fetchPage = async ({ threadId, before }) => {
    if (before != null) {
      return { thread_id: threadId, prev_cursor: null, entries: [] };
    }
    if (threadId === "thread-A") {
      await pageGateA;
      return {
        thread_id: "thread-A",
        prev_cursor: null,
        entries: [
          {
            item_id: "a-tail",
            kind: "agent_text",
            text: "stale thread-A body",
            status: "completed",
            turn_id: "turn-a",
            tool: null,
          },
        ],
      };
    }
    tailFetchCallsB += 1;
    await pageGateB;
    return {
      thread_id: "thread-B",
      prev_cursor: null,
      entries: [
        {
          item_id: "b-tail",
          kind: "agent_text",
          text: fullB,
          status: "completed",
          turn_id: "turn-b",
          tool: null,
        },
      ],
    };
  };
  const onProgress = (next) => {
    state.session = next;
  };

  const promiseA = hydrateLocalTranscript(state, snapshotA, { fetchPage, onProgress });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    state.transcriptHydrationFetchedRevision,
    REVISION_A,
    "thread A arms fetch at revision R"
  );

  switchTranscriptHydrationThread(state, "thread-B");
  // Session still reflects thread A until B's hydration publishes progress — the
  // stale page gate keys off session.active_thread_id, not the hydration slot.
  state.transcriptHydrationEntries = new Map([["b-tail", { ...omittedB }]]);
  state.transcriptHydrationOrder = ["b-tail"];
  state.transcriptHydrationOlderCursor = null;
  state.transcriptHydrationTailReady = true;

  const promiseB = hydrateLocalTranscript(state, snapshotB, { fetchPage, onProgress });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    state.transcriptHydrationFetchedRevision,
    REVISION_B,
    "thread B arms fetch at its revision"
  );
  assert.equal(tailFetchCallsB, 1, "thread B tail fetch is in flight");

  releasePageA();
  await promiseA;

  assert.equal(
    state.transcriptHydrationFetchedRevision,
    REVISION_B,
    "thread A's stale discard must not clear thread B's once-per-revision arm"
  );
  assert.equal(
    state.transcriptHydrationStatus,
    "loading",
    "thread A's stale settle must not release the loading status owned by thread B's request"
  );

  state.session = { active_thread_id: "thread-B", active_turn_id: "turn-b" };
  releasePageB();
  await promiseB;

  state.transcriptHydrationTailReady = true;
  await hydrateLocalTranscript(state, snapshotB, { fetchPage, onProgress });

  assert.equal(
    tailFetchCallsB,
    1,
    "thread B must not get overlapping same-revision tail fetches"
  );
  assert.equal(
    state.session.transcript.find((entry) => entry.item_id === "b-tail")?.text,
    fullB,
    "thread B keeps the authoritative body from its own fetch"
  );
});

test("hydrating a tail records its revision even when older history remains", async () => {
  const state = createState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-2",
    transcript_revision: 77,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-2",
        kind: "agent_text",
        text: "hello...",
        status: "completed",
        turn_id: "turn-2",
        tool: null,
      },
    ],
  };

  await hydrateLocalTranscript(state, snapshot, {
    async fetchPage({ before }) {
      return {
        thread_id: "thread-1",
        entries: [
          {
            item_id: "item-2",
            kind: "agent_text",
            text: "hello world",
            status: "completed",
            turn_id: "turn-2",
            tool: null,
          },
        ],
        // There IS more history above this page — the ordinary long-thread case.
        prev_cursor: before ? null : "older-cursor",
      };
    },
    onProgress: () => {},
  });

  assert.equal(
    state.transcriptHydrationBodyRevision,
    77,
    "these bodies came from revision 77, whatever sits above them"
  );
});
