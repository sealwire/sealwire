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

// Dispatched on the scroll element after a programmatic scroll action is
// APPLIED, with `detail.kind` set to the action kind. This is how the
// stick-to-bottom follower (stick-to-bottom.js) learns about transitions that
// carry intent — "the reader was just anchored to their sent message", "we
// just landed at the bottom of a thread" — which geometry alone cannot
// distinguish from user scrolling.
export const TRANSCRIPT_SCROLL_ACTION_EVENT = "transcript-scroll-action";

// Rekey the per-thread scroll bookkeeping when a thread's public id changes
// while remaining the same logical thread — the deferred-Claude case, where a
// synthetic `claude-pending-*` id is promoted to the real session id on the
// first send. Without this, the promoted id reads as a thread SWITCH and the
// first reply lands via jump-bottom (briefly sticky) instead of anchoring the
// user's message. Returns true if anything was rekeyed.
export function retargetTranscriptScrollThread(state, fromThreadId, toThreadId) {
  if (!state || !fromThreadId || !toThreadId || fromThreadId === toThreadId) {
    return false;
  }
  let changed = false;
  const snapshot = state.localTranscriptScrollSnapshot;
  if (snapshot?.activeThreadId === fromThreadId) {
    snapshot.activeThreadId = toThreadId;
    changed = true;
  }
  const positions = state.localTranscriptScrollPositions;
  if (positions instanceof Map && positions.has(fromThreadId)) {
    positions.set(toThreadId, positions.get(fromThreadId));
    positions.delete(fromThreadId);
    changed = true;
  }
  const anchors = state.localTranscriptScrollAnchors;
  if (anchors instanceof Map && anchors.has(fromThreadId)) {
    anchors.set(toThreadId, anchors.get(fromThreadId));
    anchors.delete(fromThreadId);
    changed = true;
  }
  return changed;
}

// Remote-surface flavor of the promotion rekey: the remote pane keys its
// retained maps by `relayId:threadId` scroll keys and keeps its previous-render
// snapshot in a ref, so both the keys and the snapshot need rebinding when a
// `claude-pending-*` id is promoted. Returns true if anything was rekeyed.
export function retargetRemoteTranscriptScroll(options) {
  const {
    anchoredUserIds,
    scrollPositions,
    snapshot,
    fromScrollKey,
    toScrollKey,
    fromThreadId,
    toThreadId,
  } = options || {};
  if (
    !fromScrollKey
    || !toScrollKey
    || !fromThreadId
    || !toThreadId
    || fromScrollKey === toScrollKey
  ) {
    return false;
  }
  let changed = false;
  if (snapshot?.activeThreadId === fromThreadId) {
    snapshot.activeThreadId = toThreadId;
    if (snapshot.scrollKey === fromScrollKey) {
      snapshot.scrollKey = toScrollKey;
    }
    changed = true;
  }
  if (scrollPositions instanceof Map && scrollPositions.has(fromScrollKey)) {
    scrollPositions.set(toScrollKey, scrollPositions.get(fromScrollKey));
    scrollPositions.delete(fromScrollKey);
    changed = true;
  }
  if (anchoredUserIds instanceof Map && anchoredUserIds.has(fromScrollKey)) {
    anchoredUserIds.set(toScrollKey, anchoredUserIds.get(fromScrollKey));
    anchoredUserIds.delete(fromScrollKey);
    changed = true;
  }
  return changed;
}

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

// Broadcast an applied scroll action to the stick-to-bottom follower. Fired
// AFTER the scroll is applied so listeners read post-scroll geometry. Only
// actions that carry stickiness intent are broadcast: jump-bottom /
// restore-thread (where did we land?) and anchor-user (release the follow).
// `anchor-prepend` keeps the reader's place and "preserve"/"noop" do nothing,
// so neither says anything about following. Guarded so pure-object fakes in
// tests (no dispatchEvent) and exotic embeds (no CustomEvent) stay valid.
export function dispatchTranscriptScrollActionEvent(element, kind) {
  const target = element?.closest?.(".chat-thread") || element;
  if (
    !target
    || typeof target.dispatchEvent !== "function"
    || typeof CustomEvent !== "function"
  ) {
    return;
  }
  target.dispatchEvent(
    new CustomEvent(TRANSCRIPT_SCROLL_ACTION_EVENT, { detail: { kind } })
  );
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
      if (action.kind !== "anchor-prepend") {
        dispatchTranscriptScrollActionEvent(scrollElement, action.kind);
      }
    }
    return;
  }

  if (action.kind === "anchor-user") {
    const target = scrollElement.querySelector?.(
      `[${LATEST_USER_MESSAGE_ATTR}="true"]`
    );
    // Without a rendered target nothing scrolled, so there is no intent to
    // broadcast — in virtualized transcripts the scrollToIndex path (see
    // transcript-react.js) performs the anchor and broadcasts instead.
    if (!target) return;
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "start", behavior: "auto" });
    } else {
      // Test/JSDOM fallback: position via offsetTop relative to the scroller.
      const offsetTop = typeof target.offsetTop === "number" ? target.offsetTop : 0;
      scrollElement.scrollTop = Math.max(0, offsetTop);
    }
    dispatchTranscriptScrollActionEvent(scrollElement, "anchor-user");
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
