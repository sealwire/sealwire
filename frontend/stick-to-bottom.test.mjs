import test from "node:test";
import assert from "node:assert/strict";

import {
  STICK_REJOIN_THRESHOLD_PX,
  createStickState,
  distanceFromBottom,
  isInteractiveEventTarget,
  stickFollowTarget,
  stickStateAfterScroll,
  stickStateAfterUserGesture,
  stickStateForAction,
} from "./shared/stick-to-bottom-core.js";
import {
  TRANSCRIPT_SCROLL_ACTION_EVENT,
  applyTranscriptScrollAction,
} from "./shared/transcript-scroll.js";

// Geometry used throughout: 400px viewport over 2000px of content, so the
// bottom sits at scrollTop 1600.
function metrics({ scrollTop = 1600, clientHeight = 400, scrollHeight = 2000 } = {}) {
  return { scrollTop, clientHeight, scrollHeight };
}

// --- distanceFromBottom ------------------------------------------------------

test("distanceFromBottom: 0 at the bottom, gap when above, floored on overscroll", () => {
  assert.equal(distanceFromBottom(metrics({ scrollTop: 1600 })), 0);
  assert.equal(distanceFromBottom(metrics({ scrollTop: 1000 })), 600);
  // iOS rubber-band can report scrollTop past the max; never negative.
  assert.equal(distanceFromBottom(metrics({ scrollTop: 1700 })), 0);
  assert.equal(distanceFromBottom(null), 0);
});

// --- createStickState --------------------------------------------------------

test("createStickState: sticky at (or near) the bottom, not when far above", () => {
  assert.equal(createStickState(metrics({ scrollTop: 1600 })).sticky, true);
  assert.equal(
    createStickState(metrics({ scrollTop: 1600 - STICK_REJOIN_THRESHOLD_PX })).sticky,
    true
  );
  assert.equal(createStickState(metrics({ scrollTop: 0 })).sticky, false);
});

test("createStickState: non-overflowing content counts as at-bottom (fresh thread)", () => {
  const state = createStickState(metrics({ scrollTop: 0, scrollHeight: 300 }));
  assert.equal(state.sticky, true);
});

// --- following (the actual live-follow invariant) ---------------------------

test("sticky + content growth -> follow target is the new bottom", () => {
  const state = createStickState(metrics({ scrollTop: 1600 }));
  // A streaming chunk grew the transcript by 400px; reader hasn't moved.
  const grown = metrics({ scrollTop: 1600, scrollHeight: 2400 });
  assert.equal(stickFollowTarget(state, grown), 2000);
});

test("not sticky -> growth never moves the reader (top-anchored reading stays put)", () => {
  const state = { sticky: false, lastScrollTop: 200 };
  const grown = metrics({ scrollTop: 200, scrollHeight: 2400 });
  assert.equal(stickFollowTarget(state, grown), null);
});

test("follow only ever moves DOWNWARD: shrink (content-visibility flip) is a no-op", () => {
  // scrollHeight momentarily shrank below us; scrolling up to the new max
  // would be the "violent shaking" bug. Must not move.
  const state = { sticky: true, lastScrollTop: 1600 };
  const shrunk = metrics({ scrollTop: 1600, scrollHeight: 1300 });
  assert.equal(stickFollowTarget(state, shrunk), null);
});

test("follow target: null when already at the bottom or metrics missing", () => {
  const state = { sticky: true, lastScrollTop: 1600 };
  assert.equal(stickFollowTarget(state, metrics({ scrollTop: 1600 })), null);
  assert.equal(stickFollowTarget(state, null), null);
  assert.equal(stickFollowTarget(null, metrics()), null);
});

// --- scroll-driven stickiness updates ---------------------------------------

test("escape: ANY upward user scroll releases stickiness, even inside the rejoin threshold", () => {
  // One wheel notch up (~100px) must immediately release the follow — a
  // threshold-only implementation would keep sticky=true here and snap the
  // reader back down on the next streamed token ("fights the user").
  const state = { sticky: true, lastScrollTop: 1600 };
  const next = stickStateAfterScroll(state, metrics({ scrollTop: 1500 }));
  assert.equal(next.sticky, false);
  assert.equal(next.lastScrollTop, 1500);
});

test("browser clamp keeps stickiness: scrollTop dropped but we are still AT the bottom", () => {
  // Turn-end spacer collapse (or a content-visibility re-measure) shrinks
  // scrollHeight; the browser clamps scrollTop down to the new max. That is
  // not the reader scrolling up — live following must survive it.
  const state = { sticky: true, lastScrollTop: 1600 };
  const clamped = stickStateAfterScroll(state, {
    scrollTop: 1120,
    clientHeight: 400,
    scrollHeight: 1520, // new max is exactly 1120 -> distance 0
  });
  assert.equal(clamped.sticky, true);
});

test("no positional re-stick: sitting at the bottom without moving does NOT re-stick", () => {
  // The hybrid send-anchor can end up clamped at maxScrollTop (short message +
  // tall viewport: the 60vh spacer cannot push it all the way up). The scroll
  // event that follows reports "at bottom, unmoved" — re-sticking here would
  // yank the reader off their freshly anchored message on the next token.
  const state = { sticky: false, lastScrollTop: 1600 };
  const next = stickStateAfterScroll(state, metrics({ scrollTop: 1600 }));
  assert.equal(next.sticky, false);
});

test("rejoin: deliberately scrolling DOWN into the threshold re-sticks", () => {
  const state = { sticky: false, lastScrollTop: 1000 };
  const next = stickStateAfterScroll(
    state,
    metrics({ scrollTop: 1600 - (STICK_REJOIN_THRESHOLD_PX - 10) })
  );
  assert.equal(next.sticky, true);
});

test("scrolling down while still far from the bottom stays released", () => {
  const state = { sticky: false, lastScrollTop: 200 };
  const next = stickStateAfterScroll(state, metrics({ scrollTop: 800 }));
  assert.equal(next.sticky, false);
});

test("our own settle write (downward to the new bottom) keeps following", () => {
  const state = { sticky: true, lastScrollTop: 1600 };
  const next = stickStateAfterScroll(
    state,
    metrics({ scrollTop: 2000, scrollHeight: 2400 })
  );
  assert.equal(next.sticky, true);
  assert.equal(next.lastScrollTop, 2000);
});

test("stickStateAfterScroll: missing metrics leaves state untouched", () => {
  const state = { sticky: true, lastScrollTop: 1600 };
  assert.deepEqual(stickStateAfterScroll(state, null), state);
});

// --- action-driven intent (the transcript-scroll layer tells us what it did) --

test("anchor-user action releases stickiness even when clamped at the very bottom", () => {
  // The heart of the hybrid mode: after "pin the user's message to the top",
  // streaming below must NOT drag the viewport away — regardless of where the
  // clamp left scrollTop.
  const state = createStickState(metrics({ scrollTop: 1600 }));
  assert.equal(state.sticky, true);
  const anchored = stickStateForAction(state, "anchor-user", metrics({ scrollTop: 1600 }));
  assert.equal(anchored.sticky, false);
  // ...and the async scroll event from that same programmatic anchor (same
  // position, no movement) must not undo the release.
  const afterEvent = stickStateAfterScroll(anchored, metrics({ scrollTop: 1600 }));
  assert.equal(afterEvent.sticky, false);
});

test("jump-bottom action (thread entry) derives sticky from the landing position", () => {
  const state = { sticky: false, lastScrollTop: 40 };
  const landed = stickStateForAction(state, "jump-bottom", metrics({ scrollTop: 1600 }));
  assert.equal(landed.sticky, true);
});

test("restore-thread action derives stickiness from the restored offset", () => {
  const midway = stickStateForAction(null, "restore-thread", metrics({ scrollTop: 700 }));
  assert.equal(midway.sticky, false);
  const nearBottom = stickStateForAction(null, "restore-thread", metrics({ scrollTop: 1590 }));
  assert.equal(nearBottom.sticky, true);
});

test("unrelated action kinds leave the state untouched", () => {
  const state = { sticky: true, lastScrollTop: 1600 };
  assert.equal(stickStateForAction(state, "preserve", metrics()), state);
  assert.equal(stickStateForAction(state, "anchor-prepend", metrics()), state);
  assert.equal(stickStateForAction(state, "noop", metrics()), state);
});

// --- rejoin hold: anchor-user vs third-party programmatic scrolls ------------

test("anchor-user arms a rejoin hold: programmatic downward drift must NOT re-stick", () => {
  // After the send-anchor, TanStack's virtualizer issues multi-frame
  // measurement corrections that can move scrollTop DOWN while the stream
  // grows. Movement+distance alone cannot tell that apart from a user
  // scrolling back — so anchor-user must arm a hold that only a real user
  // gesture releases.
  let state = createStickState(metrics({ scrollTop: 1600 }));
  state = stickStateForAction(state, "anchor-user", metrics({ scrollTop: 1600 }));
  // Correction: +40px down, distance 60 (inside the rejoin threshold).
  state = stickStateAfterScroll(state, metrics({ scrollTop: 1640, scrollHeight: 2100 }));
  assert.equal(state.sticky, false);
  // And the follow must stay off through further growth.
  assert.equal(
    stickFollowTarget(state, metrics({ scrollTop: 1640, scrollHeight: 2400 })),
    null
  );
});

test("a user gesture disarms the hold; the next downward scroll re-joins", () => {
  let state = stickStateForAction(
    createStickState(metrics({ scrollTop: 1600 })),
    "anchor-user",
    metrics({ scrollTop: 1600 })
  );
  state = stickStateAfterUserGesture(state);
  // The reader wheels down to the (grown) bottom: rejoin.
  state = stickStateAfterScroll(state, metrics({ scrollTop: 1900, scrollHeight: 2400 }));
  assert.equal(state.sticky, true);
});

test("the hold survives arbitrary scrolls: escape up then a downward correction stays released", () => {
  // Reviewer scenario: upward movement (wheel up / drag up) must not be what
  // releases the hold — otherwise a later virtualizer correction downward and
  // into the threshold would re-stick. Only stickStateAfterUserGesture (a
  // deliberate downward-intent gesture) releases it.
  let state = stickStateForAction(
    createStickState(metrics({ scrollTop: 1600 })),
    "anchor-user",
    metrics({ scrollTop: 1600 })
  );
  state = stickStateAfterScroll(state, metrics({ scrollTop: 1500 })); // moved up
  state = stickStateAfterScroll(state, metrics({ scrollTop: 1540 })); // correction down, distance 60
  assert.equal(state.sticky, false);
});

test("rejoin-bottom action (scroll-to-latest button, incl. AT activation) re-joins and clears the hold", () => {
  // The button's click handler broadcasts explicit intent: works for mouse,
  // keyboard and assistive tech alike, regardless of gesture heuristics.
  let state = stickStateForAction(null, "anchor-user", metrics({ scrollTop: 1600 }));
  state = stickStateForAction(state, "rejoin-bottom", metrics({ scrollTop: 1600 }));
  assert.equal(state.sticky, true);
  assert.equal(state.holdRejoin, false);
});

test("jump-bottom and restore-thread clear any armed hold", () => {
  let state = stickStateForAction(null, "anchor-user", metrics({ scrollTop: 1600 }));
  state = stickStateForAction(state, "jump-bottom", metrics({ scrollTop: 1600 }));
  assert.equal(state.sticky, true);
  // Escape and rejoin afterwards need no gesture — the hold is send-scoped.
  state = stickStateAfterScroll(state, metrics({ scrollTop: 1000 }));
  assert.equal(state.sticky, false);
  state = stickStateAfterScroll(state, metrics({ scrollTop: 1500 }));
  assert.equal(state.sticky, true);
});

// --- the transcript-scroll layer broadcasts its intent ------------------------

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

test("applyTranscriptScrollAction dispatches intent after anchoring the user message", () => {
  const { element, events, target } = makeDispatchingScrollElement({ withTarget: true });
  applyTranscriptScrollAction({ kind: "anchor-user", userEntryId: "u9" }, element);
  assert.equal(target.scrolled.length, 1);
  assert.deepEqual(events, [
    { type: "transcript-scroll-action", kind: "anchor-user" },
  ]);
});

test("anchor-user with no rendered target does not dispatch (virtualized path owns it)", () => {
  const { element, events } = makeDispatchingScrollElement({ withTarget: false });
  applyTranscriptScrollAction({ kind: "anchor-user", userEntryId: "u9" }, element);
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

// --- interactive-target filtering for the keyboard gesture -------------------

test("keys inside transcript controls are editing, not scrolling: textarea/button/editable are interactive", () => {
  // Space/End/ArrowDown bubbling out of the AskUser textarea (or any button)
  // edit text or activate the control — treating them as downward-scroll
  // intent would release the rejoin hold and re-expose the virtualizer race.
  assert.equal(
    isInteractiveEventTarget({ tagName: "TEXTAREA", closest: () => null }),
    true
  );
  assert.equal(
    isInteractiveEventTarget({ tagName: "INPUT", closest: () => null }),
    true
  );
  assert.equal(
    // A span inside a button: detected via closest().
    isInteractiveEventTarget({ tagName: "SPAN", closest: (sel) => (sel.includes("button") ? {} : null) }),
    true
  );
  assert.equal(
    isInteractiveEventTarget({ tagName: "DIV", isContentEditable: true, closest: () => null }),
    true
  );
});

test("plain transcript content is not interactive: keys there still count as scroll intent", () => {
  assert.equal(
    isInteractiveEventTarget({ tagName: "DIV", closest: () => null }),
    false
  );
  assert.equal(isInteractiveEventTarget(null), false);
});
