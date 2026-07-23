import React from "react";

import {
  findScrollContainer,
  isWindowLike,
  readScrollMetrics,
} from "./scroll-to-bottom-core.js";
import {
  createStickState,
  keydownScrollIntent,
  stickFollowTarget,
  stickStateAfterScroll,
  stickStateAfterUpwardGesture,
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

    // Two intents, two effects. DOWNWARD input (wheel down, finger up, PageDown…)
    // releases the send-anchor's rejoin hold — from there, scrolling back to the
    // bottom re-joins the follow. UPWARD input (wheel up, finger down, PageUp…)
    // leaves the live follow *immediately*: without it, release waits for the
    // delayed scroll event's geometry, which a streaming follow() write can
    // erase first (the "can't scroll up while streaming" bug — see
    // stickStateAfterUpwardGesture). An upward gesture must NOT release the hold
    // (only downward intent does) or the virtualizer's programmatic corrections
    // regain the power to re-stick the reader right after. The scroll-to-latest
    // button is NOT covered here: its click handler broadcasts an explicit
    // "rejoin-bottom" action, which also covers keyboard and assistive tech.
    const onWheel = (event) => {
      // Ctrl+wheel and trackpad pinch are zoom, not scroll — never a follow exit.
      if (event?.ctrlKey) {
        return;
      }
      const deltaY = event?.deltaY || 0;
      if (deltaY > 0) {
        state = stickStateAfterUserGesture(state);
      } else if (deltaY < 0) {
        state = stickStateAfterUpwardGesture(state);
      }
    };
    const onTouchStart = (event) => {
      // Multi-touch is a pinch-zoom, not a scroll — don't track it as intent.
      if ((event?.touches?.length || 0) !== 1) {
        touchStartY = null;
        return;
      }
      touchStartY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event) => {
      if ((event?.touches?.length || 0) !== 1) {
        return; // pinch-zoom in progress
      }
      const y = event?.touches?.[0]?.clientY;
      if (touchStartY == null || typeof y !== "number") {
        return;
      }
      if (y < touchStartY - 8) {
        // Finger travels UP => content scrolls DOWN: downward intent.
        state = stickStateAfterUserGesture(state);
      } else if (y > touchStartY + 8) {
        // Finger travels DOWN => content scrolls UP: leave the follow.
        state = stickStateAfterUpwardGesture(state);
      }
    };
    const onTouchEnd = () => {
      touchStartY = null;
    };
    // Intent mapping (incl. the button-vs-textarea filtering) is the pure,
    // unit-tested keydownScrollIntent; this only applies the resulting effect.
    const onKeyDown = (event) => {
      const intent = keydownScrollIntent(event, event?.target);
      if (intent === "upward") {
        state = stickStateAfterUpwardGesture(state);
      } else if (intent === "downward") {
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

    // Does this window-level gesture actually scroll the TRANSCRIPT? Only if
    // (a) the transcript's active scroller is the window — on the desktop/remote
    // layout it is `.chat-thread`, so a sidebar/right-rail wheel that bubbles to
    // the window must NOT touch the transcript's follow — and (b) the gesture
    // isn't consumed by an independent inner scroll region (sidebar, drawer,
    // code block with its own overflow), which scrolls itself, not the page.
    const targetInsideInnerScroller = (target) => {
      const body = ownerDocument?.body || null;
      const root = ownerDocument?.scrollingElement
        || ownerDocument?.documentElement
        || null;
      let el = target && target.nodeType === 1 ? target : null;
      while (el && el !== body && el !== root) {
        const overflowY = view?.getComputedStyle?.(el)?.overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll")
          && (el.scrollHeight || 0) > (el.clientHeight || 0) + 1
        ) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    };
    const windowGestureIsTranscript = (event) =>
      isWindowLike(findScrollContainer(anchor))
      && !targetInsideInnerScroller(event?.target);

    // Window-level wrappers: the narrow layout scrolls the WINDOW with the
    // header/composer as SIBLINGS of `.chat-thread`, so a gesture there scrolls
    // the page but never bubbles through `.chat-thread` — the element listeners
    // miss it and only the racy geometry path releases the follow. Re-run the
    // same handlers from the window, but gated so they fire only for genuine
    // transcript scrolls (handlers are idempotent, so the double-fire from a
    // gesture inside `.chat-thread` is harmless).
    const onWindowWheel = (event) => {
      if (windowGestureIsTranscript(event)) onWheel(event);
    };
    const onWindowTouchStart = (event) => {
      if (windowGestureIsTranscript(event)) onTouchStart(event);
    };
    const onWindowTouchMove = (event) => {
      if (windowGestureIsTranscript(event)) onTouchMove(event);
    };
    const onWindowKeyDown = (event) => {
      if (windowGestureIsTranscript(event)) onKeyDown(event);
    };

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
    // Window-level gesture listeners for the window-scroller (narrow) layout,
    // gated by windowGestureIsTranscript so sidebar/drawer scrolls on other
    // layouts don't touch the transcript. keydown is included here (gated) so
    // PageUp/Home/Shift+Space from body/header outside `.chat-thread` also
    // release synchronously; the gate keeps it from firing for unrelated
    // controls on the desktop/remote layout (where the scroller isn't window).
    view?.addEventListener?.("wheel", onWindowWheel, { passive: true });
    view?.addEventListener?.("touchstart", onWindowTouchStart, { passive: true });
    view?.addEventListener?.("touchmove", onWindowTouchMove, { passive: true });
    view?.addEventListener?.("touchend", onTouchEnd, { passive: true });
    view?.addEventListener?.("touchcancel", onTouchEnd, { passive: true });
    view?.addEventListener?.("keydown", onWindowKeyDown);

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
      view?.removeEventListener?.("wheel", onWindowWheel);
      view?.removeEventListener?.("touchstart", onWindowTouchStart);
      view?.removeEventListener?.("touchmove", onWindowTouchMove);
      view?.removeEventListener?.("touchend", onTouchEnd);
      view?.removeEventListener?.("touchcancel", onTouchEnd);
      view?.removeEventListener?.("keydown", onWindowKeyDown);
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
