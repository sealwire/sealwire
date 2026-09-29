import { observeElementOffset } from "@tanstack/virtual-core";

import { getTranscriptScrollController } from "./transcript-scroll-controller.js";

// The controller uses a content anchor when available. Before one is captured,
// only a row wholly above the live viewport receives an offset correction.
export function shouldAdjustTranscriptRowSize(item, delta, instance) {
  return getTranscriptScrollController(instance.scrollElement)?.resizeRow(item, delta, instance)
    ?? (item.end <= instance.getScrollOffset());
}

// TanStack requests lastObservedOffset + cumulativeAdjustment. Native scrolling
// can already have moved while its scroll event is still pending, so that base
// may be stale. Convert the cumulative total to an increment and let the sole
// controller apply it against the live offset, tagging the resulting write.
export function createTranscriptScrollAdjuster() {
  // How much of `virtual-core`'s running `scrollAdjustments` total we have already
  // applied. It hands us the cumulative figure each time, not the increment.
  let applied = 0;
  let syncOffset = null;

  const scrollToFn = (offset, options, instance) => {
    const { adjustments } = options || {};
    const element = instance?.scrollElement;

    // `adjustments === undefined` is every EXPLICIT scroll (mount, scrollToIndex,
    // scrollToOffset). Those mean the offset literally, so hand them straight through
    // and drop the running total with them.
    if (adjustments === undefined || !element) {
      applied = 0;
      getTranscriptScrollController(element)?.position(offset);
      return;
    }

    const delta = adjustments - applied;
    applied = adjustments;
    if (delta === 0) return;
    // `offset` is deliberately ignored: it is the stale base this whole module exists
    // to avoid writing.
    getTranscriptScrollController(element).adjustBy(delta);
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
