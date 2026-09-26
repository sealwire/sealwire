import test from "node:test";
import assert from "node:assert/strict";

import { prepareTranscriptHydrationState } from "./transcript-hydration-store.js";

// The bug this pins, reported as "codex and cursor often can't render the last
// message after a long task; I have to Cmd+R". Both surfaces.
//
// There is no per-entry completion event in the relay -- `transcript_entry_*`
// is never produced by the Rust side -- so a turn's final text reaches a client
// ONLY inside a session snapshot, where it is clipped to `max_transcript_chars`
// (1600 local, 1200 remote) and marked `preview`.
//
// The client decides whether to repair that with `cachedLen < previewLen`. But
// the preview is clipped to a FIXED cap, so `previewLen` is that constant for
// every long message: the test is really `cachedLen >= 1600`. Any cached body
// over the cap is therefore trusted forever, however stale it is -- and a
// mid-turn body is exactly that. The cache then wins the merge (the longer body
// is kept), so the final message renders as its mid-turn tail until a reload
// refetches the authoritative page.
//
// Cursor makes it certain rather than likely: its bridge emits no transcript
// deltas at all for a foreground thread, so the cached body can only ever be a
// mid-turn page. Claude escapes it because its final message arrives complete
// under an item id the client has never seen, so there is no cached body to win.
function stateWithCachedMidTurnBody(chars) {
  return {
    transcriptHydrationThreadId: "thread-1",
    transcriptHydrationOrder: ["item-9"],
    transcriptHydrationEntries: new Map([
      [
        "item-9",
        {
          item_id: "item-9",
          kind: "agent_text",
          status: "completed",
          content_state: "full",
          text: "x".repeat(chars),
        },
      ],
    ]),
    transcriptHydrationOlderCursor: null,
    transcriptHydrationPromise: null,
    transcriptHydrationSignature: null,
    transcriptHydrationStatus: "idle",
    transcriptHydrationTailReady: true,
    transcriptHydrationBaseSnapshot: null,
    // Already hydrated at an earlier revision — the body predates the turn's end.
    transcriptHydrationBodyRevision: 40,
  };
}

const PREVIEW_CAP = 1600;

function settledSnapshot() {
  return {
    active_thread_id: "thread-1",
    active_turn_id: null, // the turn is over; this is the final text
    transcript_revision: 41,
    transcript_truncated: true,
    transcript: [
      {
        item_id: "item-9",
        kind: "agent_text",
        status: "completed",
        content_state: "preview",
        text: "x".repeat(PREVIEW_CAP),
      },
    ],
  };
}

test("a settled turn re-checks a tail whose cached body only beats the preview cap", () => {
  // 3000 chars: longer than the cap, and so trusted — but it is the body from
  // the middle of the turn, not the 8000-char message the user is waiting for.
  const state = stateWithCachedMidTurnBody(3000);
  prepareTranscriptHydrationState(state, settledSnapshot());

  assert.equal(
    state.transcriptUnresolvedRows.has("item-9"),
    true,
    "being longer than a fixed-size preview is not evidence of being current"
  );
});

// What stops this becoming a storm is the row's own read record: a body read at
// this revision is current, however many snapshots repeat it.
test("it does not owe the row again once it was read at this revision", () => {
  const state = stateWithCachedMidTurnBody(3000);
  state.transcriptRowBodyRevisions = new Map([["item-9", { revision: 41, at: 0 }]]);

  const prepared = prepareTranscriptHydrationState(state, settledSnapshot());

  assert.equal(state.transcriptUnresolvedRows.has("item-9"), false, "one repair per revision, not one per render");
  assert.equal(prepared.shouldHydrate, false);
});

// And mid-turn it must stay quiet: a revision bumps on every delta, so
// re-checking while the turn runs would fetch once per chunk.
test("it stays quiet while the turn is still running", () => {
  const state = stateWithCachedMidTurnBody(3000);
  const prepared = prepareTranscriptHydrationState(state, {
    ...settledSnapshot(),
    active_turn_id: "turn-7",
  });

  assert.equal(state.transcriptUnresolvedRows.has("item-9"), false, "the stream owns the tail while it streams");
  assert.equal(prepared.shouldHydrate, false);
});

// The bug this pins, from review: the repair above records which revision the
// cached bodies came from only when the tail page had NO older history
// (`prev_cursor == null`). A long transcript's tail page always has older
// history — which is precisely the "long task" case this repair exists for — so
// `fetchedRevision` stayed null, the freshness check bailed on its own
// null-guard, and the stale mid-turn body was kept. The fix targeted everything
// except its target.
test("a long transcript's tail is still re-checked when the turn settles", () => {
  const state = stateWithCachedMidTurnBody(3000);
  // Hydrated from a page that had older history above it, as any long
  // conversation's tail page does.
  state.transcriptHydrationOlderCursor = "older-cursor";

  prepareTranscriptHydrationState(state, settledSnapshot());

  assert.equal(
    state.transcriptUnresolvedRows.has("item-9"),
    true,
    "having history above the tail says nothing about whether the tail is current"
  );
});
