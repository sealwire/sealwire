import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHydratedTranscriptProgress,
  prepareTranscriptHydrationState,
  restoreHydratedTranscriptSnapshot,
} from "./shared/transcript-hydration-store.js";

function hydratedState(overrides = {}) {
  return {
    session: {
      active_thread_id: "thread-1",
      transcript_revision: 10,
    },
    transcriptHydrationBaseSnapshot: {
      active_thread_id: "thread-1",
      transcript_revision: 10,
    },
    transcriptHydrationEntries: new Map([
      [
        "item-1",
        {
          item_id: "item-1",
          kind: "user_text",
          text: "older prompt",
          status: "completed",
          turn_id: "turn-1",
          tool: null,
        },
      ],
      [
        "item-2",
        {
          item_id: "item-2",
          kind: "agent_text",
          text: "older reply",
          status: "completed",
          turn_id: "turn-2",
          tool: null,
        },
      ],
      [
        "item-3",
        {
          item_id: "item-3",
          kind: "command",
          text: `cargo test\n${"passed ".repeat(400)}`,
          status: "running",
          turn_id: "turn-3",
          tool: null,
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-1", "item-2", "item-3"],
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: "thread-1|turn-3|1|item-3|command|turn-3||||",
    transcriptHydrationStatus: "complete",
    transcriptHydrationTailReady: true,
    transcriptHydrationThreadId: "thread-1",
    ...overrides,
  };
}

test("restoreHydratedTranscriptSnapshot keeps older hydrated entries for compact same-thread snapshots", () => {
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_revision: 11,
    transcript_truncated: true,
    pending_approvals: [{ request_id: "approval-1" }],
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
  };

  const restored = restoreHydratedTranscriptSnapshot(state, snapshot);

  assert.deepEqual(
    restored.transcript.map((entry) => entry.item_id),
    ["item-1", "item-2", "item-3"]
  );
  assert.equal(restored.pending_approvals[0].request_id, "approval-1");
  assert.equal(restored.transcript.at(-1).status, "completed");
  assert.match(restored.transcript.at(-1).text, /passed passed/);
  assert.equal(restored.transcript_truncated, false);
});

test("prepareTranscriptHydrationState patches compact tail without clearing same-thread visible history", () => {
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_revision: 12,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
      {
        item_id: "item-4",
        kind: "agent_text",
        text: "done",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);

  assert.equal(prepared.shouldHydrate, false);
  assert.deepEqual(state.transcriptHydrationOrder, ["item-1", "item-2", "item-3", "item-4"]);
  assert.equal(state.transcriptHydrationEntries.get("item-3").status, "completed");
  assert.match(state.transcriptHydrationEntries.get("item-3").text, /passed passed/);
  assert.equal(state.transcriptHydrationEntries.get("item-4").text, "done");
});

test("buildHydratedTranscriptProgress still merges history when live revision has advanced", () => {
  const state = hydratedState({
    session: {
      active_thread_id: "thread-1",
      transcript_revision: 20,
    },
    transcriptHydrationBaseSnapshot: {
      active_thread_id: "thread-1",
      active_turn_id: "turn-3",
      transcript_revision: 10,
      transcript_truncated: true,
      transcript: [
        {
          item_id: "item-3",
          kind: "command",
          text: "cargo test\npassed ...",
          status: "running",
          turn_id: "turn-3",
          tool: null,
        },
      ],
    },
  });

  const progress = buildHydratedTranscriptProgress(state);

  assert.deepEqual(
    progress.transcript.map((entry) => entry.item_id),
    ["item-1", "item-2", "item-3"]
  );
  assert.match(progress.transcript.at(-1).text, /passed passed/);
});
