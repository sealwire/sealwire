import { isScrolledToBottom } from "./scroll-to-bottom-core.js";

import { getTranscriptScrollController, peekTranscriptScrollController } from "./transcript-scroll-controller.js";
import { TRANSCRIPT_SCROLL_ACTION_EVENT, TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX } from "./transcript-scroll-intent.js";
export { TRANSCRIPT_SCROLL_ACTION_EVENT, TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX } from "./transcript-scroll-intent.js";

// Public action entry points and bounded per-thread position storage. The
// controller owns transition policy, live intent, anchors and position writes.

export {
  TOP_SCROLL_PRESERVE_THRESHOLD_PX,
  LATEST_USER_MESSAGE_ATTR,
  findLatestUserEntryId,
  captureTranscriptScrollSnapshot,
  transcriptEntryIdentity,
  didPrependOlderTranscript,
  entryArrivedAbovePreviousWindow,
  decideTranscriptScrollAction,
} from "./transcript-scroll-policy.js";
export const MAX_RETAINED_TRANSCRIPT_SCROLL_THREADS = 10;
export function rememberTranscriptScrollPosition(cache, threadId, scrollElement) {
  if (!(cache instanceof Map) || !threadId || !scrollElement) {
    return null;
  }
  const scrollTop = Math.max(0, Number(scrollElement.scrollTop) || 0);
  const scrollHeight = Math.max(0, Number(scrollElement.scrollHeight) || 0);
  const clientHeight = Math.max(0, Number(scrollElement.clientHeight) || 0);
  cache.delete(threadId);
  cache.set(threadId, peekTranscriptScrollController(scrollElement)?.readPosition() || {
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
    ...(stored.anchor ? { anchor: stored.anchor } : {}),
  };
}

// Entry point for explicit UI intent. The controller applies it synchronously;
// the DOM event is a notification for observers, never another scroll owner.
export function dispatchTranscriptScrollActionEvent(element, kind) {
  const target = element?.closest?.(".chat-thread") || element;
  getTranscriptScrollController(target)?.apply({ kind });
  notifyTranscriptScrollAction(target, kind);
}

function notifyTranscriptScrollAction(target, kind) {
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
  getTranscriptScrollController(scrollElement)?.apply(action);
  if (["jump-bottom", "restore-thread", "input-required"].includes(action?.kind)) {
    notifyTranscriptScrollAction(scrollElement, action.kind);
  }
}

export function restoreTranscriptScrollPosition(options) {
  if (!options.scrollElement) return null;
  const action = getTranscriptScrollController(options.scrollElement).transition(options);
  if (["jump-bottom", "restore-thread", "input-required"].includes(action.kind)) {
    notifyTranscriptScrollAction(options.scrollElement, action.kind);
  }
  return action;
}
