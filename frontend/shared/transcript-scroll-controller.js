import {
  classifyScrollIntent,
  classifyTranscriptScrollAction,
  RESTICK_AT_BOTTOM_PX,
} from "./transcript-scroll-intent.js";
import { decideTranscriptScrollAction } from "./transcript-scroll-policy.js";
import { captureReadingAnchor, captureElementAnchor, resolveReadingAnchor } from "./transcript-reading-anchor.js";

const controllers = new WeakMap();

export function peekTranscriptScrollController(element) {
  return element ? controllers.get(element) : undefined;
}

export function getTranscriptScrollController(element) {
  if (!element) return null;
  let controller = controllers.get(element);
  if (!controller) {
    controller = createTranscriptScrollController(element);
    controllers.set(element, controller);
  }
  return controller;
}

// How long after a wheel/key gesture an untagged scroll still counts as the reader's.
// This attributes following intent, not position. Touch momentum can outlive
// the input events; all native movement still updates the reading anchor.
const READER_INTENT_MS = 300;
const now = () => Date.now();

// Movement at or under this is jitter (fractional offsets, clamps). It neither
// escapes nor re-sticks; it accumulates until a real move shows its direction.
const SCROLL_JITTER_PX = 1;

// A finger pulled this far down asks for older content, whether or not the
// browser has reported the scroll yet. Past a tap's jitter, near the touch slop.
const TOUCH_ESCAPE_PX = 10;

function nestedScrollerCanScrollUp(target, scroller) {
  for (let node = target; node && node !== scroller; node = node.parentElement) {
    if (node.scrollTop > 0 && node.scrollHeight > node.clientHeight) {
      return true;
    }
  }
  return false;
}

function createTranscriptScrollController(scroller) {
  const view = scroller.ownerDocument?.defaultView || globalThis;
  const positionListeners = new Set();
  const publishPosition = () => {
    if (!positionListeners.size) return;
    const metrics = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
    for (const listener of positionListeners) listener(metrics);
  };
  let connected = false;
  let resizeObserver = null;
  let observedContent = null;
  let viewport = null;
  let anchor = null;
  let disclosure = null;
  let frame = null;
  let geometryDirty = false;
  const measurementKeys = new Set();
  let intentKnown = false;
  let flushing = false;
  const requestFrame = callback => (view.requestAnimationFrame || (fn => setTimeout(fn, 16))).call(view, callback);
  const cancelFrame = () => {
    if (frame !== null) (view.cancelAnimationFrame || clearTimeout).call(view, frame);
    frame = null;
  };

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
  // Topmost finger position this touch; pulling down from it asks for history.
  let touchAnchor = null;
  // The touch began in a nested box that scrolls up first, so the transcript
  // itself only moves (and reports it) once that box is exhausted.
  let touchInNestedScroller = false;
  // When the reader last wheeled/keyed on the scroller. Untagged scrolls outside this
  // window are layout/clamp effects, not evidence that the reader rejoined.
  let readerScrollAt = -Infinity;

  const distance = () =>
    Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
  const pin = () => {
    const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    selfScrollTop = target;
    lastScrollTop = target;
    if (scroller.scrollTop !== target) {
      write(target);
    }
  };
  const stick = () => {
    intentKnown = true;
    anchor = null;
    stuck = true;
    pin();
  };
  const unstick = () => {
    intentKnown = true;
    stuck = false;
    publishPosition();
  };

  // Follow growth: any content/viewport resize re-pins while stuck — UNLESS the
  // reader is mid-gesture, so we never fight an active drag. This is the only
  // thing that drives the follow and it is immune to the reader's scroll
  // position, so layout churn can never un-stick us here.
  // Wheel and keys are reader gestures that never raise `interacting` (no pointer is
  // down), so they are stamped instead. Momentum scrolling keeps emitting `wheel`
  // while it coasts, so a flick down to the bottom stays attributed to the reader
  // for as long as it is still moving.
  const stampReader = () => {
    readerScrollAt = now();
  };
  const readerDriven = () => now() - readerScrollAt <= READER_INTENT_MS;
  const readFromHere = () => {
    const needsAnchor = stuck || !anchor;
    unstick();
    consumeNativeMovement();
    // A short first page may not scroll at all. Capture before the gesture
    // starts loading history; there may be no scroll event before it arrives.
    if (needsAnchor) capture();
  };
  const onWheel = (event) => {
    stampReader();
    disclosure = null;
    // Wheel does not go through the pointer-down path, so escape here directly.
    if (!event.ctrlKey && (event.deltaY || 0) < 0) {
      readFromHere();
    }
  };
  const onKeyDown = event => {
    if (event.target?.closest?.("input, textarea, [contenteditable]")) return;
    if ([" ", "Enter"].includes(event.key) && event.target?.closest?.("button, summary, [aria-expanded]")) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stampReader();
  };
  const onScroll = () => {
    schedule();
    const sp = scroller.scrollTop;
    if (selfScrollTop >= 0 && Math.abs(sp - selfScrollTop) <= 1) {
      selfScrollTop = -1;
      lastScrollTop = sp;
      return;
    }
    selfScrollTop = -1;
    // Measuring newly mounted history can shrink the estimated scroll range.
    // The browser clamps the offset before its scroll event; that lost range
    // is layout movement, not an upward gesture to bake into the anchor.
    const previousTop = Math.min(lastScrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    const scrolledUp = sp < previousTop - SCROLL_JITTER_PX;
    const scrolledDown = sp > previousTop + SCROLL_JITTER_PX;
    // Kept on jitter, so a drag of one pixel per frame still adds up to a move.
    if (scrolledUp || scrolledDown) {
      if (anchor) {
        anchor = { ...anchor, offset: anchor.offset - (sp - previousTop) };
      }
      lastScrollTop = sp;
    }
    else if (previousTop !== lastScrollTop) lastScrollTop = previousTop;
    const action = classifyScrollIntent({
      scrolledUp,
      scrolledDown,
      distance: distance(),
      interacting: interacting(),
      stuck,
      readerDriven: readerDriven(),
    });
    if (action === "unstick") {
      unstick();
    } else if (action === "stick") stick();
    else if (action === "pin") pin();
  };
  const touchPoint = (event) => {
    const point = event?.touches?.[0];
    return typeof point?.clientY === "number"
      ? { x: Number(point.clientX) || 0, y: point.clientY }
      : null;
  };
  const onTouchStart = (event) => {
    touchActive = true;
    stampReader();
    touchAnchor = touchPoint(event);
    touchInNestedScroller = nestedScrollerCanScrollUp(event?.target, scroller);
  };
  // touchmove also keeps the flag hot: Chromium can fire touchcancel when a
  // touch turns into a scroll, so refreshing on every move keeps `interacting`
  // true through the whole drag regardless of a spurious cancel.
  const onTouchMove = (event) => {
    touchActive = true;
    stampReader();
    const point = touchPoint(event);
    if (!point) return;
    if (!touchAnchor || point.y < touchAnchor.y) {
      touchAnchor = point;
      return;
    }
    // Escape on the finger, not the scroll: a flick's scroll events can all land
    // after touchend, and by then lifting has already re-pinned the bottom.
    const pulled = point.y - touchAnchor.y;
    if (
      !touchInNestedScroller
      && pulled >= TOUCH_ESCAPE_PX
      && pulled > Math.abs(point.x - touchAnchor.x)
      && scroller.scrollTop > 0
    ) {
      readFromHere();
    }
  };
  const onTouchEnd = () => {
    stampReader();
    touchActive = false;
    touchAnchor = null;
    endInteract();
  };
  const onMouseDown = () => {
    mouseActive = true;
  };
  const onMouseUp = () => {
    mouseActive = false;
    endInteract();
  };
  // Rejoin belongs to a downward reader scroll, never to lifting a finger or
  // clicking a disclosure that happens to be near the bottom.
  const endInteract = () => {
    if (interacting()) return;
    if (stuck) pin();
  };


  // Every programmatic transcript write goes through this point, including
  // virtualizer corrections. Its echo must never count as a reader gesture.
  function write(top) {
    if (!Number.isFinite(top)) return;
    if (scroller.scrollTop !== top) scroller.scrollTop = top;
    selfScrollTop = scroller.scrollTop;
    lastScrollTop = selfScrollTop;
  }

  function schedule() {
    if (!connected || frame !== null || flushing) return;
    frame = requestFrame(flush);
  }

  function geometryChanged(rowKey) {
    if (rowKey != null) measurementKeys.add(rowKey);
    geometryDirty = true;
    schedule();
  }

  function consumeNativeMovement() {
    if (Math.abs(scroller.scrollTop - lastScrollTop) > SCROLL_JITTER_PX) onScroll();
  }

  function capture() {
    if (!stuck) anchor = captureReadingAnchor(scroller) || anchor;
  }

  function restoreAnchor(saved, domOnly = false) {
    if (!saved) return false;
    let candidate = saved;
    let resolved;
    let target;
    for (const alternative of [saved, saved.next, saved.previous]) {
      if (!alternative) continue;
      candidate = alternative === saved ? saved : {
        ...alternative, offset: Math.max(0, Math.min(saved.offset, scroller.clientHeight - 40)),
      };
      resolved = resolveReadingAnchor(scroller, candidate);
      // RO can precede the range commit that mounts a restored thread/reveal
      // target. Keep its address for rAF rather than selecting a different row.
      if (domOnly && !resolved) return false;
      if (resolved?.rowKey != null) candidate.rowKey = resolved.rowKey;
      // Use the measured row's NEW position before React commits its transform.
      // Otherwise a large shrink unmounts the row we are trying to retain.
      const projected = !domOnly && viewport?.locate(candidate, resolved?.rowOffset ?? candidate.rowOffset, resolved?.offset ?? candidate.offset);
      target = Number.isFinite(projected) ? projected
        : resolved ? scroller.scrollTop + resolved.position - resolved.offset : null;
      if (Number.isFinite(target)) break;
    }
    if (!Number.isFinite(target)) {
      if (saved === anchor) anchor = captureReadingAnchor(scroller);
      return false;
    }
    if (candidate !== saved) {
      if (saved === anchor) anchor = candidate;
      if (saved === disclosure) disclosure = candidate;
    }
    if (resolved?.rowOffset != null) candidate.rowOffset = resolved.rowOffset;
    if (Math.abs(target - scroller.scrollTop) <= .5) return false;
    const before = scroller.scrollTop;
    write(target);
    return Math.abs(scroller.scrollTop - before) > .5;
  }

  function flush() {
    frame = null;
    flushing = true;
    // The native scroller moves before delivering its scroll event. Consume
    // that movement against the same live offset before applying any resize.
    consumeNativeMovement();
    const changed = geometryDirty;
    geometryDirty = false;
    if (changed) {
      for (const key of measurementKeys) viewport?.measure(key);
      const measured = measurementKeys.size > 0;
      measurementKeys.clear();
      const saved = disclosure || anchor;
      const moved = saved && (!interacting() || disclosure) && restoreAnchor(saved);
      if (!saved && stuck && !interacting()) pin();
      if (saved && (moved || disclosure || measured)) {
        viewport?.commit();
        if ((!interacting() || disclosure) && restoreAnchor(saved)) viewport?.commit();
      }
      if (disclosure) anchor = stuck ? null : disclosure;
      disclosure = null;
    }
    // A measurement can itself mount rows with newly measured heights. Retain
    // the same identity through those updates, rather than capturing the line
    // temporarily passing through the viewport while its neighbors settle.
    if (!changed || !anchor) capture();
    flushing = false;
    publishPosition();
    if (geometryDirty) schedule();
  }

  function apply(action) {
    if (!action) return;
    const intent = classifyTranscriptScrollAction(action);
    if (intent !== "none") intentKnown = true;
    if (intent === "stick") {
      anchor = null;
      disclosure = null;
      stick();
      geometryChanged();
    } else if (action.kind === "reveal-content") {
      unstick();
      disclosure = null;
      anchor = { path: [action.contentId], rowKey: action.rowKey, rowOffset: 0, offset: 0, edge: "top" };
      geometryChanged();
    } else if (action.kind === "restore-thread") {
      unstick();
      disclosure = null;
      anchor = action.anchor || null;
      write(action.scrollTop);
      if (anchor) geometryChanged();
    } else if (intent === "unstick") {
      unstick();
      capture();
    } else if (action.kind === "anchor-prepend") {
      if (stuck) {
        geometryChanged();
        return;
      }
      anchor = action.anchor || anchor;
      if (anchor) geometryChanged();
      else write(action.scrollTop);
    }
    publishPosition();
  }

  function disclosureChange(element, expanded) {
    // Queue before the component changes its own state, including an offscreen
    // focused control. Waiting for RO would miss this frame's paint.
    geometryChanged(element.closest("[data-transcript-row-key]")?.getAttribute("data-transcript-row-key"));
    if (!expanded) return;
    // The clicked edge is a short-lived semantic anchor. The identity survives
    // replacement of the control; no durable position retains a DOM node.
    const rect = element.getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) return;
    disclosure = captureElementAnchor(scroller, element, rect.top < bounds.top ? "bottom" : "top");
  }

  function correctObservedGeometry() {
    consumeNativeMovement();
    // RO runs after rAF. Correct the already-mounted DOM before this paint;
    // React range updates remain in rAF to avoid observer delivery loops.
    if (!interacting()) {
      if (disclosure || anchor) restoreAnchor(disclosure || anchor, true);
      else if (stuck) pin();
    }
  }

  function refreshContent() {
    const content = scroller.querySelector?.(".thread-content") || null;
    if (content !== observedContent) {
      if (observedContent) resizeObserver?.unobserve(observedContent);
      if (content) resizeObserver?.observe(content);
      observedContent = content;
    }
  }

  function connect() {
    connected = true;
    resizeObserver = new ResizeObserver(() => {
      correctObservedGeometry();
      geometryChanged();
    });

    resizeObserver.observe(scroller);
    const content = scroller.querySelector(".thread-content");
    if (content) {
      resizeObserver.observe(content);
      observedContent = content;
    }

    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKeyDown, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("touchend", onTouchEnd, { passive: true });
    scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
    scroller.addEventListener("mousedown", onMouseDown, { passive: true });
    // Mouse-up can land outside the scroller (scrollbar drag released elsewhere).
    view.addEventListener("mouseup", onMouseUp, { passive: true });

    return () => {
      cancelFrame();
      connected = false;
      resizeObserver.disconnect();
      resizeObserver = null;
      observedContent = null;
      measurementKeys.clear();
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      scroller.removeEventListener("mousedown", onMouseDown);
      view.removeEventListener("mouseup", onMouseUp);
    };
  }

  return {
    connect, refreshContent, apply, disclosureChange, geometryChanged,
    contentCommitted() {
      if (!geometryDirty || (interacting() && !disclosure)) return;
      consumeNativeMovement();
      if (disclosure || anchor) restoreAnchor(disclosure || anchor);
      else if (stuck) pin();
      // A history response can commit inside rAF. Waiting for another rAF
      // would paint a range that no longer contains the reading target. React
      // layout effects can update this range before paint, without flushSync.
      // Mount-time measurements may already have corrected the DOM offset
      // before this effect. Synchronize that offset even if no further write
      // was needed here, so the virtual range cannot lag behind it.
      viewport?.commit(false);
    },
    transition(options) {
      const action = decideTranscriptScrollAction(options);
      apply(action);
      return action;
    },
    subscribePosition(listener) { positionListeners.add(listener); return () => positionListeners.delete(listener); },
    setViewport(adapter) { viewport = adapter; return () => { if (viewport === adapter) viewport = null; }; },
    resizeRow(item, _delta, instance) {
      if (anchor || disclosure || stuck) {
        geometryChanged();
        if (!interacting()) {
          // Includes component-local and intrinsic growth within a shared row.
          correctObservedGeometry();
          return false;
        }
        // During a native drag keep the existing above-viewport compensation.
        // The tagged write moves content with the finger, without rejoining.
      }
      return item.end <= (instance.scrollElement?.scrollTop ?? instance.getScrollOffset());
    },
    adjustBy(delta) { consumeNativeMovement(); write(scroller.scrollTop + delta); },
    position(top) { write(top); },
    readPosition() {
      return { followBottom: intentKnown ? stuck : distance() <= RESTICK_AT_BOTTOM_PX,
        scrollTop: Math.max(0, scroller.scrollTop || 0),
        ...(anchor ? { anchor: { ...anchor } } : {}) };
    },
  };
}
