import test from "node:test";
import assert from "node:assert/strict";

import {
  detectDeferredThreadPromotion,
  shouldRebindPinnedViewOnPromotion,
} from "./shared/thread-promotion.js";

// --- detection (authoritative: snapshot's active_thread_promoted_from) -------

test("detects a promotion when the snapshot's promoted_from names our previous thread", () => {
  assert.deepEqual(
    detectDeferredThreadPromotion({
      previousThreadId: "claude-pending-5",
      nextThreadId: "real-abc",
      nextThreadPromotedFrom: "claude-pending-5",
    }),
    { from: "claude-pending-5", to: "real-abc" }
  );
});

test("a pending -> real transition WITHOUT the authoritative field is a plain thread switch", () => {
  // The id sequence alone is indistinguishable from another client switching
  // the relay to an unrelated thread — inferring promotion from adjacency
  // rekeys scroll state onto the wrong thread and can repin observers.
  // Only the snapshot's own lineage field may classify it.
  assert.equal(
    detectDeferredThreadPromotion({
      previousThreadId: "claude-pending-5",
      nextThreadId: "real-abc",
    }),
    null
  );
  assert.equal(
    detectDeferredThreadPromotion({
      previousThreadId: "claude-pending-5",
      nextThreadId: "real-abc",
      nextThreadPromotedFrom: null,
    }),
    null
  );
});

test("promoted_from naming a DIFFERENT thread than ours is a switch, not our promotion", () => {
  // We were viewing thread X; the relay's active thread became Y which was
  // (at some point) promoted from pending P. For THIS client that is an
  // ordinary switch and must keep jump/restore semantics.
  assert.equal(
    detectDeferredThreadPromotion({
      previousThreadId: "thread-x",
      nextThreadId: "real-abc",
      nextThreadPromotedFrom: "claude-pending-5",
    }),
    null
  );
});

test("no detection for degenerate inputs", () => {
  assert.equal(
    detectDeferredThreadPromotion({
      previousThreadId: "real-abc",
      nextThreadId: "real-abc",
      nextThreadPromotedFrom: "claude-pending-5",
    }),
    null
  );
  assert.equal(detectDeferredThreadPromotion({}), null);
  assert.equal(detectDeferredThreadPromotion(), null);
});

// --- pinned-view rebind ------------------------------------------------------

test("rebinds a pinned observer on an authoritative promotion — including idle/late-observed ones", () => {
  // With authority there is no need for turn/transcript corroboration: a
  // promotion first observed after the turn completed (reconnect, snapshot
  // coalescing) must STILL free the observer from the obsolete pending id.
  const promotion = { from: "claude-pending-5", to: "real-abc" };
  assert.equal(
    shouldRebindPinnedViewOnPromotion({
      pinnedThreadId: "claude-pending-5",
      promotion,
    }),
    true
  );
});

test("does not rebind when the observer pinned a different thread (or none, or no promotion)", () => {
  const promotion = { from: "claude-pending-5", to: "real-abc" };
  assert.equal(
    shouldRebindPinnedViewOnPromotion({ pinnedThreadId: "other-thread", promotion }),
    false
  );
  assert.equal(
    shouldRebindPinnedViewOnPromotion({ pinnedThreadId: null, promotion }),
    false
  );
  assert.equal(
    shouldRebindPinnedViewOnPromotion({ pinnedThreadId: "claude-pending-5" }),
    false
  );
  assert.equal(shouldRebindPinnedViewOnPromotion(), false);
});
