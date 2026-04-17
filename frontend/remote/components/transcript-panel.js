import * as dom from "../dom.js";
import { renderTranscriptMarkup } from "../../shared/transcript-render.js";
import { renderLog as appendClientLog } from "../render-transcript.js";
import { state } from "../state.js";
import {
  applyRemoteSurfacePatch,
  createTranscriptScrollModePatch,
} from "../surface-state.js";
import {
  renderReadyTranscriptUi,
  renderTranscriptEmptyUi,
  renderTranscriptMarkupUi,
} from "../ui-renderer.js";

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 80;
const TOP_SCROLL_PRESERVE_THRESHOLD_PX = 80;
const REMOTE_SCROLL_DEBUG_BANNER = "remote-scroll-debug-2026-04-16b";
let pendingTranscriptScrollFrame = null;
let transcriptScrollOperationId = 0;

export function syncTranscriptScrollModeForSession(session, previousSession) {
  const nextThreadId = session?.active_thread_id || null;
  const previousThreadId = previousSession?.active_thread_id || null;

  if (!nextThreadId) {
    applyRemoteSurfacePatch(createTranscriptScrollModePatch("follow-latest"));
    return;
  }

  if (nextThreadId !== previousThreadId) {
    applyRemoteSurfacePatch(createTranscriptScrollModePatch("follow-latest"));
  }
}

export function renderTranscriptPanel(session, approval, canWrite, previousSession = null) {
  const entries = session.transcript || [];
  const hydrationLoading =
    session.transcript_truncated
    && Boolean(state.transcriptHydrationBaseSnapshot)
    && state.transcriptHydrationThreadId === session.active_thread_id
    && state.transcriptHydrationStatus === "loading";

  if (!entries.length && !approval) {
    if (session.active_thread_id) {
      renderReadyTranscriptUi({
        canWrite,
        session,
      });
      return;
    }

    renderTranscriptEmptyUi();
    return;
  }

  const previousScrollTop = dom.remoteTranscript.scrollTop || 0;
  const previousScrollHeight = dom.remoteTranscript.scrollHeight || 0;
  const shouldAutoScroll = shouldStickTranscriptToBottom(
    dom.remoteTranscript,
    previousSession,
    session
  );
  const prependedOlderTranscript = didPrependOlderTranscript(
    previousSession?.transcript || [],
    entries
  );
  debugScrollEvent("renderTranscriptPanel:before", {
    thread: session.active_thread_id || "-",
    entries: entries.length,
    truncated: session.transcript_truncated ? "1" : "0",
    loading: hydrationLoading ? "1" : "0",
    auto: shouldAutoScroll ? "1" : "0",
    prepended: prependedOlderTranscript ? "1" : "0",
    prevTop: previousScrollTop,
    prevHeight: previousScrollHeight,
  });
  renderTranscriptMarkupUi({
    hydrationLoading,
    markup: renderTranscriptMarkup(entries, approval),
  });
  let nextScrollTop = previousScrollTop;
  if (shouldAutoScroll) {
    nextScrollTop = Math.max(
      0,
      (dom.remoteTranscript.scrollHeight || 0) - (dom.remoteTranscript.clientHeight || 0)
    );
    applyTranscriptScrollPosition(nextScrollTop, "stick-bottom");
    return;
  }

  if (prependedOlderTranscript) {
    if (previousScrollTop <= TOP_SCROLL_PRESERVE_THRESHOLD_PX) {
      applyTranscriptScrollPosition(0, "prepended-keep-top");
      return;
    }
    nextScrollTop = Math.max(
      0,
      dom.remoteTranscript.scrollHeight - previousScrollHeight + previousScrollTop
    );
    applyTranscriptScrollPosition(nextScrollTop, "prepended-anchor");
    return;
  }

  const maxScrollTop = Math.max(
    0,
    (dom.remoteTranscript.scrollHeight || 0) - (dom.remoteTranscript.clientHeight || 0)
  );
  nextScrollTop = Math.min(previousScrollTop, maxScrollTop);
  applyTranscriptScrollPosition(nextScrollTop, "preserve");
}

export function handleTranscriptScroll() {
  if (!state.session?.active_thread_id || !dom.remoteTranscript) {
    return;
  }

  const scrollHeight = dom.remoteTranscript.scrollHeight || 0;
  const clientHeight = dom.remoteTranscript.clientHeight || 0;
  const scrollTop = dom.remoteTranscript.scrollTop || 0;
  const isNearBottom =
    scrollHeight - clientHeight - scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
  applyRemoteSurfacePatch(
    createTranscriptScrollModePatch(isNearBottom ? "follow-latest" : "preserve")
  );
  debugScrollEvent("handleTranscriptScroll", {
    mode: state.transcriptScrollMode,
  });
}

function shouldStickTranscriptToBottom(transcript, previousSession, session) {
  if (state.transcriptScrollMode === "follow-latest") {
    return true;
  }
  if (!previousSession?.active_thread_id) {
    return true;
  }
  if (previousSession.active_thread_id !== session?.active_thread_id) {
    return true;
  }

  const scrollHeight = transcript.scrollHeight || 0;
  const clientHeight = transcript.clientHeight || 0;
  const scrollTop = transcript.scrollTop || 0;
  return scrollHeight - clientHeight - scrollTop <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
}

function didPrependOlderTranscript(previousEntries, nextEntries) {
  if (!previousEntries.length || nextEntries.length <= previousEntries.length) {
    return false;
  }

  const offset = nextEntries.length - previousEntries.length;
  return previousEntries.every((entry, index) => {
    return transcriptEntryIdentity(entry) === transcriptEntryIdentity(nextEntries[index + offset]);
  });
}

function transcriptEntryIdentity(entry) {
  return [
    entry?.item_id || "",
    entry?.kind || "",
    entry?.status || "",
    entry?.turn_id || "",
    entry?.tool?.item_type || "",
    entry?.tool?.name || "",
  ].join("|");
}

function applyTranscriptScrollPosition(scrollTop, reason) {
  const before = collectScrollMetrics();
  const operationId = ++transcriptScrollOperationId;
  const apply = () => {
    pendingTranscriptScrollFrame = null;
    if (!dom.remoteTranscript) {
      return;
    }
    dom.remoteTranscript.scrollTop = scrollTop;
    debugScrollEvent("applyTranscriptScrollPosition", {
      operationId,
      reason,
      targetTop: scrollTop,
      beforeTop: before.top,
      beforeHeight: before.height,
      beforeClient: before.client,
      afterTop: dom.remoteTranscript.scrollTop || 0,
      afterHeight: dom.remoteTranscript.scrollHeight || 0,
      afterClient: dom.remoteTranscript.clientHeight || 0,
    });
  };

  if (typeof window.requestAnimationFrame === "function") {
    if (pendingTranscriptScrollFrame != null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(pendingTranscriptScrollFrame);
    }
    pendingTranscriptScrollFrame = window.requestAnimationFrame(apply);
    debugScrollEvent("scheduleTranscriptScrollPosition", {
      operationId,
      reason,
      targetTop: scrollTop,
    });
    return;
  }

  apply();
}

function collectScrollMetrics() {
  return {
    top: dom.remoteTranscript?.scrollTop || 0,
    height: dom.remoteTranscript?.scrollHeight || 0,
    client: dom.remoteTranscript?.clientHeight || 0,
  };
}

export function debugScrollEvent(event, details = {}) {
  const transcript = collectScrollMetrics();
  const activeTag = document.activeElement?.tagName || "-";
  const activeId = document.activeElement?.id || "-";
  const windowY =
    typeof window.scrollY === "number"
      ? window.scrollY
      : typeof window.pageYOffset === "number"
        ? window.pageYOffset
        : 0;
  const detailText = Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const message = `[scroll] ${event} top=${transcript.top} height=${transcript.height} client=${transcript.client} winY=${windowY} active=${activeTag}#${activeId}${detailText ? ` ${detailText}` : ""}`;
  appendClientLog(message);
  console.log(message);
}

console.log(`[remote] loaded ${REMOTE_SCROLL_DEBUG_BANNER}`);
