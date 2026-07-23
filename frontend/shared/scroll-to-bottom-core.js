// Pure helpers for the "scroll to latest" floating button.
//
// Kept free of React and DOM construction so they can be unit-tested directly
// (see scroll-to-bottom.test.mjs). The React component that consumes them lives
// in scroll-to-bottom.js. This mirrors the transcript-scroll.js (pure) /
// transcript-react.js (component) split elsewhere in the codebase.

// How close to the bottom counts as "already at the bottom". A little slack so
// sub-pixel rounding and the in-flow sticky anchor don't keep the button
// flickering on when the reader is effectively pinned to the latest content.
export const SCROLL_TO_BOTTOM_THRESHOLD_PX = 160;

// Resolve the scrollable ancestor that owns the transcript. The transcript is an
// ELEMENT scroller on every surface now (desktop, remote, and the narrow local
// conversation view are all pinned to one viewport with `.chat-thread` — the
// overflow:auto child of a fixed-height, overflow:hidden shell — doing the
// scrolling), so this is simply the nearest `.chat-thread`. Mirrors
// findTranscriptScrollElement in transcript-react.js.
export function findScrollContainer(node) {
  return node?.closest?.(".chat-thread") || null;
}

// Read scroll geometry from the `.chat-thread` element scroller.
export function readScrollMetrics(scrollEl) {
  if (!scrollEl) return null;
  return {
    scrollTop: scrollEl.scrollTop || 0,
    clientHeight: scrollEl.clientHeight || 0,
    scrollHeight: scrollEl.scrollHeight || 0,
  };
}

// The maximum scrollTop, i.e. the scrollTop value that lands at the very bottom.
export function maxScrollTop(metrics) {
  if (!metrics) return 0;
  return Math.max(0, (metrics.scrollHeight || 0) - (metrics.clientHeight || 0));
}

// The next scrollTop to apply while "following" the bottom during the click
// settle. Returns null when no move is needed — crucially, ALSO when the bottom
// is currently *above* us. `content-visibility: auto` makes scrollHeight flip
// between each row's 200px estimate and its real height as rows enter/leave the
// viewport, so the bottom momentarily jumps up; scrolling to it would yank the
// viewport backward and read as violent shaking. We only ever move downward and
// let the browser clamp us when the content shrinks.
export function nextSettleScrollTop(metrics) {
  if (!metrics) return null;
  const target = maxScrollTop(metrics);
  const current = metrics.scrollTop || 0;
  return target - current > 1 ? target : null;
}

export function isScrolledToBottom(metrics, threshold = SCROLL_TO_BOTTOM_THRESHOLD_PX) {
  if (!metrics) return true;
  const max = maxScrollTop(metrics);
  // Nothing to scroll: treat as "at the bottom" so the button stays hidden.
  if (max <= 1) return true;
  return max - (metrics.scrollTop || 0) <= threshold;
}

// The button is visible only when the content actually overflows AND the reader
// has drifted away from the bottom.
export function computeScrollToBottomVisible(
  metrics,
  threshold = SCROLL_TO_BOTTOM_THRESHOLD_PX
) {
  if (!metrics) return false;
  if (maxScrollTop(metrics) <= 1) return false;
  return !isScrolledToBottom(metrics, threshold);
}
