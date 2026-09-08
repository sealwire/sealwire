import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { TranscriptPane } from "../shared/transcript-pane.js";
import { ConversationEmptyState } from "../shared/conversation.js";
import { MissingCredentialsState, RelayHomeState } from "./react-renderer.js";
import { stableTranscriptOptions } from "../shared/transcript-options-identity.js";
import { createTranscriptInteractionHandler } from "../shared/transcript-interactions.js";
import { attachTranscriptHistoryLoader } from "../shared/transcript-history-loader.js";
import { canForkInSession } from "../shared/fork-fields.js";
import { copyTextToClipboard } from "../shared/clipboard.js";
import { saveRelayNickname } from "./relay-nicknames.js";
import { maybeLoadOlderTranscriptHistory } from "./session-ops.js";
import { shortId } from "./utils.js";
import { useRemoteTranscriptScrollBookkeeping } from "./use-transcript-scroll-bookkeeping.js";
import { useRelayNicknames } from "./use-relay-nicknames.js";

const h = React.createElement;

export function RemoteTranscriptPanel({
  currentState,
  emptyStateModel,
  onApplyFileChange,
  onForkFromMessage,
  onSelectRelay,
  onToggleExpandableBlock,
  onSubmitDecision,
  onSubmitAskUserAnswers,
  onToggleTranscriptItem,
  onEnsureFileChangeDetail,
  pendingAskUserQuestions,
  session,
  sessionView,
  transcriptDetailEntries,
  askUserDetailErrors,
  askUserDetailLoadingRequestIds,
  uiState,
}) {
  const relayNicknames = useRelayNicknames();
  const transcriptRef = useRef(null);
  const transcriptOptionsRef = useRef(null);

  const approval = sessionView?.approval || null;
  const entries = session?.transcript || [];
  const hydrationLoading = Boolean(
    session?.transcript_truncated
      && currentState.transcriptHydrationBaseSnapshot
      && currentState.transcriptHydrationThreadId === session.active_thread_id
      && currentState.transcriptHydrationStatus === "loading"
  );

  // Hoisted via useCallback rather than defined inline below: an inline
  // arrow is a fresh function every render, which would fail
  // transcriptOptionValueEqual's Object.is check on this one field and
  // defeat stableTranscriptOptions no matter how stable everything else is.
  const handleSubmitAskUserAnswers = useCallback(
    (requestId, answers) => {
      void onSubmitAskUserAnswers?.(requestId, answers);
    },
    [onSubmitAskUserAnswers]
  );

  transcriptOptionsRef.current = stableTranscriptOptions(transcriptOptionsRef.current, {
    currentCwd: session?.current_cwd || "",
    detailEntries: transcriptDetailEntries,
    // sessionView is deliberately null for the no-session/relay-home/
    // server-disconnected empty states (see the `sessionView = session ?
    // ... : null` construction in react-app.js's RemoteApp) — this object is
    // built unconditionally on every render now, including those, so this
    // must be null-safe. See remote-transcript-panel-empty-states.test.mjs.
    enableFileChangeActions: Boolean(sessionView?.canWrite),
    expandedItemIds: uiState.transcriptExpandedItemIds,
    expandedKeys: uiState.transcriptExpandedItemIds,
    loadingItemIds: uiState.transcriptLoadingItemIds,
    // The per-message fork button is the ONLY fork entry that works on
    // iOS: thread-row contextmenu never fires for touch long-press.
    canFork: canForkInSession(session),
    // Stamps each agent message with the mark of whoever wrote it.
    provider: session?.provider || "",
    onEnsureFileChangeDetail,
    pendingAskUserQuestions,
    onSubmitAskUserAnswers: handleSubmitAskUserAnswers,
    askUserSubmittingRequestIds:
      uiState.askUserSubmittingRequestIds instanceof Set
        ? uiState.askUserSubmittingRequestIds
        : new Set(),
    askUserErrors: uiState.askUserErrors instanceof Map ? uiState.askUserErrors : new Map(),
    askUserDetailErrors: askUserDetailErrors instanceof Map ? askUserDetailErrors : new Map(),
    askUserDetailLoadingRequestIds:
      askUserDetailLoadingRequestIds instanceof Set
        ? askUserDetailLoadingRequestIds
        : new Set(),
    // The live card is docked beside the composer on this surface too, so here
    // an unanswered question renders as the record of the ask.
    askUserDocked: true,
  });
  const transcriptOptions = transcriptOptionsRef.current;

  useRemoteTranscriptScrollBookkeeping({
    currentState,
    entries,
    session,
    threadId: session?.active_thread_id || null,
    transcriptRef,
  });

  let body = null;

  if (emptyStateModel.showMissingCredentials) {
    body = h(MissingCredentialsState, {
      remoteAuth: emptyStateModel.remoteAuth,
    });
  } else if (!session?.active_thread_id) {
    if (emptyStateModel.showServerDisconnected) {
      body = h(ConversationEmptyState, {
        copy: emptyStateModel.serverDisconnectedCopy,
        title: "Server disconnected",
      });
    } else if (emptyStateModel.showRelayHome) {
      body = h(RelayHomeState, {
        clientAuth: emptyStateModel.clientAuth,
        nicknames: relayNicknames,
        onRenameRelay: saveRelayNickname,
        onSelectRelay,
        relayDirectory: emptyStateModel.relayDirectory,
      });
    } else {
      body = h(ConversationEmptyState, {
        copy: "After pairing, this page will stream the live relay transcript through the broker.",
        title: "No remote session yet",
      });
    }
  } else {
    body = h(TranscriptPane, {
      approval,
      canWrite: sessionView.canCompose,
      emptyContent: null,
      entries,
      hydrationLoading,
      readyState: {
        readyCopy: "The remote session is live. Send the first prompt below when you're ready.",
        session,
        shortId,
        waitingCopy: "This session is already open, but another device currently has control. You can still approve or decline requests here; take over only if you want to send messages from this device.",
      },
      transcriptOptions,
      // The same dispatcher the local surface uses. This chain had drifted from
      // that one in ways nobody chose: it alone handled a bare `data-expand-key`
      // summary, and it alone called preventDefault. Both are preserved here —
      // the drift is now visible as which keys this surface supplies.
      onTranscriptInteract: createTranscriptInteractionHandler({
        copyMessage: ({ text, element }, event) => {
          event.preventDefault();
          void copyTextToClipboard(text, element);
        },
        forkFromItem: ({ itemId }, event) => {
          event.preventDefault();
          onForkFromMessage?.(session?.active_thread_id || "", itemId);
        },
        fileChangeAction: ({ itemId, action }, event) => {
          event.preventDefault();
          if (itemId && (action === "rollback" || action === "reapply")) {
            void onApplyFileChange?.(itemId, action);
          }
        },
        approvalDecision: ({ decision, scope }) => onSubmitDecision(decision, scope),
        // A group header carries an expand key AND a toggle attribute; this
        // surface has always treated both as the same gesture.
        toggleGroup: ({ expandKey }, event) => {
          event.preventDefault();
          onToggleExpandableBlock?.(expandKey);
        },
        expandBlock: ({ expandKey }, event) => {
          event.preventDefault();
          onToggleExpandableBlock?.(expandKey);
        },
        toggleEntry: ({ itemId }) => void onToggleTranscriptItem?.(itemId),
      }),
    });
  }

  // IntersectionObserver-driven prefetch (mirrors app.js for the local
  // surface). The transcript scroll container is owned by this component, so
  // we can scope the loader's lifetime to the effect rather than the page.
  const historyLoaderRef = useRef(null);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) {
      return undefined;
    }
    const loader = attachTranscriptHistoryLoader({
      onLoad: () => maybeLoadOlderTranscriptHistory(),
      scrollElement: transcript,
    });
    historyLoaderRef.current = loader;
    loader.sync();
    return () => {
      historyLoaderRef.current = null;
      loader.detach();
    };
  }, []);

  // The sentinel can be replaced when the TranscriptContent branch swaps
  // (entries ↔ empty ↔ ready). Re-sync after every render so the observer
  // stays attached to whichever sentinel is currently live.
  useLayoutEffect(() => {
    historyLoaderRef.current?.sync();
  });

  return h(
    "div",
    {
      className: "chat-thread",
      id: "remote-transcript",
      ref: transcriptRef,
    },
    body
  );
}
