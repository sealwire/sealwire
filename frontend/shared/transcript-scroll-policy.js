import { transcriptRowKey } from "./transcript-row-key.js";
import { TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX } from "./transcript-scroll-intent.js";

// Pure transition policy used by the controller. Callers supply thread data;
// this module has no DOM mutations, listeners or retained follow state.
export const TOP_SCROLL_PRESERVE_THRESHOLD_PX = 80;
export const LATEST_USER_MESSAGE_ATTR = "data-latest-user-message";

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

// Paged-in history lands above the previous window's top; a message just sent
// lands below it, even when it settles after its own reply started.
export function entryArrivedAbovePreviousWindow(previousEntries, nextEntries, entryId) {
  if (!entryId || !previousEntries?.length || !nextEntries?.length) {
    return false;
  }
  const nextIndexById = new Map();
  nextEntries.forEach((entry, index) => {
    const id = transcriptRowKey(entry);
    if (id) nextIndexById.set(id, index);
  });
  const entryIndex = nextIndexById.get(entryId);
  if (entryIndex === undefined) {
    return false;
  }
  for (const entry of previousEntries) {
    const id = transcriptRowKey(entry);
    if (id === entryId) {
      return false;
    }
    if (id && nextIndexById.has(id)) {
      return entryIndex < nextIndexById.get(id);
    }
  }
  return false;
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
        ...(restoredScrollPosition.anchor ? { anchor: restoredScrollPosition.anchor } : {}),
        ...handledUserEntry,
      };
    }
    return {
      kind: "jump-bottom",
      scrollTop: Math.max(0, liveScrollHeight - clientHeight),
      ...handledUserEntry,
    };
  }

  const previousEntries = previousSnapshot?.entries || [];
  const latestUserUnhandled = Boolean(
    nextLatestUserId
    && !(alreadyAnchoredUserIds && alreadyAnchoredUserIds.has(nextLatestUserId))
  );
  // A long turn's prompt can first arrive with an older page; unclaimed, the next
  // streamed row reads it as a send. Any distance off the bottom counts as reading.
  const readingHistory =
    liveScrollHeight - clientHeight - liveScrollTop > TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX;
  const revealedUserEntry =
    latestUserUnhandled
    && readingHistory
    && entryArrivedAbovePreviousWindow(previousEntries, nextEntries, nextLatestUserId)
      ? { userEntryId: nextLatestUserId }
      : {};

  // Older transcript prepended at the top: don't lose the reader's place.
  if (didPrependOlderTranscript(previousEntries, nextEntries)) {
    if (liveScrollTop <= TOP_SCROLL_PRESERVE_THRESHOLD_PX) {
      return { kind: "preserve", ...revealedUserEntry };
    }
    const prevScrollHeight = previousSnapshot?.scrollHeight || 0;
    return {
      kind: "anchor-prepend",
      scrollTop: Math.max(0, liveScrollHeight - prevScrollHeight + liveScrollTop),
      ...revealedUserEntry,
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
  if (latestUserUnhandled && !revealedUserEntry.userEntryId) {
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
      ...revealedUserEntry,
    };
  }

  return { kind: "preserve", ...revealedUserEntry };
}
