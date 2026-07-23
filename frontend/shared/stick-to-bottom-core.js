// Pure state machine for live "stick to bottom" following.
//
// The transcript's top-anchor design (transcript-scroll.js) deliberately never
// follows streaming output. This module adds the missing half of the hybrid:
// while the reader is AT the bottom, content growth pulls the viewport down
// with it; scrolling up releases the follow; scrolling back down re-joins it.
//
// The pointer that makes this robust is NOT scrollTop (which layout churn —
// the 60vh send spacer, `content-visibility: auto` re-measures — invalidates
// every frame) but the pair (movement direction, distance from bottom):
//
//   - release:  the reader moved UP and is no longer at the bottom.
//   - re-join:  the reader moved DOWN into the rejoin threshold.
//   - neither:  keep the previous stickiness. Crucially this keeps following
//               through browser clamps (spacer collapse / shrink drops
//               scrollTop with distance 0 — that is not the reader escaping),
//               and it keeps the release through the no-movement scroll event
//               fired by the programmatic send-anchor (clamped at max, the
//               spacer couldn't push the message all the way up).
//
// Programmatic transitions with real intent (thread entry, send-anchor) don't
// guess from geometry at all: transcript-scroll.js broadcasts the applied
// action and stickStateForAction maps it directly.
//
// Kept free of React and DOM so it can be unit-tested directly (see
// stick-to-bottom.test.mjs). The component that wires it to scroll events and
// a ResizeObserver lives in stick-to-bottom.js — mirroring the
// scroll-to-bottom-core.js / scroll-to-bottom.js split.

import {
  SCROLL_TO_BOTTOM_THRESHOLD_PX,
  maxScrollTop,
  nextSettleScrollTop,
} from "./scroll-to-bottom-core.js";

// Scrolling back to within this distance of the bottom re-joins the live
// follow. Same value as the scroll-to-bottom button threshold so "the button
// disappears" and "following resumes" agree with each other.
export const STICK_REJOIN_THRESHOLD_PX = SCROLL_TO_BOTTOM_THRESHOLD_PX;

// Sub-pixel slack so rounding jitter neither releases nor re-joins.
const MOVEMENT_SLACK_PX = 1;

export function distanceFromBottom(metrics) {
  if (!metrics) return 0;
  return Math.max(0, maxScrollTop(metrics) - (metrics.scrollTop || 0));
}

export function createStickState(metrics) {
  return {
    sticky: distanceFromBottom(metrics) <= STICK_REJOIN_THRESHOLD_PX,
    lastScrollTop: metrics?.scrollTop || 0,
    // While true, downward movement alone cannot re-join the follow — only a
    // genuine user input gesture (see stickStateAfterUserGesture) releases it.
    // Armed by anchor-user: the virtualizer's multi-frame measurement
    // corrections after scrollToIndex are programmatic downward scrolls that
    // geometry alone cannot tell apart from a user returning to the bottom.
    holdRejoin: false,
  };
}

// Fold a scroll event into the state. Works for user scrolls, our own settle
// writes, and browser clamps alike — the direction/distance rules sort them
// out without needing to flag programmatic scrolls.
export function stickStateAfterScroll(state, metrics) {
  if (!metrics) {
    return state;
  }
  const scrollTop = metrics.scrollTop || 0;
  const lastScrollTop = state?.lastScrollTop || 0;
  const distance = distanceFromBottom(metrics);
  const movedUp = scrollTop < lastScrollTop - MOVEMENT_SLACK_PX;
  const movedDown = scrollTop > lastScrollTop + MOVEMENT_SLACK_PX;

  let sticky = Boolean(state?.sticky);
  if (movedUp && distance > MOVEMENT_SLACK_PX) {
    // Deliberate escape upward. (A clamp also lowers scrollTop, but it lands
    // exactly at the bottom — distance 0 — so it doesn't release.)
    sticky = false;
  } else if (
    movedDown
    && !state?.holdRejoin
    && distance <= STICK_REJOIN_THRESHOLD_PX
  ) {
    // Deliberate return to the bottom. Requiring downward MOVEMENT (not just
    // position) keeps the send-anchor's clamped-at-max scroll event from
    // re-sticking the reader onto the stream they were just anchored above —
    // and the rejoin hold keeps third-party programmatic scrolls (virtualizer
    // measurement corrections) from doing the same.
    sticky = true;
  }
  return {
    sticky,
    lastScrollTop: scrollTop,
    holdRejoin: Boolean(state?.holdRejoin),
  };
}

// Fold an applied transcript-scroll action (see TRANSCRIPT_SCROLL_ACTION_EVENT
// in transcript-scroll.js) into the state. This is intent, not geometry.
export function stickStateForAction(state, kind, metrics) {
  if (kind === "anchor-user") {
    // The reader was just pinned to their sent message; streaming below must
    // not drag them away until they deliberately come back. The hold makes
    // "deliberately" mean an actual input gesture, not just downward motion.
    return {
      sticky: false,
      lastScrollTop: metrics?.scrollTop || 0,
      holdRejoin: true,
    };
  }
  if (kind === "jump-bottom" || kind === "restore-thread") {
    // Thread entry / switch-back: stickiness follows wherever we landed.
    return createStickState(metrics);
  }
  if (kind === "rejoin-bottom") {
    // Explicit "take me to the latest" intent (the scroll-to-latest button —
    // mouse, keyboard and assistive tech all funnel through its click). The
    // reader asked for the bottom, so follow immediately and drop the hold;
    // the button's own settle loop carries the viewport down.
    return {
      sticky: true,
      lastScrollTop: metrics?.scrollTop || 0,
      holdRejoin: false,
    };
  }
  return state;
}

const INTERACTIVE_TARGET_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role='button']",
  "[role='textbox']",
].join(", ");

// Keys pressed inside interactive transcript controls (the AskUser textarea,
// approval buttons, links…) are editing/activation, not scrolling — treating
// them as downward-scroll intent would falsely release the rejoin hold and
// re-expose the virtualizer-correction race the hold exists to stop.
// Duck-typed (tagName/closest) so it is unit-testable without a DOM.
export function isInteractiveEventTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || "").toLowerCase();
  if (
    tag === "input"
    || tag === "textarea"
    || tag === "select"
    || tag === "button"
    || tag === "option"
  ) {
    return true;
  }
  if (typeof target.closest === "function") {
    return Boolean(target.closest(INTERACTIVE_TARGET_SELECTOR));
  }
  return false;
}

const EDITABLE_TARGET_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role='textbox']",
].join(", ");

// Narrower than isInteractiveEventTarget: targets where arrow / Page / Home /
// End move a caret or selection (so scroll KEYS there are text editing, not
// scroll intent). A button or link is interactive — Space activates it — but is
// NOT editable, so PageUp / Home / ArrowUp from a focused button is still a
// scroll-up intent. Used only for the UPWARD keys, which never clear the rejoin
// hold, so honoring them on buttons cannot re-expose the virtualizer race that
// the (still stricter) downward guard protects. Duck-typed for unit testing.
export function isEditableEventTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return true;
  }
  if (typeof target.closest === "function") {
    return Boolean(target.closest(EDITABLE_TARGET_SELECTOR));
  }
  return false;
}

const UPWARD_SCROLL_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const DOWNWARD_SCROLL_KEYS = new Set(["ArrowDown", "PageDown", "End"]);

// Map a keydown to its follow effect: "upward" | "downward" | null. Pure +
// exported so the reviewer's P2 — PageUp/Home/ArrowUp from a focused button is
// scroll intent, but the same key inside a textarea is caret movement — is
// unit-tested without a browser. Asymmetric on purpose: upward keys filter only
// EDITABLE targets (a button doesn't swallow them and they never clear the
// rejoin hold), while downward keys keep the stricter interactive filter (Space
// activates a button; ArrowDown/End near a fresh send must not clear the hold).
export function keydownScrollIntent(event, target) {
  const key = event?.key;
  const shiftKey = Boolean(event?.shiftKey);
  // Shift+Space is the standard page-UP input; plain Space is page-DOWN. Neither
  // activates a control the way plain Space clicks a focused button, so upward
  // filters only editable targets.
  if ((UPWARD_SCROLL_KEYS.has(key) || (key === " " && shiftKey)) && !isEditableEventTarget(target)) {
    return "upward";
  }
  if (isInteractiveEventTarget(target)) {
    return null;
  }
  if (DOWNWARD_SCROLL_KEYS.has(key) || (key === " " && !shiftKey)) {
    return "downward";
  }
  return null;
}

// A genuine user input gesture (wheel / touch / pointer / key) releases the
// send-anchor's rejoin hold: from here on, scrolling down to the bottom means
// the reader chose to follow again.
export function stickStateAfterUserGesture(state) {
  if (!state?.holdRejoin) {
    return state;
  }
  return { ...state, holdRejoin: false };
}

// An UPWARD input gesture (wheel up / finger down / ArrowUp…) is authoritative
// intent to leave the live follow — release it *synchronously*, without waiting
// for the delayed scroll event's geometry. That wait is the "can't scroll up
// while streaming" bug: a streaming ResizeObserver tick calls follow() before
// the scroll event is delivered, snaps scrollTop back to the grown bottom and
// records lastScrollTop there, so the geometry path then reads "no movement"
// and never sees the escape. Flipping sticky on the input itself makes the
// interleaved follow() a no-op, so it can't snap the reader back.
//
// The rejoin hold is deliberately preserved: going up is not the DOWNWARD
// intent that clears the send-anchor hold (that is stickStateAfterUserGesture).
export function stickStateAfterUpwardGesture(state) {
  if (!state?.sticky) {
    return state;
  }
  return { ...state, sticky: false };
}

// Where to scroll to keep following, or null to stay put. Only ever moves
// DOWNWARD — a momentarily-shrunken scrollHeight (content-visibility estimate
// flip-flop, spacer collapse) must never yank the viewport back up; the
// browser's own clamping handles shrink.
export function stickFollowTarget(state, metrics) {
  if (!state?.sticky) return null;
  return nextSettleScrollTop(metrics);
}
