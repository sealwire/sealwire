import test from "node:test";
import assert from "node:assert/strict";

import {
  hydrateLocalTranscript,
  loadOlderLocalTranscript,
} from "./hydration.js";
import {
  clearTranscriptHydration,
  restoreHydratedTranscript,
  switchTranscriptHydrationThread,
} from "./store.js";

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
      prev_cursor: 8,
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
      prev_cursor: 4,
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
      prev_cursor: 1,
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

  assert.deepEqual(requestedBefore, [null, 8, 4]);
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
  assert.equal(state.transcriptHydrationOlderCursor, 1);
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
    transcriptHydrationOlderCursor: 1,
    transcriptHydrationSignature: "signature-1",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
  });
  const progress = [];

  await loadOlderLocalTranscript(state, {
    async fetchPage({ threadId, before }) {
      assert.equal(threadId, "thread-1");
      assert.equal(before, 1);
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

test("clearTranscriptHydration resets local hydration state", () => {
  const state = createState({
    transcriptHydrationBaseSnapshot: { active_thread_id: "thread-1" },
    transcriptHydrationEntries: new Map([["item-1", { item_id: "item-1" }]]),
    transcriptHydrationOrder: ["item-1"],
    transcriptHydrationOlderCursor: 5,
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
    transcriptHydrationOlderCursor: 5,
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
  assert.equal(state.transcriptHydrationOlderCursor, 5);
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
