import React from "react";

import { SCROLL_TO_BOTTOM_THRESHOLD_PX } from "./scroll-to-bottom-core.js";
import { TRANSCRIPT_SCROLL_ACTION_EVENT } from "./transcript-scroll.js";

const h = React.createElement;

// Re-stick only once the reader is essentially AT the bottom. Deliberately tiny
// (not the button's 160px "near bottom" band): after an escape a single wheel
// tick still leaves us tens of px from the bottom, and re-sticking there would
// trap the reader against the stream (the classic "can't scroll up while it's
// streaming" bug). The reader gets back by scrolling to the bottom or with the
// explicit "scroll to latest" button.
export const RESTICK_AT_BOTTOM_PX = 4;

// Classify a non-programmatic scroll event into what the follower should do. Pure
// so the gesture policy is unit-testable (the wiring around it — self-pin echo
// suppression, wheel-up, interacting flag — lives in the component).
//
//   interacting = a finger/mouse button is DOWN on the scroller (touch drag or
//     scrollbar drag). Then the scroll IS the reader: any upward move escapes,
//     reaching the bottom re-sticks. This is what lets a SLOW drag escape — we do
//     not require a big single-event delta.
//   not interacting = the scroll is either our own pin echo (filtered before this)
//     or layout churn (snapshot re-render / virtualizer re-measure). While stuck
//     we re-glue to the bottom (churn must never un-stick us); otherwise we only
//     re-stick once the reader has settled back AT the bottom.
export function classifyScrollIntent({ scrolledUp, distance, interacting, stuck, restickPx = RESTICK_AT_BOTTOM_PX }) {
  if (interacting) {
    if (scrolledUp) return "unstick";
    if (distance <= restickPx) return "stick";
    return "none";
  }
  if (stuck) return "pin";
  if (distance <= restickPx) return "stick";
  return "none";
}

// Live "stick to bottom" follower for the transcript (element scroller).
//
// WHY THIS IS HAND-ROLLED (and NOT the `use-stick-to-bottom` library):
//   We migrated to `use-stick-to-bottom` to shed our old follow code, but on our
//   surfaces it proved fragile. The transcript's height churns constantly — the
//   LOCAL surface re-renders the whole transcript from full snapshots (no deltas)
//   and the TanStack virtualizer re-measures rows mid-stream. The library infers
//   "the reader escaped" from scroll-POSITION deltas, and its own overshoot
//   correction (a programmatic upward scrollTop nudge) intermittently reads as a
//   user scroll-up, so ~1/3 of sends stopped following mid-stream. Its recommended
//   setup (the <StickToBottom> component + spring animation) does not fit our
//   cross-surface DOM and, when tested, made the race WORSE; there is no config
//   knob for it and no upstream fix in 1.1.6.
//
//   So we own a tiny follower that is robust BY CONSTRUCTION: it distinguishes a
//   real reader scroll from layout churn by whether a POINTER IS DOWN (touch or
//   mouse), plus the synchronous wheel-up fast-path. While the reader is actively
//   dragging, any upward movement escapes (so even a slow 2px-per-move drag or a
//   gradual scrollbar drag works); otherwise an unattributed scroll is churn and
//   is simply re-glued to the bottom. Everything we write to scrollTop is tagged
//   so we never mistake our own pin for a reader scroll.
//
//   FALLBACK: if we ever want the library back, `patch-package` + a ~60px
//   tolerance on the library's scroll-up escape (its handleWheel still catches
//   real wheel-up) also fixes the race — verified, kept as an escape hatch.
//
// Contract (bottom-follow — there is NO top-anchor):
//   - stuck: re-pin scrollTop to the bottom whenever the content/viewport resizes.
//   - a real reader scroll-up (wheel up, or an upward touch/scrollbar drag) ->
//     un-stick (stop following); reaching the bottom again -> re-stick.
//   - intent events broadcast by transcript-scroll.js: jump-bottom / rejoin-bottom
//     -> stick now; restore-thread -> stick only if already near the bottom.
//   Keyboard scrolling is intentionally NOT a first-class escape (it would also
//   fire for caret movement inside AskUser inputs); a keyboard scroll-up is
//   treated as churn and re-glued, which is acceptable for this dev surface.
export function StickToBottomFollower() {
  const anchorRef = React.useRef(null);
  const resizeObserverRef = React.useRef(null);
  const observedContentRef = React.useRef(null);

  React.useLayoutEffect(() => {
    const scroller = anchorRef.current?.closest?.(".chat-thread");
    if (!scroller) {
      return undefined;
    }

    // stuck === currently following the bottom. Start unstuck: thread entry
    // broadcasts jump-bottom (and writes scrollTop) which sticks us, and a
    // switch-back restore-thread must be able to keep its mid-history offset.
    let stuck = false;
    // The scrollTop value WE just wrote — used to ignore the echoed scroll event
    // so our own pin is never mistaken for a reader scroll. -1 = "not ours".
    let selfScrollTop = -1;
    let lastScrollTop = scroller.scrollTop;
    // A finger/mouse button is down on the scroller (touch drag or scrollbar drag).
    let touchActive = false;
    let mouseActive = false;
    const interacting = () => touchActive || mouseActive;

    const distance = () =>
      Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
    const pin = () => {
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      selfScrollTop = target;
      lastScrollTop = target;
      if (scroller.scrollTop !== target) {
        scroller.scrollTop = target;
      }
    };
    const stick = () => {
      stuck = true;
      pin();
    };
    const unstick = () => {
      stuck = false;
    };

    // Follow growth: any content/viewport resize re-pins while stuck — UNLESS the
    // reader is mid-gesture, so we never fight an active drag. This is the only
    // thing that drives the follow and it is immune to the reader's scroll
    // position, so layout churn can never un-stick us here.
    const resizeObserver = new ResizeObserver(() => {
      if (stuck && !interacting()) {
        pin();
      }
    });
    resizeObserverRef.current = resizeObserver;
    resizeObserver.observe(scroller);
    const content = scroller.querySelector(".thread-content");
    if (content) {
      resizeObserver.observe(content);
      observedContentRef.current = content;
    }

    const onWheel = (event) => {
      // Wheel does not go through the pointer-down path, so escape here directly.
      if (!event.ctrlKey && (event.deltaY || 0) < 0) {
        unstick();
      }
    };
    const onScroll = () => {
      const sp = scroller.scrollTop;
      if (selfScrollTop >= 0 && Math.abs(sp - selfScrollTop) <= 1) {
        selfScrollTop = -1;
        lastScrollTop = sp;
        return;
      }
      selfScrollTop = -1;
      const scrolledUp = sp < lastScrollTop - 1;
      lastScrollTop = sp;
      const action = classifyScrollIntent({
        scrolledUp,
        distance: distance(),
        interacting: interacting(),
        stuck,
      });
      if (action === "unstick") unstick();
      else if (action === "stick") stick();
      else if (action === "pin") pin();
    };
    // touchstart AND touchmove keep the flag hot: Chromium can fire touchcancel
    // when a touch turns into a scroll, so refreshing on every move (which
    // interleaves just before each scroll event) keeps `interacting` true through
    // the whole drag regardless of a spurious cancel.
    const onTouchActive = () => { touchActive = true; };
    const onTouchEnd = () => {
      touchActive = false;
      endInteract();
    };
    const onMouseDown = () => { mouseActive = true; };
    const onMouseUp = () => {
      mouseActive = false;
      endInteract();
    };
    // When a drag ends: if the reader left us at the bottom, follow again; if we
    // are still nominally stuck (e.g. a finger rested without scrolling and the
    // stream drifted us up), re-glue.
    const endInteract = () => {
      if (interacting()) return;
      if (stuck) pin();
      else if (distance() <= RESTICK_AT_BOTTOM_PX) stick();
    };
    const onAction = (event) => {
      const kind = event?.detail?.kind;
      if (kind === "jump-bottom" || kind === "rejoin-bottom") {
        stick();
      } else if (kind === "restore-thread") {
        // Match the button's "near bottom" band for the restore decision.
        if (distance() <= SCROLL_TO_BOTTOM_THRESHOLD_PX) stick();
        else unstick();
      }
    };

    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("touchstart", onTouchActive, { passive: true });
    scroller.addEventListener("touchmove", onTouchActive, { passive: true });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    scroller.addEventListener("mousedown", onMouseDown, { passive: true });
    // Mouse-up can land outside the scroller (scrollbar drag released elsewhere).
    window.addEventListener("mouseup", onMouseUp, { passive: true });
    scroller.addEventListener(TRANSCRIPT_SCROLL_ACTION_EVENT, onAction);

    return () => {
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      observedContentRef.current = null;
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("touchstart", onTouchActive);
      scroller.removeEventListener("touchmove", onTouchActive);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      scroller.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      scroller.removeEventListener(TRANSCRIPT_SCROLL_ACTION_EVENT, onAction);
    };
  }, []);

  // TranscriptContent can remount its `.thread-content` root (empty <-> ready <->
  // virtualized swaps). Re-point the content ResizeObserver at the current node so
  // the follow never goes deaf. Runs every render; a no-op unless the node changed.
  React.useLayoutEffect(() => {
    const observer = resizeObserverRef.current;
    if (!observer) {
      return;
    }
    const scroller = anchorRef.current?.closest?.(".chat-thread");
    const content = scroller?.querySelector?.(".thread-content") || null;
    if (content !== observedContentRef.current) {
      if (observedContentRef.current) {
        observer.unobserve(observedContentRef.current);
      }
      if (content) {
        observer.observe(content);
      }
      observedContentRef.current = content;
    }
  });

  // Invisible marker: only exists so the effect can resolve the enclosing
  // `.chat-thread` scroller, same trick as ScrollToBottomButton.
  return h("span", {
    "aria-hidden": "true",
    className: "stick-to-bottom-anchor",
    hidden: true,
    ref: anchorRef,
  });
}
