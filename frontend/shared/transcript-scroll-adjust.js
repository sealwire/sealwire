import { elementScroll, observeElementOffset } from "@tanstack/virtual-core";

// A visible row can contain several cards. Its growth belongs below the reader,
// even when the row's top has already left the viewport.
export function shouldAdjustTranscriptRowSize(item, _delta, instance) {
  return item.end <= (instance.scrollElement?.scrollTop ?? instance.getScrollOffset());
}

// The TanStack virtualizer corrects `scrollTop` whenever a row measures differently
// from `estimateTranscriptRowSize`. Those writes to `.chat-thread` are untagged,
// unlike the stick-to-bottom follower's own pins (`selfScrollTop`).
//
// The correction it asks for is `getScrollOffset() + scrollAdjustments`, and
// `getScrollOffset()` is the LAST OBSERVED offset: TanStack normally updates it when
// a `scroll` event is dispatched (`observeElementOffset` also resets
// `scrollAdjustments` to 0). Scroll events are asynchronous, so between
// the browser applying a scroll and dispatching its event, that base is stale — and
// writing `staleBase + adjustments` DISCARDS the scroll the reader just made.
//
// While the transcript is bottom-following this is invisible: the stale base is "the
// bottom", which is where the follower wants to be anyway. The moment a reader wheels
// up, the same correction lands them back at the bottom, and the follower — seeing an
// untagged scroll at distance 0 — re-arms the follow and glues them there.
//
// This keeps the correction (rows really did change size, and the content above the
// reader really did move) but applies it as a DELTA against the live `scrollTop`, so it
// can no longer discard an un-observed scroll.
export function createTranscriptScrollAdjuster() {
  // How much of `virtual-core`'s running `scrollAdjustments` total we have already
  // applied. It hands us the cumulative figure each time, not the increment.
  let applied = 0;
  let syncOffset = null;

  const scrollToFn = (offset, options, instance) => {
    const { adjustments, behavior } = options || {};
    const element = instance?.scrollElement;

    // `adjustments === undefined` is every EXPLICIT scroll (mount, scrollToIndex,
    // scrollToOffset). Those mean the offset literally, so hand them straight through
    // and drop the running total with them.
    if (adjustments === undefined || !element) {
      applied = 0;
      elementScroll(offset, options, instance);
      return;
    }

    const delta = adjustments - applied;
    applied = adjustments;
    if (delta === 0) return;
    // `offset` is deliberately ignored: it is the stale base this whole module exists
    // to avoid writing.
    element.scrollTo({ top: element.scrollTop + delta, behavior });
  };

  // `virtual-core` zeroes `scrollAdjustments` in this same callback, so our running
  // total has to be zeroed at exactly the same moment or the next delta is miscomputed.
  const observeOffset = (instance, callback) => {
    const notify = (offset, isScrolling) => {
      applied = 0;
      callback(offset, isScrolling);
    };
    syncOffset = () => {
      const offset = instance.scrollElement.scrollTop;
      if (offset !== instance.getScrollOffset()) notify(offset, instance.isScrolling);
    };
    const cleanup = observeElementOffset(instance, notify);
    return () => {
      syncOffset = null;
      cleanup?.();
    };
  };

  return {
    scrollToFn,
    observeElementOffset: observeOffset,
    // A collapse can move farther than the overscan before its scroll event.
    // Use the same observation/reset path before selecting the rendered range.
    syncScrollOffset: () => syncOffset?.(),
  };
}
