// Top-anchor transcript scroll.
//
// Instead of chasing the bottom of a streaming transcript (which traps users
// at the latest message and fights them when they try to scroll up), we
// anchor the user's most-recent message to the top of the viewport. The
// assistant streams below it. This is the pattern Claude.ai and ChatGPT use.
//
// Programmatic scroll only happens on a few well-defined transitions:
//   - first view of a thread (or thread switch)  -> jump to bottom
//   - new user message appended                  -> scroll that message to top
//   - older transcript prepended                 -> anchor viewport so the
//                                                   user keeps their place
//   - everything else (streaming chunks, tool
//     activity, status updates, ...)             -> leave scrollTop alone
//
// The trailing CSS spacer on `.thread-content` (see conversation.css) is what
// makes "anchor user message at top" actually work mid-stream: it guarantees
// there's room below the latest content to scroll the user message all the
// way up.

export const TOP_SCROLL_PRESERVE_THRESHOLD_PX = 80;
export const LATEST_USER_MESSAGE_ATTR = "data-latest-user-message";
export const MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS = 10;

export function rememberTranscriptScrollPosition(cache, threadId, scrollElement) {
  if (!(cache instanceof Map) || !threadId || !scrollElement) {
    return null;
  }
  cache.delete(threadId);
  cache.set(threadId, Math.max(0, Number(scrollElement.scrollTop) || 0));
  let evictedThreadId = null;
  while (cache.size > MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS) {
    evictedThreadId = cache.keys().next().value;
    cache.delete(evictedThreadId);
  }
  return evictedThreadId;
}

export function readTranscriptScrollPosition(cache, threadId) {
  if (!(cache instanceof Map) || !threadId || !cache.has(threadId)) {
    return null;
  }
  const scrollTop = cache.get(threadId);
  cache.delete(threadId);
  cache.set(threadId, scrollTop);
  return scrollTop;
}

export function findLatestUserEntryId(entries) {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "user_text") {
      return entry.item_id || entry.id || null;
    }
  }
  return null;
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
    latestUserEntryId: findLatestUserEntryId(entries),
    scrollHeight: scrollElement?.scrollHeight || 0,
    scrollTop: scrollElement?.scrollTop || 0,
  };
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

export function didPrependOlderTranscript(previousEntries, nextEntries) {
  if (!previousEntries.length || nextEntries.length <= previousEntries.length) {
    return false;
  }
  const offset = nextEntries.length - previousEntries.length;
  return previousEntries.every((entry, index) => {
    return (
      transcriptEntryIdentity(entry)
      === transcriptEntryIdentity(nextEntries[index + offset])
    );
  });
}

export function decideTranscriptScrollAction({
  alreadyAnchoredUserIds = null,
  nextEntries = [],
  nextThreadId = null,
  previousSnapshot = null,
  restoredScrollTop = null,
  scrollElement,
}) {
  if (!scrollElement) {
    return { kind: "noop" };
  }

  const clientHeight = scrollElement.clientHeight || 0;
  const liveScrollHeight = scrollElement.scrollHeight || 0;
  const liveScrollTop = scrollElement.scrollTop || 0;
  const prevThreadId = previousSnapshot?.activeThreadId || null;
  const nextLatestUserId = findLatestUserEntryId(nextEntries);

  // Thread switch (or first ever view): land the user at the latest message
  // on first visit, but restore the exact retained offset on switch-back.
  if (!prevThreadId || prevThreadId !== nextThreadId) {
    if (Number.isFinite(restoredScrollTop)) {
      return {
        kind: "restore-thread",
        scrollTop: Math.max(0, restoredScrollTop),
      };
    }
    return {
      kind: "jump-bottom",
      scrollTop: Math.max(0, liveScrollHeight - clientHeight),
    };
  }

  // Older transcript prepended at the top: don't lose the reader's place.
  if (didPrependOlderTranscript(previousSnapshot?.entries || [], nextEntries)) {
    if (liveScrollTop <= TOP_SCROLL_PRESERVE_THRESHOLD_PX) {
      return { kind: "preserve" };
    }
    const prevScrollHeight = previousSnapshot?.scrollHeight || 0;
    return {
      kind: "anchor-prepend",
      scrollTop: Math.max(0, liveScrollHeight - prevScrollHeight + liveScrollTop),
    };
  }

  // New user message just landed: pin it to the top of the viewport so the
  // assistant's reply has room to stream below without the user message
  // sliding away. The CSS spacer guarantees we can actually scroll it up.
  //
  // The check uses an "already anchored" Set rather than the previous
  // snapshot's latestUserEntryId because intermediate renders can momentarily
  // show a subset of entries (e.g. mid-hydration), causing the snapshot's
  // latestUserEntryId to regress. The Set is monotonic per thread so we only
  // anchor a given user message once.
  if (
    nextLatestUserId
    && !(alreadyAnchoredUserIds && alreadyAnchoredUserIds.has(nextLatestUserId))
  ) {
    return { kind: "anchor-user", userEntryId: nextLatestUserId };
  }

  return { kind: "preserve" };
}

export function applyTranscriptScrollAction(action, scrollElement) {
  if (!action || !scrollElement) return;

  if (
    action.kind === "jump-bottom"
    || action.kind === "anchor-prepend"
    || action.kind === "restore-thread"
  ) {
    if (typeof action.scrollTop === "number") {
      scrollElement.scrollTop = action.scrollTop;
    }
    return;
  }

  if (action.kind === "anchor-user") {
    const target = scrollElement.querySelector?.(
      `[${LATEST_USER_MESSAGE_ATTR}="true"]`
    );
    if (!target) return;
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start", behavior: "auto" });
      return;
    }
    // Test/JSDOM fallback: position via offsetTop relative to the scroller.
    const offsetTop = typeof target.offsetTop === "number" ? target.offsetTop : 0;
    scrollElement.scrollTop = Math.max(0, offsetTop);
  }
  // "preserve" / "noop": intentionally do nothing.
}

export function restoreTranscriptScrollPosition({
  alreadyAnchoredUserIds = null,
  nextEntries = [],
  nextThreadId = null,
  previousSnapshot = null,
  restoredScrollTop = null,
  scrollElement,
}) {
  if (!scrollElement) {
    return null;
  }
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds,
    nextEntries,
    nextThreadId,
    previousSnapshot,
    restoredScrollTop,
    scrollElement,
  });
  applyTranscriptScrollAction(action, scrollElement);
  return action;
}
