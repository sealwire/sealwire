import React, { useLayoutEffect, useRef } from "react";

import { ConversationEmptyState } from "../shared/conversation.js";
import { TranscriptPane } from "../shared/transcript-pane.js";
import { attachTranscriptHistoryLoader } from "../shared/transcript-history-loader.js";
import { stableTranscriptOptions } from "../shared/transcript-options-identity.js";
import { useLocalTranscriptScrollBookkeeping } from "./use-local-transcript-scroll-bookkeeping.js";

const h = React.createElement;

// Owns the six branches render-session.js's renderTranscript used to pick
// imperatively, the transcript history loader's attach/sync/detach lifecycle,
// and (via the hook) the transcript scroll bookkeeping. See .sealwire/PLAN.md.
export function LocalTranscriptPanel({
  activeThreadId,
  activeThreadLabel,
  approval,
  buildTranscriptOptions,
  entries,
  entriesCanWrite,
  getStandbyEmptyContent,
  hydrationLoading,
  onLoadOlderTranscript,
  promotion,
  readyCopy,
  requestedSessionLabel,
  resetEpoch,
  scrollElement,
  session,
  shortId,
  standbyCanWrite,
  viewOnly,
  viewOnlyReviewView,
  viewedThreadLocked,
  viewedThreadWorkflowLocked,
  viewingConversation,
  viewingDifferentThread,
}) {
  const loaderRef = useRef(null);
  // Ref-latched so a changing onLoadOlderTranscript identity never forces the
  // attach effect (deps: [scrollElement]) to re-run and re-attach.
  const onLoadOlderTranscriptRef = useRef(onLoadOlderTranscript);
  onLoadOlderTranscriptRef.current = onLoadOlderTranscript;
  // Written only inside the entries branch below — building/caching
  // transcriptOptions must stay lazy, unlike RemoteTranscriptPanel's
  // unconditional build (see .sealwire/PLAN.md).
  const transcriptOptionsRef = useRef(null);

  // Effect 1 (attach): bound to scrollElement's lifetime, not the render
  // cycle — the sentinel it watches comes and goes with the branch below.
  useLayoutEffect(() => {
    if (!scrollElement) {
      return undefined;
    }
    const loader = attachTranscriptHistoryLoader({
      onLoad: () => onLoadOlderTranscriptRef.current?.(),
      scrollElement,
    });
    loaderRef.current = loader;
    return () => {
      loaderRef.current = null;
      loader.detach();
    };
  }, [scrollElement]);

  let content = null;

  if (!viewingConversation && viewedThreadLocked) {
    content = h(ConversationEmptyState, {
      badge: viewedThreadWorkflowLocked ? "Code Flow" : "Review",
      className: "thread-empty-ready",
      copy: viewedThreadWorkflowLocked
        ? "Code Flow owns this conversation. Its progress and result show up in the Reviewer panel."
        : "Another agent is reviewing this conversation. Its progress and result show up in the Reviewer panel, and the review is posted back here when it finishes.",
      title: viewedThreadWorkflowLocked ? "Code Flow in progress" : "Review in progress",
    });
  } else if (!viewingConversation && viewingDifferentThread) {
    content = h(ConversationEmptyState, {
      actions: [
        {
          attrs: { "data-go-console-home": "true" },
          label: "Back to console",
        },
      ],
      copy: "This saved session is loading.",
      details: [`Requested session: ${requestedSessionLabel}`],
      title: "Loading session",
    });
  } else if (!viewingConversation && activeThreadId) {
    content = h(ConversationEmptyState, {
      actions: [
        {
          attrs: { "data-open-thread-id": activeThreadId },
          label: "Open live conversation",
        },
      ],
      badge: "Live",
      className: "thread-empty-ready",
      copy: "A live session is running, but the conversation stays behind its own session page so the local home does not default into chat.",
      details: [`Current session: ${activeThreadLabel}`],
      title: "Relay console home",
    });
  } else if (!entries.length && viewOnly) {
    // A view-only thread whose transcript hasn't loaded yet — calm placeholder
    // instead of the live "send the first prompt" ready-state. The review flavor
    // keeps its reviewer-panel wording; a plain saved thread must not be mislabeled
    // "Review in progress".
    content = h(ConversationEmptyState, {
      badge: viewOnlyReviewView ? "Review" : "Read-only",
      className: "thread-empty-ready",
      copy: viewOnlyReviewView
        ? "Loading this session's conversation. Another agent is reviewing it — its progress shows in the Reviewer panel."
        : "Loading this saved session's conversation…",
      title: viewOnlyReviewView ? "Review in progress" : "Read-only view",
    });
  }

  // Branches 1-4 above never touch scroll bookkeeping; the two below are the
  // only ones the hook runs for (see mode below).
  const inScrollBranch = content === null;
  const emptyReady = inScrollBranch && !entries.length && !approval;

  if (content === null && emptyReady) {
    content = h(TranscriptPane, {
      canWrite: standbyCanWrite,
      emptyContent: activeThreadId ? null : getStandbyEmptyContent(),
      readyState: activeThreadId
        ? {
            readyCopy,
            session,
            shortId,
            waitingCopy: "This session is open, but another device currently has control. Take over to send the first prompt from here.",
          }
        : null,
    });
  } else if (content === null) {
    transcriptOptionsRef.current = stableTranscriptOptions(
      transcriptOptionsRef.current,
      buildTranscriptOptions({ activeThreadId, entries, session })
    );
    content = h(TranscriptPane, {
      approval,
      canWrite: entriesCanWrite,
      entries,
      hydrationLoading,
      transcriptOptions: transcriptOptionsRef.current,
    });
  }

  // Effect 2 (scroll): the hook owns both halves of the bookkeeping — its own
  // render-body capture plus a dep-less layout effect for the commit half.
  useLocalTranscriptScrollBookkeeping({
    activeThreadId,
    entries,
    mode: inScrollBranch ? (emptyReady ? "empty-ready" : "entries") : null,
    promotion,
    resetEpoch,
    scrollElement,
    session,
  });

  // Effect 3 (sync): re-attach to whichever sentinel is live. The entries
  // branch is the only one with a sentinel, and branches can swap on any
  // commit, so this also runs unconditionally, after every commit.
  useLayoutEffect(() => {
    loaderRef.current?.sync();
  });

  return content;
}
