import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSCRIPT_SCROLL_ACTION_EVENT,
  applyTranscriptScrollAction,
} from "./shared/transcript-scroll.js";
import {
  RESTICK_AT_BOTTOM_PX,
  classifyScrollIntent,
  classifyTranscriptScrollAction,
} from "./shared/stick-to-bottom.js";

// The live stick-to-bottom follower (frontend/shared/stick-to-bottom.js) is a
// small hand-rolled ResizeObserver-driven engine (we dropped the
// `use-stick-to-bottom` library — see that file's header for why). Its DOM wiring
// is exercised end-to-end by scripts/browser-stick-to-bottom-e2e.mjs. Two
// unit-testable cores remain: (1) the intent CONTRACT it consumes from
// transcript-scroll.js (jump-bottom / rejoin-bottom -> stick, restore-thread ->
// preserve explicit history-reading intent); (2) its pure scroll-gesture policy
// `classifyScrollIntent`. This is plain bottom-follow: no top-anchor, no hold, so
// anchor-user is retired. These tests pin those.

test("programmatic actions preserve explicit bottom-follow intent", () => {
  assert.equal(classifyTranscriptScrollAction({ kind: "jump-bottom" }), "stick");
  assert.equal(classifyTranscriptScrollAction({ kind: "rejoin-bottom" }), "stick");
  assert.equal(classifyTranscriptScrollAction({ kind: "restore-thread" }), "unstick");
  assert.equal(classifyTranscriptScrollAction({ kind: "preserve" }), "none");
});

test("restore-thread never re-sticks within the button's old 5-160px band", () => {
  // Distance is deliberately irrelevant: `restore-thread` is only emitted for
  // a cached `followBottom: false` state. The semantic intent wins over the
  // floating button's much broader visual threshold.
  for (const distance of [5, 40, 80, 159, 160]) {
    assert.equal(
      classifyTranscriptScrollAction({ distance, kind: "restore-thread" }),
      "unstick",
      `${distance}px from bottom must remain history-reading`
    );
  }
});

// --- classifyScrollIntent: the pure scroll-gesture policy ------------------

test("interacting + any upward move escapes — even a tiny slow-drag step", () => {
  // Regression: a slow touch/scrollbar drag emits many sub-6px upward moves. The
  // escape must NOT require a big single-event delta — while a pointer is DOWN,
  // ANY upward scroll un-sticks. (Prior bug: only a >viewport jump escaped.)
  for (const distance of [1, 5, 30, 300, 5000]) {
    assert.equal(
      classifyScrollIntent({ scrolledUp: true, distance, interacting: true, stuck: true }),
      "unstick",
      `interacting upward move at distance ${distance} must escape`
    );
  }
});

test("interacting + reaching the bottom re-sticks; holding off-bottom does nothing", () => {
  assert.equal(
    classifyScrollIntent({ scrolledUp: false, distance: RESTICK_AT_BOTTOM_PX, interacting: true, stuck: false }),
    "stick"
  );
  assert.equal(
    classifyScrollIntent({ scrolledUp: false, distance: 400, interacting: true, stuck: false }),
    "none"
  );
});

test("NOT interacting + stuck: an unattributed scroll is layout churn -> re-glue", () => {
  // Snapshot re-render / virtualizer re-measure can nudge scrollTop upward; that
  // is not the reader escaping, so we re-pin rather than un-stick.
  assert.equal(
    classifyScrollIntent({ scrolledUp: true, distance: 40, interacting: false, stuck: true }),
    "pin"
  );
  assert.equal(
    classifyScrollIntent({ scrolledUp: false, distance: 40, interacting: false, stuck: true }),
    "pin"
  );
});

// `readerDriven` is what makes "settled AT the bottom" mean the READER settled there.
// It is stamped by the follower on wheel/keydown, since neither raises `interacting`.
test("NOT interacting + not stuck: only re-stick once the READER settles AT the bottom", () => {
  assert.equal(
    classifyScrollIntent({
      scrolledUp: false,
      distance: RESTICK_AT_BOTTOM_PX,
      interacting: false,
      stuck: false,
      readerDriven: true,
    }),
    "stick"
  );
  assert.equal(
    classifyScrollIntent({
      scrolledUp: false,
      distance: 200,
      interacting: false,
      stuck: false,
      readerDriven: true,
    }),
    "none"
  );
});

// A scroll that merely LANDS at the bottom is not evidence the reader put it
// there. The transcript has untagged programmatic writers — the TanStack
// virtualizer corrects `scrollTop` when a measured row differs from the estimate,
// and only the follower's OWN pins carry `selfScrollTop` — so "distance <= restick"
// alone re-armed bottom-follow behind a reader who had just escaped. Require a
// fresh reader gesture (wheel / keydown, stamped by the follower) as well.
test("NOT interacting + not stuck: an untagged scroll landing at the bottom must not re-arm the follow", () => {
  assert.equal(
    classifyScrollIntent({
      scrolledUp: false,
      distance: 0,
      interacting: false,
      stuck: false,
      readerDriven: false,
    }),
    "none"
  );
  // The reader wheeling back down to the bottom still re-sticks — wheel has no
  // pointer-down, so `interacting` is false and this is the only path that re-locks.
  assert.equal(
    classifyScrollIntent({
      scrolledUp: false,
      distance: 0,
      interacting: false,
      stuck: false,
      readerDriven: true,
    }),
    "stick"
  );
});

// Jitter or a small upward step can land inside the 4px band too; re-sticking
// there pinned the reader back before they could get any further.
test("landing near the bottom re-sticks only when the scroll moved down", () => {
  for (const interacting of [true, false]) {
    assert.equal(
      classifyScrollIntent({
        scrolledUp: false,
        scrolledDown: false,
        distance: 1,
        interacting,
        stuck: false,
        readerDriven: true,
      }),
      "none",
      `jitter must not re-stick (interacting=${interacting})`
    );
  }
  assert.equal(
    classifyScrollIntent({
      scrolledUp: true,
      scrolledDown: false,
      distance: 2,
      interacting: false,
      stuck: false,
      readerDriven: true,
    }),
    "none",
    "a reader's upward step that stays within the band is still an escape"
  );
  assert.equal(
    classifyScrollIntent({
      scrolledUp: false,
      scrolledDown: true,
      distance: 0,
      interacting: false,
      stuck: false,
      readerDriven: true,
    }),
    "stick"
  );
});

test("event name contract stays stable (follower listens by this literal)", () => {
  assert.equal(TRANSCRIPT_SCROLL_ACTION_EVENT, "transcript-scroll-action");
});

function makeDispatchingScrollElement({ scrollTop = 0, withTarget = false } = {}) {
  const events = [];
  const target = withTarget
    ? {
        scrolled: [],
        scrollIntoView(options) {
          target.scrolled.push(options);
        },
      }
    : null;
  const element = {
    clientHeight: 400,
    scrollHeight: 2000,
    scrollTop,
    querySelector: () => target,
    dispatchEvent(event) {
      events.push({ type: event.type, kind: event?.detail?.kind });
      return true;
    },
  };
  return { element, events, target };
}

test("applyTranscriptScrollAction dispatches intent AFTER applying jump-bottom", () => {
  const { element, events } = makeDispatchingScrollElement();
  applyTranscriptScrollAction({ kind: "jump-bottom", scrollTop: 1600 }, element);
  assert.equal(element.scrollTop, 1600);
  assert.deepEqual(events, [
    { type: "transcript-scroll-action", kind: "jump-bottom" },
  ]);
});

test("applyTranscriptScrollAction dispatches intent for restore-thread", () => {
  const { element, events } = makeDispatchingScrollElement();
  applyTranscriptScrollAction({ kind: "restore-thread", scrollTop: 700 }, element);
  assert.deepEqual(events, [
    { type: "transcript-scroll-action", kind: "restore-thread" },
  ]);
});

test("anchor-user is retired (bottom-follow): apply neither scrolls nor dispatches", () => {
  const { element, events, target } = makeDispatchingScrollElement({ withTarget: true });
  applyTranscriptScrollAction({ kind: "anchor-user", userEntryId: "u9" }, element);
  assert.equal(target.scrolled.length, 0);
  assert.deepEqual(events, []);
});

test("preserve and noop actions never dispatch", () => {
  const { element, events } = makeDispatchingScrollElement();
  applyTranscriptScrollAction({ kind: "preserve" }, element);
  applyTranscriptScrollAction({ kind: "noop" }, element);
  assert.deepEqual(events, []);
});

test("apply still works against scroll elements without dispatchEvent (pure fakes)", () => {
  const element = { clientHeight: 400, scrollHeight: 2000, scrollTop: 0 };
  applyTranscriptScrollAction({ kind: "jump-bottom", scrollTop: 1600 }, element);
  assert.equal(element.scrollTop, 1600);
});

test("input-required sticks: an arriving approval must land at the bottom and follow", () => {
  assert.equal(classifyTranscriptScrollAction({ kind: "input-required" }), "stick");
  // Distance is irrelevant — the intent is explicit, exactly like jump-bottom.
  for (const distance of [0, 40, 160, 4000]) {
    assert.equal(
      classifyTranscriptScrollAction({ distance, kind: "input-required" }),
      "stick",
      `${distance}px from bottom must still stick for an input request`
    );
  }
});

test("applyTranscriptScrollAction dispatches intent for input-required", () => {
  const { element, events } = makeDispatchingScrollElement();
  applyTranscriptScrollAction({ kind: "input-required", scrollTop: 1600 }, element);
  assert.equal(element.scrollTop, 1600);
  assert.deepEqual(events, [
    { type: "transcript-scroll-action", kind: "input-required" },
  ]);
});
