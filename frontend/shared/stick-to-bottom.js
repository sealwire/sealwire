import React from "react";

import {
  findScrollContainer,
  readScrollMetrics,
} from "./scroll-to-bottom-core.js";
import {
  createStickState,
  isInteractiveEventTarget,
  stickFollowTarget,
  stickStateAfterScroll,
  stickStateAfterUserGesture,
  stickStateForAction,
} from "./stick-to-bottom-core.js";
import { TRANSCRIPT_SCROLL_ACTION_EVENT } from "./transcript-scroll.js";

const h = React.createElement;

// Live "stick to bottom" follower. Rendered inside the shared TranscriptState
// (see conversation.js) next to the ScrollToBottomButton, so every surface —
// local + remote, desktop + phone — gets it for free.
//
// Why a ResizeObserver and not "scroll after each entries render": streamed
// tokens, expanding tool cards and content-visibility re-measures change the
// content height without a React render or a scroll event. The observer fires
// in the same frame as the layout change, so the follow write never races the
// layout it is reacting to — that race (read scrollHeight, then write a
// scrollTop that is already stale) is what made every scrollTop/scrollIntoView
// based "fix" here regress.
//
// All policy lives in stick-to-bottom-core.js (pure, unit-tested). This file
// is only wiring: scroll events + action broadcasts update the state, resizes
// apply the follow.
export function StickToBottomFollower() {
  const anchorRef = React.useRef(null);

  // useLayoutEffect, not useEffect: the local surface renders via flushSync
  // and applies + broadcasts the scroll action synchronously right after the
  // commit (remote does the same from its own layout effect). A passive
  // effect would attach the action listener only after paint — missing the
  // anchor-user broadcast fired on this component's own mount render (first
  // send into an empty thread), leaving the follower sticky on top of a
  // freshly anchored message. Child layout effects run before parent ones,
  // so this listener is attached before either surface dispatches.
  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const chatThread = anchor?.closest?.(".chat-thread") || null;
    const view = anchor?.ownerDocument?.defaultView
      || (typeof window !== "undefined" ? window : null);

    // The active scroller (`.chat-thread` on desktop, the window on phone) is
    // resolved fresh on every read so the follower adapts as the transcript
    // grows past the viewport.
    const readMetrics = () => readScrollMetrics(findScrollContainer(anchor));

    let state = createStickState(readMetrics());

    // While a pointer is held on the scroller (scrollbar drag) the scroll
    // events it produces are user-driven; a downward one is a real "toward
    // the bottom" gesture. A bare click (down+up, no scroll between) is not.
    let pointerHeld = false;
    // Touch: the finger's travel direction tells us intent before any
    // momentum scrolling starts (momentum events arrive after touchend).
    let touchStartY = null;

    // User scrolls, our own follow writes and browser clamps all funnel
    // through here; the core's direction/distance rules tell them apart.
    const onScroll = () => {
      const metrics = readMetrics();
      if (
        pointerHeld
        && metrics
        && (metrics.scrollTop || 0) > (state?.lastScrollTop || 0) + 1
      ) {
        state = stickStateAfterUserGesture(state);
      }
      state = stickStateAfterScroll(state, metrics);
    };

    // Programmatic transitions with intent (thread entry, send-anchor) are
    // broadcast by transcript-scroll.js after they are applied.
    const onAction = (event) => {
      state = stickStateForAction(state, event?.detail?.kind, readMetrics());
    };

    const follow = () => {
      const scrollEl = findScrollContainer(anchor);
      const target = stickFollowTarget(state, readScrollMetrics(scrollEl));
      if (target == null) {
        return;
      }
      if (typeof scrollEl?.scrollTo === "function") {
        scrollEl.scrollTo({ top: target, behavior: "auto" });
      } else if (scrollEl && "scrollTop" in scrollEl) {
        scrollEl.scrollTop = target;
      }
      // Record our own write so its async scroll event reads as "no movement"
      // rather than a user action.
      state = { ...state, lastScrollTop: target };
    };

    // Only gestures that express DOWNWARD intent release the send-anchor's
    // rejoin hold — an upward wheel, an unrelated click or a random keypress
    // must not, or the virtualizer's programmatic corrections regain the power
    // to re-stick the reader right after (the race the hold exists to stop).
    // The scroll-to-latest button is NOT covered here: its click handler
    // broadcasts an explicit "rejoin-bottom" action instead, which also covers
    // keyboard and assistive-tech activation.
    const onWheel = (event) => {
      if ((event?.deltaY || 0) > 0) {
        state = stickStateAfterUserGesture(state);
      }
    };
    const onTouchStart = (event) => {
      touchStartY = event?.touches?.[0]?.clientY ?? null;
    };
    const onTouchMove = (event) => {
      const y = event?.touches?.[0]?.clientY;
      if (
        touchStartY != null
        && typeof y === "number"
        && y < touchStartY - 8 // finger travels up => content scrolls down
      ) {
        state = stickStateAfterUserGesture(state);
      }
    };
    const onTouchEnd = () => {
      touchStartY = null;
    };
    const DOWNWARD_KEYS = new Set(["ArrowDown", "PageDown", "End"]);
    const onKeyDown = (event) => {
      // Keys bubbling out of interactive controls (AskUser textarea, approval
      // buttons…) edit or activate — they are not scroll intent.
      if (isInteractiveEventTarget(event?.target)) {
        return;
      }
      if (
        DOWNWARD_KEYS.has(event?.key)
        || (event?.key === " " && !event.shiftKey)
      ) {
        state = stickStateAfterUserGesture(state);
      }
    };
    const onPointerDown = () => {
      pointerHeld = true;
    };
    const onPointerUp = () => {
      pointerHeld = false;
    };
    const ownerDocument = anchor?.ownerDocument || null;

    // Listen on both candidates: desktop scrolls `.chat-thread`, phone scrolls
    // the window. Whichever fires, the state update reads the active one.
    chatThread?.addEventListener?.("scroll", onScroll, { passive: true });
    chatThread?.addEventListener?.(TRANSCRIPT_SCROLL_ACTION_EVENT, onAction);
    chatThread?.addEventListener?.("wheel", onWheel, { passive: true });
    chatThread?.addEventListener?.("touchstart", onTouchStart, { passive: true });
    chatThread?.addEventListener?.("touchmove", onTouchMove, { passive: true });
    chatThread?.addEventListener?.("touchend", onTouchEnd, { passive: true });
    chatThread?.addEventListener?.("touchcancel", onTouchEnd, { passive: true });
    chatThread?.addEventListener?.("keydown", onKeyDown);
    chatThread?.addEventListener?.("pointerdown", onPointerDown, { passive: true });
    // The pointer can be released outside the scroller mid-drag; listen on the
    // document so the held flag never sticks.
    ownerDocument?.addEventListener?.("pointerup", onPointerUp, { passive: true });
    ownerDocument?.addEventListener?.("pointercancel", onPointerUp, { passive: true });
    view?.addEventListener?.("scroll", onScroll, { passive: true });
    // A viewport resize moves the bottom out from under a pinned reader.
    view?.addEventListener?.("resize", follow);

    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined" && chatThread) {
      resizeObserver = new ResizeObserver(() => follow());
      resizeObserver.observe(chatThread);
      const content = chatThread.querySelector?.(".thread-content");
      if (content) {
        resizeObserver.observe(content);
      }
    }

    return () => {
      chatThread?.removeEventListener?.("scroll", onScroll);
      chatThread?.removeEventListener?.(TRANSCRIPT_SCROLL_ACTION_EVENT, onAction);
      chatThread?.removeEventListener?.("wheel", onWheel);
      chatThread?.removeEventListener?.("touchstart", onTouchStart);
      chatThread?.removeEventListener?.("touchmove", onTouchMove);
      chatThread?.removeEventListener?.("touchend", onTouchEnd);
      chatThread?.removeEventListener?.("touchcancel", onTouchEnd);
      chatThread?.removeEventListener?.("keydown", onKeyDown);
      chatThread?.removeEventListener?.("pointerdown", onPointerDown);
      ownerDocument?.removeEventListener?.("pointerup", onPointerUp);
      ownerDocument?.removeEventListener?.("pointercancel", onPointerUp);
      view?.removeEventListener?.("scroll", onScroll);
      view?.removeEventListener?.("resize", follow);
      resizeObserver?.disconnect();
    };
  }, []);

  // Invisible marker: only exists so the effect can resolve the enclosing
  // `.chat-thread` / window scroller, same trick as ScrollToBottomButton.
  return h("span", {
    "aria-hidden": "true",
    className: "stick-to-bottom-anchor",
    hidden: true,
    ref: anchorRef,
  });
}
