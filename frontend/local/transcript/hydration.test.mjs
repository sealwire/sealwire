import test from "node:test";
import assert from "node:assert/strict";

import {
  hydrateLocalTranscript,
  loadOlderLocalTranscript,
} from "./hydration.js";
import { clearTranscriptHydration } from "./store.js";

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
