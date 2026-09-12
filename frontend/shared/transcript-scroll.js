import { isScrolledToBottom } from "./scroll-to-bottom-core.js";
import { transcriptRowKey } from "./transcript-row-key.js";

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
// Match the live follower's re-stick boundary. The floating button uses a much
// wider "near bottom" band, but a reader who deliberately escaped by even one
// wheel tick must retain that history-reading intent across a thread switch.
export const TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX = 4;

// Dispatched on the scroll element after a programmatic scroll action is
// APPLIED, with `detail.kind` set to the action kind. This is how the
// stick-to-bottom follower (stick-to-bottom.js) learns about transitions that
// carry intent — "the reader was just anchored to their sent message", "we
// just landed at the bottom of a thread" — which geometry alone cannot
// distinguish from user scrolling.
export const TRANSCRIPT_SCROLL_ACTION_EVENT = "transcript-scroll-action";

export function rememberTranscriptScrollPosition(cache, threadId, scrollElement) {
  if (!(cache instanceof Map) || !threadId || !scrollElement) {
    return null;
  }
  const scrollTop = Math.max(0, Number(scrollElement.scrollTop) || 0);
  const scrollHeight = Math.max(0, Number(scrollElement.scrollHeight) || 0);
  const clientHeight = Math.max(0, Number(scrollElement.clientHeight) || 0);
  cache.delete(threadId);
  cache.set(threadId, {
    // Preserve the reader's intent, not only a pixel coordinate. A live thread
    // may grow by thousands of pixels while hidden; restoring its old
    // `scrollTop` would strand a formerly-bottom-following reader in history.
    followBottom: isScrolledToBottom(
      { scrollTop, scrollHeight, clientHeight },
      TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX
    ),
    scrollTop,
  });
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
  const stored = cache.get(threadId);
  cache.delete(threadId);
  cache.set(threadId, stored);
  // Compatibility with in-memory numeric entries created before this shape was
  // introduced (and with small pure-object tests). They represent an exact
  // historical offset, never an implicit bottom-follow intent.
  if (Number.isFinite(stored)) {
    return {
      followBottom: false,
      scrollTop: Math.max(0, stored),
    };
  }
  if (!stored || typeof stored !== "object") {
    return null;
  }
  return {
    followBottom: Boolean(stored.followBottom),
    scrollTop: Math.max(0, Number(stored.scrollTop) || 0),
  };
}

export function findLatestUserEntryId(entries) {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "user_text") {
      return transcriptRowKey(entry);
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
    transcriptRowKey(entry) || "",
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

export function decideTranscriptScrollAction(options = {}) {
  const action = decideTranscriptScrollPosition(options);
  const pendingInputRequestIds = options.pendingInputRequestIds || [];
  // EVERY action that positioned the viewport for this render claims the pending
  // request — not just the one that scrolled to it.
  //
  // The relay publishes a user message and an approval in the same beat, so a send
  // and a request routinely land in ONE render. That render's own `jump-bottom`
  // already put the request on screen; leaving it unclaimed meant the next render
  // saw a "new" request and yanked back a reader who had since scrolled away —
  // breaking the fire-once rule on the most common path there is.
  //
  // The same holds for actions that deliberately position the reader somewhere
  // ELSE (`restore-thread`, `anchor-prepend`): whatever this render decided wins,
  // and must not be undone behind it on the next one. `noop` is the exception —
  // there was no scroll element, so nothing was positioned and nothing is claimed.
  //
  // ALL pending ids are claimed, not just the one that triggered: several
  // requests can arrive in one beat, and this render showed (or deliberately
  // positioned away from) every one of them.
  if (pendingInputRequestIds.length && action.kind !== "noop" && !action.inputRequestIds) {
    return { ...action, inputRequestIds: [...pendingInputRequestIds] };
  }
  return action;
}

function decideTranscriptScrollPosition({
  alreadyAnchoredUserIds = null,
  nextEntries = [],
  nextThreadId = null,
  // Ids of every request currently blocking this thread on the reader (an
  // approval or an AskUser question). Derived by the call site via
  // `findPendingInputRequestIds` (thread-attention.js) so this stays a pure
  // decision function. Recorded into `alreadyAnchoredUserIds` once handled —
  // the ids are namespaced, so they cannot collide with transcript item ids.
  pendingInputRequestIds = [],
  previousSnapshot = null,
  restoredScrollPosition = null,
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
  // on first visit. On switch-back, preserve the semantic bottom-follow state
  // for readers who left at the tail; only restore an exact offset when they
  // were intentionally reading history. Seed the current latest user entry as
  // already handled on every thread transition: otherwise the next unrelated
  // render would mistake retained history for a newly-arrived user message and
  // jump to the bottom, undoing a restore-thread action.
  if (!prevThreadId || prevThreadId !== nextThreadId) {
    // (A pending input request is claimed by the caller wrapper, for every branch
    // below — the transition owns this render's position either way.)
    const handledUserEntry = nextLatestUserId
      ? { userEntryId: nextLatestUserId }
      : {};
    if (restoredScrollPosition?.followBottom) {
      return {
        kind: "jump-bottom",
        scrollTop: Math.max(0, liveScrollHeight - clientHeight),
        ...handledUserEntry,
      };
    }
    if (Number.isFinite(restoredScrollPosition?.scrollTop)) {
      return {
        kind: "restore-thread",
        scrollTop: Math.max(0, restoredScrollPosition.scrollTop),
        ...handledUserEntry,
      };
    }
    return {
      kind: "jump-bottom",
      scrollTop: Math.max(0, liveScrollHeight - clientHeight),
      ...handledUserEntry,
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

  // New user message just landed: lock the transcript to the bottom so the
  // reply streams in below (bottom-follow). This is deliberately NOT a
  // top-anchor — the sent message is not pinned to the top and there is no
  // viewport-fraction reserve; the stick-to-bottom follower keeps us pinned
  // while the reader stays at the bottom.
  //
  // Fire the jump-bottom ONCE per new user message: the set guards re-firing so
  // a reader who scrolls up mid-stream is not yanked back down on every render.
  // The check uses an "already handled" Set rather than the previous snapshot's
  // latestUserEntryId because intermediate renders can momentarily show a subset
  // of entries (e.g. mid-hydration), causing the snapshot's latestUserEntryId to
  // regress. The Set is monotonic per thread so we only fire once.
  if (
    nextLatestUserId
    && !(alreadyAnchoredUserIds && alreadyAnchoredUserIds.has(nextLatestUserId))
  ) {
    return {
      kind: "jump-bottom",
      scrollTop: Math.max(0, liveScrollHeight - clientHeight),
      userEntryId: nextLatestUserId,
    };
  }

  // The agent is blocked on the reader. The request renders at the BOTTOM of the
  // transcript (the approval card is pushed last, after every entry) but it is
  // not a transcript entry at all — no item_id, never in the hydration window —
  // so none of the triggers above can see it. Without this the decision is
  // `preserve`, the follower re-pins only if it happens to be stuck already, and
  // the thing the session is waiting on sits below the fold: it looks hung.
  //
  // Fire ONCE per request id, exactly like a new user message: a reader who
  // scrolled up to re-read the command being approved must stay where they put
  // themselves. A second request in the same thread has a new id, so it fires.
  // Any request we have not shown yet fires — including a SECOND question that
  // arrives while the first is still outstanding.
  const unhandledInputRequest = pendingInputRequestIds.some(
    (requestId) => !(alreadyAnchoredUserIds && alreadyAnchoredUserIds.has(requestId))
  );
  if (unhandledInputRequest) {
    return {
      kind: "input-required",
      scrollTop: Math.max(0, liveScrollHeight - clientHeight),
      inputRequestIds: [...pendingInputRequestIds],
    };
  }

  return { kind: "preserve" };
}

// Broadcast an applied scroll action to the stick-to-bottom follower. Fired
// AFTER the scroll is applied so listeners read post-scroll geometry. Only
// actions that carry stickiness intent are broadcast: jump-bottom and
// restore-thread (where did we land? — should we follow?). `anchor-prepend`
// keeps the reader's place and "preserve"/"noop" do nothing, so neither says
// anything about following. Guarded so pure-object fakes in tests (no
// dispatchEvent) and exotic embeds (no CustomEvent) stay valid.
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
    || action.kind === "input-required"
    || action.kind === "restore-thread"
  ) {
    // Position the scroller, then broadcast the intent. For jump-bottom the write
    // lands us at the bottom immediately (a safety net if the follower's listener
    // attaches a tick late) AND the follower sticks — our hand-rolled follower is
    // robust to this write (it sees distance≈0 and sticks, and tags its own pins
    // so it never mistakes them for a reader scroll).
    if (typeof action.scrollTop === "number") {
      scrollElement.scrollTop = action.scrollTop;
      if (action.kind !== "anchor-prepend") {
        dispatchTranscriptScrollActionEvent(scrollElement, action.kind);
      }
    }
    return;
  }
  // "anchor-user" is gone (bottom-follow); "preserve" / "noop": do nothing.
}

export function restoreTranscriptScrollPosition({
  alreadyAnchoredUserIds = null,
  nextEntries = [],
  nextThreadId = null,
  pendingInputRequestIds = [],
  previousSnapshot = null,
  restoredScrollPosition = null,
  scrollElement,
}) {
  if (!scrollElement) {
    return null;
  }
  const action = decideTranscriptScrollAction({
    alreadyAnchoredUserIds,
    nextEntries,
    nextThreadId,
    pendingInputRequestIds,
    previousSnapshot,
    restoredScrollPosition,
    scrollElement,
  });
  applyTranscriptScrollAction(action, scrollElement);
  return action;
}
