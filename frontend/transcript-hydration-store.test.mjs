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

test("restoreHydratedTranscriptSnapshot hides an uncovered emergency shell until hydration", () => {
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
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
        content_state: "preview",
      },
      {
        item_id: "item-4",
        kind: "agent_text",
        // The relay clipped this to a 24-char identity shell and marked it
        // omitted; the trailing "..." is NOT what classifies it.
        text: "The relay boots with ...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const restored = restoreHydratedTranscriptSnapshot(state, snapshot);
  const newEntry = restored.transcript.find((entry) => entry.item_id === "item-4");

  assert.ok(newEntry, "the new entry identity must remain visible for ordering and status");
  assert.equal(newEntry.text, null, "the clipped shell must not be rendered as message content");
  assert.equal(newEntry.content_state, "omitted", "the omitted state must survive for the renderer");
  assert.equal(
    restored.transcript_truncated,
    true,
    "the snapshot must stay truncated so the authoritative page is fetched"
  );
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

test("buildHydratedTranscriptProgress preserves live session metadata", () => {
  const state = hydratedState({
    session: {
      active_thread_id: "thread-1",
      transcript_revision: 20,
      pending_approvals: [{ request_id: "approval-1" }],
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

  assert.equal(progress.pending_approvals[0].request_id, "approval-1");
  assert.equal(progress.transcript_revision, 20);
});

test("buildHydratedTranscriptProgress returns null when thread ids differ", () => {
  const state = hydratedState({
    session: {
      active_thread_id: "thread-2",
    },
  });

  const progress = buildHydratedTranscriptProgress(state);

  assert.equal(progress, null);
});

test("prepareTranscriptHydrationState re-arms hydration when a new oversized entry joins a hydrated thread", () => {
  // Already hydrated (tailReady) — exactly the steady state a few hundred ms into
  // a turn. A new, truncated final message must re-arm the fetch path even though
  // the thread was previously "complete".
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-final",
        kind: "agent_text",
        text: `${"Z".repeat(1200)}...`,
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, true);
  assert.equal(prepared.alreadyComplete, false);
  assert.equal(prepared.existingPromise, null);
  // The fetch path is re-armed...
  assert.equal(prepared.patch.transcriptHydrationTailReady, false);
  // ...without discarding the already-hydrated history (instant render).
  assert.deepEqual(prepared.patch.transcriptHydrationOrder, [
    "item-1",
    "item-2",
    "item-3",
    "item-final",
  ]);
});

test("prepareTranscriptHydrationState re-arms the newest entry even when a prior fetch left its promise parked", () => {
  // Regression: the in-flight guard that fixed the freeze keyed off
  // `transcriptHydrationPromise != null` as well as status. But a tail fetch's
  // promise is only cleared when its signature still matches
  // (createClearedTranscriptHydrationPromisePatch). When a NEW (newest) message
  // joins while a fetch is in flight, the signature changes, so on settle the
  // promise is never cleared — it leaks. Status, however, settles to
  // complete/idle (no fetch is actually running). If a parked promise can veto
  // re-arming, the newest message never fetches its full text and is stuck on the
  // `...` preview/omitted shell forever. A settled status (NOT "loading") must
  // re-arm regardless of a leftover promise.
  const state = hydratedState({
    transcriptHydrationPromise: Promise.resolve(),
    transcriptHydrationStatus: "complete",
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-omitted",
        kind: "agent_text",
        text: "The relay boots with ...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(
    prepared.shouldHydrate,
    true,
    "a settled (non-loading) status must re-arm the newest entry even with a leftover promise"
  );
  assert.equal(prepared.alreadyComplete, false);
  assert.equal(prepared.existingPromise, null);
  assert.equal(prepared.patch.transcriptHydrationTailReady, false);
});

test("prepareTranscriptHydrationState does not re-hydrate when only an existing entry's preview shrinks", () => {
  // Same shape as the signature already on file (single item-3), only the
  // compacted preview text differs. The cached full text already covers it, so
  // no re-fetch — this is what keeps repeated snapshots of one turn loop-safe.
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-3",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npa ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, false);
  assert.equal(prepared.alreadyComplete, true);
});

test("prepareTranscriptHydrationState re-arms hydration when an OMITTED entry joins a hydrated thread (live path)", () => {
  // Live path: a fully-hydrated, "complete" thread receives a new entry the relay
  // dropped to an identity shell (content_state omitted). It must re-arm the
  // fetch path, keep the already-visible history, and present the omitted entry
  // with no body so the renderer shows a loading placeholder (not the shell).
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-omitted",
        kind: "agent_text",
        // 24-char identity shell text the relay shipped; must never render.
        text: "The relay boots with ...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, true);
  assert.equal(prepared.alreadyComplete, false);
  assert.equal(prepared.existingPromise, null);
  assert.equal(prepared.patch.transcriptHydrationTailReady, false);
  // History preserved + omitted entry appended in order.
  assert.deepEqual(prepared.patch.transcriptHydrationOrder, [
    "item-1",
    "item-2",
    "item-3",
    "item-omitted",
  ]);
  // The omitted entry's clipped shell text is dropped so the renderer shows a
  // loading placeholder, while identity/status/state survive for in-place
  // replacement after hydration.
  const omitted = prepared.patch.transcriptHydrationEntries.get("item-omitted");
  assert.equal(omitted.text, null);
  assert.equal(omitted.content_state, "omitted");
  assert.equal(omitted.status, "completed");
});

test("prepareTranscriptHydrationState does not re-fetch a still-omitted tail again at the same revision", () => {
  // candidate #3: a long entry the relay keeps shipping omitted while it streams
  // bumps transcript_revision on every delta. Re-fetching is useful once per
  // revision (it pulls the latest partial full text), but the settle of one fetch
  // re-fires onProgress -> renderSession -> hydrate at the SAME revision, and
  // status-only snapshots re-describe the same omitted tail. Those must NOT re-arm
  // an identical fetch — that is an RTT-paced storm against the relay.
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: null,
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "omitted",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: 30,
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 30,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: "shell...",
        status: "running",
        turn_id: "turn-9",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(
    prepared.shouldHydrate,
    false,
    "already fetched at this revision — a still-omitted tail must not re-fetch until the revision advances"
  );
});

test("prepareTranscriptHydrationState re-fetches the omitted tail once the revision advances, recording it", () => {
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: null,
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "omitted",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationFetchedRevision: 30,
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 31,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: "shell...",
        status: "running",
        turn_id: "turn-9",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(
    prepared.shouldHydrate,
    true,
    "a bumped revision means new data — re-fetch the latest partial"
  );
  assert.equal(
    prepared.patch.transcriptHydrationFetchedRevision,
    31,
    "the fetched revision is recorded so same-revision settles don't re-fetch"
  );
});

test("prepareTranscriptHydrationState does not hydrate when a new FULL entry ending in '...' joins", () => {
  // P1.2: a genuine, complete message whose text legitimately ends in "..." is
  // content_state full. Adding it to a hydrated thread must NOT trigger a wasteful
  // re-fetch, and its text must be preserved verbatim (never nulled/treated as a
  // shell), even though the snapshot is flagged truncated for other reasons.
  const state = hydratedState();
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-4",
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-3",
        kind: "command",
        text: "cargo test\npassed ...",
        status: "completed",
        turn_id: "turn-3",
        tool: null,
        content_state: "preview",
      },
      {
        item_id: "item-trailing",
        kind: "agent_text",
        text: "All set. Let me know if you want more...",
        status: "completed",
        turn_id: "turn-4",
        tool: null,
        content_state: "full",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);

  assert.equal(prepared.shouldHydrate, false, "a full '...'-ending entry must not re-hydrate");
  const full = prepared.patch.transcriptHydrationEntries.get("item-trailing");
  assert.equal(full.text, "All set. Let me know if you want more...");
  assert.equal(full.content_state, "full");
});

test("re-hydrates when an already-hydrated full-but-partial entry is later compacted to omitted (streaming settle)", () => {
  // Review finding F1: content_state `full` means "complete as of this
  // revision", not "final". An entry hydrated mid-stream as full+partial, then
  // later shelled to `omitted` by the server (its body grew/over budget), must
  // re-hydrate — not stay frozen on the stale partial body promoted back to full.
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: "PARTIAL",
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "full",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
  });
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 30,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: "PARTIALplusmuchmore th...",
        status: "completed",
        turn_id: "turn-9",
        tool: null,
        content_state: "omitted",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);

  assert.equal(prepared.shouldHydrate, true, "an omitted same-id transition must re-hydrate");
  assert.equal(prepared.alreadyComplete, false);
  // The clipped shell text must never become the rendered body.
  const merged = state.transcriptHydrationEntries.get("item-x");
  assert.notEqual(merged.text, "PARTIALplusmuchmore th...");
});

test("a longer preview replaces a stale shorter cached body and re-hydrates", () => {
  // Review finding F1 (preview variant): a stale, shorter cached `full` body must
  // not win over the server's newer, longer preview, and the entry must still
  // re-hydrate for the remaining text.
  const state = hydratedState({
    transcriptHydrationEntries: new Map([
      [
        "item-x",
        {
          item_id: "item-x",
          kind: "agent_text",
          text: "short",
          status: "running",
          turn_id: "turn-9",
          tool: null,
          content_state: "full",
        },
      ],
    ]),
    transcriptHydrationOrder: ["item-x"],
    transcriptHydrationSignature: "thread-1|turn-9|1|item-x|agent_text|turn-9||||",
  });
  const longPreview = `${"Z".repeat(1200)}...`;
  const snapshot = {
    active_thread_id: "thread-1",
    active_turn_id: "turn-9",
    transcript_revision: 30,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-x",
        kind: "agent_text",
        text: longPreview,
        status: "running",
        turn_id: "turn-9",
        tool: null,
        content_state: "preview",
      },
    ],
  };

  const prepared = prepareTranscriptHydrationState(state, snapshot);
  Object.assign(state, prepared.patch);

  assert.equal(prepared.shouldHydrate, true, "a longer preview over a stale cache must re-hydrate");
  assert.equal(
    state.transcriptHydrationEntries.get("item-x").text,
    longPreview,
    "the longer preview must win over the stale shorter cached body"
  );
});
