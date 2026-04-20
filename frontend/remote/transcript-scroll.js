import { state } from "./state.js";
import {
  applyRemoteSurfacePatch,
  createTranscriptScrollModePatch,
} from "./surface-state.js";
import { remoteUiRefs } from "./ui-refs.js";

export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;
export const TOP_SCROLL_PRESERVE_THRESHOLD_PX = 80;

export function syncTranscriptScrollModeForSession(session, previousSession) {
  const nextThreadId = session?.active_thread_id || null;
  const previousThreadId = previousSession?.active_thread_id || null;

  if (!nextThreadId || nextThreadId !== previousThreadId) {
    applyRemoteSurfacePatch(createTranscriptScrollModePatch("follow-latest"));
  }
}

export function deriveTranscriptScrollMode({
  clientHeight,
  scrollHeight,
  scrollTop,
}) {
  const isNearBottom =
    scrollHeight - clientHeight - scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  return isNearBottom ? "follow-latest" : "preserve";
}

export function handleTranscriptScroll(
  transcript = remoteUiRefs.remoteTranscript,
  session = state.session
) {
  if (!session?.active_thread_id || !transcript) {
    return;
  }

  applyRemoteSurfacePatch(
    createTranscriptScrollModePatch(
      deriveTranscriptScrollMode({
        clientHeight: transcript.clientHeight || 0,
        scrollHeight: transcript.scrollHeight || 0,
        scrollTop: transcript.scrollTop || 0,
      })
    )
  );
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
