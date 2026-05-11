export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 4;
export const TOP_SCROLL_PRESERVE_THRESHOLD_PX = 80;

export function deriveTranscriptScrollMode({
  clientHeight,
  scrollHeight,
  scrollTop,
}) {
  const isNearBottom =
    scrollHeight - clientHeight - scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  return isNearBottom ? "follow-latest" : "preserve";
}

export function computeTranscriptScrollPosition({
  clientHeight,
  currentMode,
  nextEntries,
  nextScrollHeight,
  nextThreadId,
  previousEntries,
  previousScrollHeight,
  previousScrollTop,
  previousThreadId,
}) {
  const shouldAutoScroll =
    currentMode === "follow-latest"
    || !previousThreadId
    || previousThreadId !== nextThreadId
    || previousScrollHeight - clientHeight - previousScrollTop
      <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  const prependedOlderTranscript = didPrependOlderTranscript(
    previousEntries,
    nextEntries
  );

  if (shouldAutoScroll) {
    return {
      reason: "stick-bottom",
      scrollTop: Math.max(0, nextScrollHeight - clientHeight),
    };
  }

  if (prependedOlderTranscript) {
    if (previousScrollTop <= TOP_SCROLL_PRESERVE_THRESHOLD_PX) {
      return {
        reason: "prepended-keep-top",
        scrollTop: 0,
      };
    }

    return {
      reason: "prepended-anchor",
      scrollTop: Math.max(
        0,
        nextScrollHeight - previousScrollHeight + previousScrollTop
      ),
    };
  }

  const maxScrollTop = Math.max(0, nextScrollHeight - clientHeight);
  return {
    reason: "preserve",
    scrollTop: Math.min(previousScrollTop, maxScrollTop),
  };
}

export function captureTranscriptScrollSnapshot({
  entries = [],
  scrollElement,
  threadId = null,
}) {
  return {
    activeThreadId: threadId,
    clientHeight: scrollElement?.clientHeight || 0,
    entries,
    scrollHeight: scrollElement?.scrollHeight || 0,
    scrollTop: scrollElement?.scrollTop || 0,
  };
}

export function restoreTranscriptScrollPosition({
  currentMode,
  nextEntries = [],
  nextThreadId = null,
  previousSnapshot,
  scrollElement,
}) {
  if (!scrollElement || !previousSnapshot) {
    return null;
  }

  const nextPosition = computeTranscriptScrollPosition({
    clientHeight: scrollElement.clientHeight || 0,
    currentMode,
    nextEntries,
    nextScrollHeight: scrollElement.scrollHeight || 0,
    nextThreadId,
    previousEntries: previousSnapshot.entries || [],
    previousScrollHeight: previousSnapshot.scrollHeight || 0,
    previousScrollTop: previousSnapshot.scrollTop || 0,
    previousThreadId: previousSnapshot.activeThreadId || null,
  });

  if (Math.abs((scrollElement.scrollTop || 0) - nextPosition.scrollTop) > 1) {
    scrollElement.scrollTop = nextPosition.scrollTop;
  }

  return nextPosition;
}

export function didPrependOlderTranscript(previousEntries, nextEntries) {
  if (!previousEntries.length || nextEntries.length <= previousEntries.length) {
    return false;
  }

  const offset = nextEntries.length - previousEntries.length;
  return previousEntries.every((entry, index) => {
    return transcriptEntryIdentity(entry) === transcriptEntryIdentity(nextEntries[index + offset]);
  });
}

export function transcriptEntryIdentity(entry) {
  return [
    entry?.item_id || "",
    entry?.kind || "",
    entry?.status || "",
    entry?.turn_id || "",
    entry?.tool?.item_type || "",
    entry?.tool?.name || "",
  ].join("|");
}
