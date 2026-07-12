import {
  appShell,
  auditSummary,
  auditTimeline,
  chatShell,
  controlBanner,
  goConsoleHomeButton,
  goConsoleHomeSidebarButton,
  liveSurfacesList,
  liveSurfacesSummary,
  localModelBadge,
  messageForm,
  messageInput,
  openSessionDetailsButton,
  overviewSecurityBadges,
  pairingApprovalHint,
  pairingApprovalModal,
  pendingActionBanner,
  resumeLatestButton,
  sendButton,
  sessionHistoryDrawer,
  sessionMeta,
  sessionDetailsPath,
  composerSettingsMount,
  reviewIdleNudge,
  messageEffort,
  statusBadge,
  stopButton,
  threadsCount,
  threadsList,
  transcript,
  workspaceTitle,
  workspaceSubtitle,
  workspaceSuggestionsList,
} from "./dom.js";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  canonicalizeWorkspace,
  summarizeThreadGroups,
} from "../shared/thread-groups.js";
import { selectWorkspaceSuggestionsModel } from "../shared/workspace-suggestions.js";
import {
  readThreadListContextMenu,
  readThreadListUi,
} from "../shared/thread-list-store.js";
import {
  readLocalUiState,
} from "./ui-store.js";
import { providerLabel } from "../shared/provider-labels.js";
import { isProgressStalled } from "../progress-verbs.js";
import {
  earliestPairingExpiry,
  filterActivePairings,
  formatPendingPairingsBannerLabel,
  pairingNowSeconds,
} from "../shared/pairing-helpers.js";
import {
  buildExpandedTranscriptDetailEntries,
  collectFileChangeDetailItemIds,
} from "./transcript/details.js";
import { shouldShowTranscriptLoading } from "./transcript-loading.js";
import {
  ConversationEmptyState,
} from "../shared/conversation.js";
import { SessionSettingsButton } from "../shared/session-settings-panel.js";
import {
  ReviewLauncher,
} from "../shared/review-panel.js";
import {
  createReviewsCache,
  reviewCardsForViewedThread,
  reusableReviewersFromReviews,
} from "../shared/reviews-cache.js";
import {
  canRequestReview,
  isReviewBlocked,
  isReviewInProgressForThread,
  REVIEW_BLOCKED_BADGE,
  REVIEW_IN_PROGRESS_BADGE,
  reviewStatusLabel,
  selectReviewLaunchModel,
} from "../shared/review-state.js";
import { projectViewOnlySession } from "./view-only-thread.js";
import { canComposeThread, composerButtonState } from "../shared/thread-compose.js";
import { saveLastEffort } from "../shared/last-used-settings.js";
import {
  AuditList,
  ControlBannerContent,
  OverviewBadges,
  SessionMetaPanel,
  SurfaceCards,
  TextContent,
} from "./react-session-panels.js";
import { ThreadGroupList } from "../shared/thread-list-react.js";
import { buildThreadActivityMap } from "../shared/thread-activity.js";
import { sessionIsWorking, threadAttention } from "../shared/thread-attention.js";
import {
  configureThreadNotifications,
  ensureNotificationPermission,
  isDocumentForeground,
} from "../shared/thread-notify.js";
import { TranscriptPane } from "../shared/transcript-pane.js";
import {
  captureTranscriptScrollSnapshot,
  readTranscriptScrollPosition,
  rememberTranscriptScrollPosition,
  restoreTranscriptScrollPosition,
} from "../shared/transcript-scroll.js";

const h = React.createElement;
const reactRoots = new WeakMap();
let transcriptRoot = null;
let transcriptRootElement = null;
let attentionFocusListenerAttached = false;

function renderReactContent(element, content) {
  if (!element) {
    return;
  }

  let root = reactRoots.get(element);
  if (!root) {
    root = createRoot(element);
    reactRoots.set(element, root);
  }

  flushSync(() => {
    root.render(content);
  });
}

// Fires after every conversation render so the IntersectionObserver wiring
// in app.js can re-attach when the React tree swaps the transcript branch
// (entries ↔ empty ↔ ready). Set via `setTranscriptHistorySync` once at boot.
let transcriptHistorySync = null;

function renderConversationContent(content) {
  if (!transcript) {
    return;
  }

  if (transcriptRootElement !== transcript) {
    transcriptRoot?.unmount();
    transcriptRoot = createRoot(transcript);
    transcriptRootElement = transcript;
  }

  flushSync(() => {
    transcriptRoot.render(content);
  });

  if (typeof transcriptHistorySync === "function") {
    transcriptHistorySync();
  }
}

function setTranscriptHistorySync(handler) {
  transcriptHistorySync = typeof handler === "function" ? handler : null;
}

export function createSessionRenderer({
  state,
  renderAllowedRoots,
  renderPairingPanel,
  renderDeviceRecords,
  renderPendingPairingRequests,
  renderPairingApprovalModal,
  resolveActiveThread,
  setSelectedCwd,
  resumeSession,
  openThreadContextMenu,
  closeThreadContextMenu,
  scheduleControllerHeartbeat,
  scheduleControllerLeaseRefresh,
  cancelControllerHeartbeat,
  cancelControllerLeaseRefresh,
  logLine,
  ingestRelayLogs,
  escapeHtml,
  formatTimestamp,
  formatRelativeTime,
  humanizeLabel,
  shortId,
  workspaceBasename,
  canCurrentDeviceWrite,
  controllerLabel,
  controllerStateLabel,
  sessionControllerState,
  isCurrentDeviceActiveController,
  isViewingConversation,
  approvedDeviceCount,
  securityModeLabel,
  contentVisibilityLabel,
  brokerStatusLabel,
  pairedDeviceCountLabel,
  ensureConversationTranscript,
  syncComposerModel,
  updateSessionSettings,
  requestReview,
  setReviewSlice,
  fetchReviews,
  viewThread,
}) {
  // Cached reviewer-panel data from the dedicated (uncompacted) channel, keyed by the
  // snapshot's `reviews_revision`. See reviews-cache.js / renderReviewSlice.
  const reviewsCache = createReviewsCache();
  // Notifications navigate locally; looking at a thread never resumes it.
  configureThreadNotifications({
    resolveThreadName: (threadId) => {
      const thread = (state.threads || []).find((entry) => entry?.id === threadId);
      return thread ? thread.name || thread.preview || shortId(threadId) : null;
    },
    onActivateThread: (threadId) => {
      if (typeof viewThread === "function") {
        viewThread(threadId);
      }
    },
  });

  // When the tab regains focus, clear the dot on the thread the user is looking
  // at (the tracker only does this on the next snapshot, which may not arrive
  // for an idle thread). Attached once per page.
  if (!attentionFocusListenerAttached && typeof window !== "undefined") {
    attentionFocusListenerAttached = true;
    const clearViewedDot = () => {
      threadAttention.clearViewedOnFocus(isDocumentForeground());
      renderThreads();
    };
    window.addEventListener("focus", clearViewedDot);
    document.addEventListener("visibilitychange", clearViewedDot);
  }

  function reviewChips(session) {
    // The session-details panel describes the active thread, so only surface its
    // OWN review(s) — not reviews running on (or lingering for) other threads.
    const activeThreadId = session?.active_thread_id || null;
    return (session?.active_review_jobs || [])
      .filter((job) => job.parent_thread_id === activeThreadId)
      .map((job) => metaChip("Review", reviewStatusLabel(job.status)));
  }

  function reviewLaunchModel(session) {
    return selectReviewLaunchModel({
      providers: state.providers || [],
      providerModels: state.providerModels || {},
      session,
    });
  }

  function renderSession(session) {
    state.session = session;
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("agent-relay:session-updated"));
    }
    // From here down, render the (possibly read-only) projection — never `state.session`
    // directly — so ANY non-active thread the user is viewing shows its own
    // conversation read-only instead of the console home. `state.session` stays the
    // REAL session so heartbeat / lease / controller / nav keep using it.
    session = projectViewOnlySession(session, {
      viewThreadId: state.viewThreadId,
      viewOnlyThread: state.viewOnlyThread,
    });
    syncComposerModel?.(session);

    const approval = session.pending_approvals[0] || null;
    const pendingPairings = filterActivePairings(session.pending_pairing_requests || []);
    const activeThread = resolveActiveThread(session.active_thread_id);
    const hasActiveSession = Boolean(session.active_thread_id);
    const viewingConversation = isViewingConversation(session);
    const canWrite = canCurrentDeviceWrite(session);
    const turnRunning = Boolean(session.active_turn_id);
    const threadWorking = sessionIsWorking(session);
    const reviewBlocked = isReviewBlocked(session);
    // The composer is frozen ONLY when the thread you're looking at is itself
    // being reviewed. A review running in the background on another thread leaves
    // the active conversation fully usable.
    const activeThreadFrozen = isReviewInProgressForThread(session, session.active_thread_id);
    // In a read-only view, the workspace is the saved thread's own cwd (or blank
    // when unknown) — never the user's currently-selected cwd, which would
    // misrepresent the saved thread.
    const workspace = session.view_only
      ? session.current_cwd || ""
      : session.current_cwd || state.selectedCwd || "";
    const workspaceName = workspace ? workspaceBasename(workspace) : "";
    const viewingSessionDetails = Boolean(sessionMeta?.closest("dialog")?.open);
    const viewingSecurityDetails = Boolean(
      document.querySelector("#security-modal")?.open
    );
    const threadListUi = readThreadListUi(state.threadListStore);
    state.currentApprovalId = approval?.request_id || null;

    workspaceTitle.textContent = workspaceName || "Relay console";
    if (session.view_only && session.active_thread_id) {
      const threadLabel =
        activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
      workspaceSubtitle.textContent = state.viewOnlyThread?.review
        ? `read-only · review in progress · ${threadLabel}`
        : `read-only · saved thread · ${threadLabel}`;
    } else if (viewingConversation && session.active_thread_id) {
      const threadLabel =
        activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
      workspaceSubtitle.textContent = `live · ${threadLabel}`;
    } else if (session.active_thread_id) {
      const threadLabel =
        activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
      workspaceSubtitle.textContent = `live thread · ${threadLabel}`;
    } else if (workspace) {
      workspaceSubtitle.textContent = "standby";
    } else {
      workspaceSubtitle.textContent = "no workspace selected";
    }

    if (chatShell) {
      chatShell.dataset.view = viewingConversation ? "conversation" : "console";
    }
    if (appShell) {
      appShell.dataset.view = viewingConversation ? "conversation" : "console";
    }
    if (sessionHistoryDrawer) {
      sessionHistoryDrawer.open = viewingConversation || Boolean(threadListUi.drawerOpen);
    }

    syncThreadHistoryScroll();

    if (approval) {
      statusBadge.textContent = "Approval required";
      statusBadge.className = "status-badge status-badge-alert";
    } else if (pendingPairings.length > 0) {
      statusBadge.textContent =
        pendingPairings.length === 1
          ? "Pairing request"
          : `${pendingPairings.length} pairing requests`;
      statusBadge.className = "status-badge status-badge-alert";
    } else if (!session.provider_connected) {
      statusBadge.textContent = "Offline";
      statusBadge.className = "status-badge status-badge-offline";
    } else if (reviewBlocked) {
      // A blocked review locks the workspace until the user stops the reviewer —
      // surface it globally (not just inside the Reviewer tab) so it can't be missed.
      // Shared constant → identical wording/tone to the remote surface.
      statusBadge.textContent = REVIEW_BLOCKED_BADGE.label;
      statusBadge.className = `status-badge status-badge-${REVIEW_BLOCKED_BADGE.tone}`;
    } else if (isProgressStalled(session)) {
      statusBadge.textContent = "Stalled?";
      statusBadge.className = "status-badge status-badge-alert";
    } else if (activeThreadFrozen) {
      // Only badge the thread you're viewing as under review; a background review
      // on another thread leaves this conversation live.
      statusBadge.textContent = REVIEW_IN_PROGRESS_BADGE.label;
      statusBadge.className = `status-badge status-badge-${REVIEW_IN_PROGRESS_BADGE.tone}`;
    } else {
      statusBadge.textContent = sessionStatusLabel(session, approval);
      statusBadge.className = "status-badge status-badge-ready";
    }
    renderHeaderModelBadge(session);

    if (!viewingConversation) {
      renderOverviewState(session);
      renderLiveSurfaces(session, activeThread);
      renderAuditTimeline(session.logs || []);
    }
    if (!viewingConversation || viewingSessionDetails) {
      renderSessionMeta(session);
    }
    if (!viewingConversation || viewingSecurityDetails) {
      renderAllowedRoots(session.allowed_roots || [], {
        draftDirty: readLocalUiState(state.localUiStore).allowedRootsDraftDirty,
      });
      renderPairingPanel(state.currentPairing);
      renderDeviceRecords(session.device_records || []);
      renderPendingPairingRequests(pendingPairings);
    }
    renderPairingApprovalModal(pendingPairings);
    announceNewPendingPairings(pendingPairings);
    syncPairingApprovalDialog(pendingPairings);
    schedulePairingExpiryTick(pendingPairings);
    renderControlBanner(session);
    renderSessionSettingsPanel(session);
    renderReviewSlice(session);
    renderReviewIdleNudge(session);
    renderPendingActionBanner(approval, pendingPairings, session);
    renderWorkspaceSuggestions(session);
    renderTranscript(session, approval);
    renderLogs(session.logs);
    syncThreadSelection();
    syncThreadHistoryScroll();
    restoreThreadHistoryScroll();
    if (
      viewingConversation &&
      session.active_thread_id &&
      session.transcript_truncated &&
      // A read-only projection paginates through its own pin (app.js
      // loadOlderViewOnlyTranscript). Feeding the projection into the shared
      // hydration pipeline would re-key the hydration store — which belongs to
      // the LIVE thread — to the viewed thread and clobber it.
      !session.view_only
    ) {
      ensureConversationTranscript?.(session);
    }
    // Heartbeat/lease must track the REAL session, not the read-only projection.
    // The projection's controller is the "__view_only__" sentinel, so passing it
    // here would cancel the controller heartbeat and let the real lease expire
    // (15s) while you merely browse a saved thread — handing control to another
    // device. state.session is the real session (set at the top of renderSession).
    scheduleControllerHeartbeat(state.session);
    scheduleControllerLeaseRefresh(state.session);

    openSessionDetailsButton.disabled = false;
    if (goConsoleHomeButton) {
      goConsoleHomeButton.hidden = !viewingConversation;
    }
    if (goConsoleHomeSidebarButton) {
      goConsoleHomeSidebarButton.hidden = !viewingConversation;
    }
    messageForm.hidden = !viewingConversation;
    // An idle thread is open to either local or remote. The targeted send is the
    // atomic claim; only an already-running turn remains controller-gated.
    const canCompose = canComposeThread({
      activeTurnId: session.active_turn_id,
      hasActiveSession,
      hasControllerLease: canWrite,
      reviewLocked: activeThreadFrozen || Boolean(state.viewOnlyThread?.review),
    });
    // Frozen while a submit is in flight (app.js runComposerSubmit) so a
    // draft edit or second submit can't change or duplicate the in-flight send.
    const submitInFlight = Boolean(state.composerSubmitInFlight);
    const composerReady = hasActiveSession && canCompose && viewingConversation;
    // Send and Stop are mutually exclusive: a running turn shows Stop, never Send
    // (no pending-message queue yet). The view-only observer of a background turn
    // gets Stop too, so Send must hide for them — not only for the controller.
    const buttons = composerButtonState({
      composerReady,
      turnRunning,
      threadWorking,
      activeThreadFrozen,
      canWrite,
      viewOnly: session.view_only,
      submitInFlight,
    });
    sendButton.disabled = buttons.sendDisabled;
    sendButton.hidden = buttons.sendHidden;
    if (stopButton) {
      stopButton.hidden = buttons.stopHidden;
      stopButton.disabled = buttons.stopDisabled;
    }
    messageInput.disabled =
      !hasActiveSession ||
      !canCompose ||
      !viewingConversation ||
      activeThreadFrozen ||
      submitInFlight;
    messageInput.placeholder = activeThreadFrozen
      ? "This thread is being reviewed…"
      : !hasActiveSession
      ? "Start or open a session first."
      : !viewingConversation
        ? "Open the thread page to send a message."
        : canCompose
          // Name the active thread's own provider — never a hardcoded "Codex".
          ? (providerLabel(session?.provider)
            ? `Message ${providerLabel(session.provider)}...`
            : "Message...")
          : "This thread is currently running on another device.";
  }

  function renderSessionUnavailable(message) {
    renderOverviewState(null, message);
    renderWorkspaceSuggestions(null);
    renderHeaderModelBadge(null);
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-badge-offline";
    if (sessionDetailsPath) {
      sessionDetailsPath.textContent = "No workspace path yet.";
    }
    renderReactContent(
      sessionMeta,
      h(SessionMetaPanel, { emptyMessage: message })
    );
    renderConversationContent(
      h(ConversationEmptyState, {
        copy: message,
        title: "Relay unavailable",
      })
    );
  }

  function renderAuthRequiredState(message) {
    state.session = null;
    state.threads = [];
    state.threadGroups = [];
    cancelControllerHeartbeat();
    cancelControllerLeaseRefresh();
    // Clear the independently-mounted Reviewer tab so it does not retain job
    // metadata or already-fetched review text after the user signs out.
    if (typeof setReviewSlice === "function") {
      setReviewSlice({ reviewJobs: [], reviewModel: {}, canRequest: false, blocked: false });
    }
    openSessionDetailsButton.disabled = true;
    renderOverviewState(null, message);
    renderWorkspaceSuggestions(null);
    renderThreadListMessage("Sign in", "Enter RELAY_API_TOKEN to load threads.");
    renderHeaderModelBadge(null);
    statusBadge.textContent = "Sign in";
    statusBadge.className = "status-badge status-badge-offline";
    if (sessionDetailsPath) {
      sessionDetailsPath.textContent = "No workspace path yet.";
    }
    renderReactContent(
      sessionMeta,
      h(SessionMetaPanel, { emptyMessage: message })
    );
    renderConversationContent(
      h(ConversationEmptyState, {
        copy: message,
        title: "Authentication required",
      })
    );
  }

  let pairingExpiryTimer = null;
  let pairingHintTimer = null;
  function schedulePairingExpiryTick(requests) {
    if (pairingExpiryTimer) {
      clearTimeout(pairingExpiryTimer);
      pairingExpiryTimer = null;
    }
    if (!requests.length) {
      return;
    }
    const earliest = earliestPairingExpiry(requests);
    if (earliest === null) {
      return;
    }
    // +250ms buffer so the request is past its deadline when we re-render.
    const delay = Math.max(50, (earliest - pairingNowSeconds()) * 1000 + 250);
    pairingExpiryTimer = setTimeout(() => {
      pairingExpiryTimer = null;
      if (state.session) {
        renderSession(state.session);
      }
    }, delay);
  }

  function updatePairingHint(requests) {
    if (!pairingApprovalHint) {
      return;
    }
    const earliest = earliestPairingExpiry(requests);
    const remaining = earliest !== null ? Math.max(0, earliest - pairingNowSeconds()) : null;
    pairingApprovalHint.textContent = remaining !== null
      ? `A remote device is requesting access. ${remaining}s remaining before this request expires.`
      : "A remote device is requesting access.";
  }

  function syncPairingApprovalDialog(requests) {
    if (!pairingApprovalModal) {
      return;
    }
    if (pairingHintTimer) {
      clearInterval(pairingHintTimer);
      pairingHintTimer = null;
    }
    if (requests.length === 0) {
      if (pairingApprovalModal.open) {
        pairingApprovalModal.close();
      }
      return;
    }
    updatePairingHint(requests);
    if (pairingApprovalModal.open) {
      pairingHintTimer = setInterval(() => updatePairingHint(requests), 1000);
    }
  }

  function announceNewPendingPairings(requests) {
    const pendingIds = requests.map((request) => request.pairing_id);
    const localUi = readLocalUiState(state.localUiStore);
    const newRequests = requests.filter(
      (request) => !localUi.pendingPairingIds.includes(request.pairing_id)
    );
    state.localUiStore.getState().setPendingPairingIds(pendingIds);

    if (!newRequests.length) {
      return;
    }

    const labels = newRequests.map((request) => request.label || shortId(request.device_id));
    const summary = labels.length === 1 ? labels[0] : `${labels.length} devices`;
    logLine(`Local pairing approval required for ${summary}.`);

    if (pairingApprovalModal && !pairingApprovalModal.open) {
      try {
        pairingApprovalModal.showModal();
      } catch (error) {
        logLine(`Unable to surface pairing approval modal: ${error.message}`);
      }
    }
  }

  function renderHeaderModelBadge(session) {
    if (!localModelBadge) {
      return;
    }

    // Model is session-scoped — only relevant while actually viewing a conversation.
    // On the console/home view, the model badge is noise (session state leaking into
    // the monitor surface). Session details modal still surfaces it on demand.
    const inConversationView = chatShell?.dataset.view === "conversation";
    const shouldShow = Boolean(inConversationView && session?.active_thread_id && session.model);
    const provider = providerLabel(session?.provider);
    const modelLabel = provider ? `${provider} · ${session.model}` : session?.model || "";
    localModelBadge.hidden = !shouldShow;
    localModelBadge.textContent = shouldShow ? modelLabel : "";
    localModelBadge.title = shouldShow
      ? session.reasoning_effort
        ? `${modelLabel} · effort ${session.reasoning_effort}`
        : modelLabel
      : "";
  }

  function renderLiveSurfaces(session, activeThread) {
    if (!liveSurfacesList || !liveSurfacesSummary) {
      return;
    }

    const records = Array.isArray(session?.device_records) ? session.device_records : [];
    const visibleRecords = records.filter((record) => record.lifecycle_state !== "revoked");
    const revokedCount = records.length - visibleRecords.length;
    const surfaces = [
      buildLocalSurface(session, activeThread),
      ...visibleRecords.map((record) => buildDeviceSurface(session, activeThread, record)),
    ];

    const approvedCount = approvedDeviceCount(session);
    const pendingCount = session?.pending_pairing_requests?.length || 0;

    const deviceCount = surfaces.length;
    const parts = [`${deviceCount} device${deviceCount === 1 ? "" : "s"}`];
    if (approvedCount > 0) parts.push(`${approvedCount} trusted`);
    if (pendingCount > 0) parts.push(`${pendingCount} pending`);
    if (revokedCount > 0) parts.push(`${revokedCount} revoked`);

    renderReactContent(
      liveSurfacesSummary,
      h(TextContent, null, parts.join(" · "))
    );

    renderReactContent(liveSurfacesList, h(SurfaceCards, { surfaces }));
  }

  function buildLocalSurface(session, activeThread) {
    const controllerState = sessionControllerState(session);
    const hasControl = controllerState === "this_device";
    const canClaim = Boolean(session?.active_thread_id) && controllerState === "unclaimed";
    const status = hasControl ? "Controller" : canClaim ? "Open" : "Local";
    const badgeClass = hasControl
      ? "device-state-approved"
      : canClaim
        ? "device-state-pending"
        : "device-state-approved";

    return {
      key: "local-browser",
      title: "This browser",
      copy: "",
      badgeLabel: status,
      badgeClass,
      chips: [
        { label: "Role", value: hasControl ? "Typing + approvals" : "Local console" },
        {
          label: "Workspace",
          value: session?.current_cwd
            ? workspaceBasename(session.current_cwd)
            : state.selectedCwd
              ? workspaceBasename(state.selectedCwd)
              : "Unset",
        },
      ],
    };
  }

  function buildDeviceSurface(session, activeThread, record) {
    const isController = session?.active_controller_device_id === record.device_id;
    const lifecycle = record.lifecycle_state || "approved";
    const badgeLabel = isController ? "Controller" : humanizeLabel(lifecycle);
    const badgeClass = isController
      ? "device-state-approved"
      : lifecycle === "pending"
        ? "device-state-pending"
        : lifecycle === "rejected" || lifecycle === "revoked"
          ? "device-state-rejected"
          : "device-state-approved";

    return {
      key: `device:${record.device_id}`,
      title: record.label,
      copy: "",
      badgeLabel,
      badgeClass,
      chips: [
        { label: "Device", value: shortId(record.device_id) },
        { label: "Seen", value: record.last_seen_at ? formatTimestamp(record.last_seen_at) : "Never" },
        { label: "Peer", value: record.last_peer_id ? shortId(record.last_peer_id) : "None" },
      ],
    };
  }

  function renderAuditTimeline(entries) {
    if (!auditTimeline || !auditSummary) {
      return;
    }

    if (!entries.length) {
      renderReactContent(auditSummary, h(TextContent, null, ""));
      renderReactContent(auditTimeline, h(AuditList));
      return;
    }

    const filteredEntries = entries.filter((entry) => shouldShowAuditEntry(entry));
    const visibleEntries = filteredEntries.slice(0, 8);
    const hiddenDebugCount = entries.length - filteredEntries.length;
    const significantCount = visibleEntries.filter(
      (entry) => classifyAuditEntry(entry) !== "neutral"
    ).length;
    const summaryParts = [`${visibleEntries.length} events`];
    if (significantCount > 0) summaryParts.push(`${significantCount} notable`);
    if (hiddenDebugCount > 0) summaryParts.push(`${hiddenDebugCount} hidden`);
    renderReactContent(
      auditSummary,
      h(TextContent, null, summaryParts.join(" · "))
    );

    if (!visibleEntries.length) {
      renderReactContent(
        auditTimeline,
        h(AuditList, { emptyMessage: "No relay-level audit events yet." })
      );
      return;
    }

    renderReactContent(
      auditTimeline,
      h(AuditList, {
        entries: visibleEntries.map((entry, index) => ({
          key: `${entry.created_at || index}:${entry.kind || "relay"}:${entry.message || ""}`,
          kind: humanizeLabel(entry.kind || "relay"),
          message: entry.message || "",
          time: formatTimestamp(entry.created_at),
          tone: classifyAuditEntry(entry),
        })),
      })
    );
  }

  function renderSessionMeta(session) {
    if (sessionDetailsPath) {
      sessionDetailsPath.textContent = session.current_cwd || "No workspace path yet.";
    }

    const securityChips = [
      metaChip("Access", securityModeLabel(session)),
      metaChip("Sharing", contentVisibilityLabel(session)),
      metaChip("Remote", brokerStatusLabel(session)),
      metaChip("Devices", pairedDeviceCountLabel(session)),
      metaChip(
        "Workspace access",
        session.allowed_roots?.length
          ? `${session.allowed_roots.length} configured`
          : "Unrestricted"
      ),
    ];

    if (!session.active_thread_id) {
      renderReactContent(
        sessionMeta,
        h(SessionMetaPanel, {
          chips: securityChips,
          emptyMessage: "Session details will appear here.",
        })
      );
      return;
    }

    renderReactContent(
      sessionMeta,
      h(SessionMetaPanel, {
        chips: [
          ...securityChips,
          metaChip("Provider", providerLabel(session.provider) || "Unknown"),
          metaChip("Model", session.model),
          metaChip("Permissions", session.approval_policy),
          metaChip("Effort", session.reasoning_effort),
          metaChip("Control", controllerStateLabel(session)),
          metaChip("Thread", shortId(session.active_thread_id)),
          ...reviewChips(session),
        ],
      })
    );
  }

  function renderOverviewState(session, errorMessage = null) {
    const pendingPairings = session?.pending_pairing_requests?.length || 0;

    if (errorMessage) {
      renderReactContent(
        overviewSecurityBadges,
        h(OverviewBadges, { badges: [overviewBadge("Status", "Offline")] })
      );
      return;
    }

    // Trust posture only — Access + Sharing + Remote. Device count lives in the Devices hero;
    // Provider/Model/Control are session-scoped (surfaced in the chat header or transcript).
    const securityBadges = [
      ...(pendingPairings > 0 ? [overviewBadge("Pending", String(pendingPairings))] : []),
      overviewBadge("Access", securityModeLabel(session)),
      overviewBadge("Sharing", contentVisibilityLabel(session)),
      overviewBadge("Remote", brokerStatusLabel(session)),
    ];

    renderReactContent(overviewSecurityBadges, h(OverviewBadges, { badges: securityBadges }));
  }

  function renderSessionSettingsPanel(session) {
    if (!composerSettingsMount) {
      return;
    }
    if (!session?.active_thread_id || !isViewingConversation(session)) {
      renderReactContent(composerSettingsMount, null);
      return;
    }
    // The review trigger/progress/resolve now live in the right-panel Reviewer
    // tab (co-located with the diff). The composer keeps only the settings gear.
    renderReactContent(
      composerSettingsMount,
      h(SessionSettingsButton, {
        session,
        composerEffort: messageEffort?.value || session.reasoning_effort || "",
        onUpdate: (payload) => updateSessionSettings?.(payload),
        onChangeEffort: (value) => {
          if (messageEffort) messageEffort.value = value;
          if (session.provider) saveLastEffort(session.provider, value);
          updateSessionSettings?.({ effort: value });
        },
      })
    );
  }

  // Push the review slice onto the shared workspace-diff store so the Reviewer
  // tab (rail + mobile sheet) can render jobs, the launcher model, and gating.
  function renderReviewSlice(session) {
    if (typeof setReviewSlice !== "function") {
      return;
    }
    // The Reviewer panel belongs to the thread you're looking at: a review (and its
    // lingering terminal error) must only show on its own parent thread, never bleed
    // into every other thread's panel. Scope the DISPLAY to the viewed thread; the
    // session's global active_review_jobs stays authoritative for navigation/locking.
    const viewedThreadId = state.viewThreadId || session?.active_thread_id || null;

    // Refresh the dedicated (uncompacted) reviews channel only when the snapshot's
    // reviews_revision changes; re-render the slice when fresh data lands. This keeps the
    // panel populated during live turns, which drain the snapshot's `active_review_jobs`.
    if (typeof fetchReviews === "function") {
      void reviewsCache.sync(
        session?.reviews_revision,
        () => fetchReviews(),
        () => renderReviewSlice(state.session || session)
      );
    }
    // Cards + reviewer threads come from the cache (the uncompacted channel) once it's
    // loaded; until then fall back to the snapshot so the first paint isn't empty.
    const reviewsData = reviewsCache.hasData()
      ? reviewsCache.current()
      : {
          review_jobs: session?.active_review_jobs || [],
          reviewer_threads: session?.reviewer_threads || [],
        };
    const threadReviewJobs = reviewCardsForViewedThread(reviewsData, viewedThreadId);
    setReviewSlice({
      reviewJobs: threadReviewJobs,
      reviewModel: reviewLaunchModel(session),
      // Existing reviewer threads of the VIEWED thread (same scope as the review job
      // cards above), offered for reuse. Provider filtering happens in the panel (it
      // reacts to the chosen provider).
      reusableReviewers: reusableReviewersFromReviews(reviewsData, viewedThreadId, null),
      // Full reviewer-thread list so each card can show its reviewer thread's
      // (long, truncated-with-tooltip) name by joining on reviewer_thread_id.
      reviewerThreads: reviewsData.reviewer_threads || [],
      // The thread the panel is showing: sent as the review's parent so a review
      // targets the VIEWED thread, not the relay's active thread.
      parentThreadId: viewedThreadId,
      // Liveness/lock gating still reads the snapshot's `active_review_jobs` (the small
      // non-terminal set kept for synchronous gating).
      canRequest:
        typeof requestReview === "function" &&
        canRequestReview(session, state.deviceId, viewedThreadId),
      blocked: isReviewBlocked({
        active_review_jobs: (session?.active_review_jobs || []).filter(
          (job) => job.parent_thread_id === viewedThreadId
        ),
      }),
    });
  }

  // A lightweight idle prompt in the conversation footer: only when this device
  // can start a review (idle + controller). Points users at the relocated
  // feature without re-cluttering the composer. Its own modal id keeps it from
  // colliding with the rail/sheet launchers.
  function renderReviewIdleNudge(session) {
    if (!reviewIdleNudge) {
      return;
    }
    const show =
      typeof requestReview === "function" &&
      isViewingConversation(session) &&
      canRequestReview(
        session,
        state.deviceId,
        state.viewThreadId || session?.active_thread_id || null
      );
    reviewIdleNudge.hidden = !show;
    if (!show) {
      renderReactContent(reviewIdleNudge, null);
      return;
    }
    const reviewModel = reviewLaunchModel(session);
    renderReactContent(
      reviewIdleNudge,
      h(
        "div",
        { className: "review-idle-nudge-inner" },
        h("span", { className: "review-idle-nudge-copy" }, "Want a second opinion on these changes?"),
        h(ReviewLauncher, {
          panelId: "review-panel-nudge",
          label: "Request reviewer",
          providerOptions: reviewModel.providerOptions,
          models: reviewModel.models,
          defaultProvider: reviewModel.defaultProvider,
          // Source the reuse list from the dedicated reviews cache (same as the panel) so it
          // survives live-turn compaction; fall back to the snapshot until the cache loads.
          reusableReviewers: reusableReviewersFromReviews(
            reviewsCache.hasData()
              ? reviewsCache.current()
              : { reviewer_threads: session?.reviewer_threads || [] },
            state.viewThreadId || session?.active_thread_id || null,
            null
          ),
          parentThreadId: state.viewThreadId || session?.active_thread_id || null,
          disabled: false,
          onSubmit: (values) => requestReview(values),
        })
      )
    );
  }

  function renderControlBanner(session) {
    const activeUnderReview = isReviewInProgressForThread(session, session.active_thread_id);
    const sessionWorking = sessionIsWorking(session);
    if (session.view_only && sessionWorking && !activeUnderReview) {
      controlBanner.hidden = false;
      renderReactContent(
        controlBanner,
        h(ControlBannerContent, {
          hint: "This background thread is still running. Stop it or take over to continue here.",
          showTakeOver: true,
          summary: "Background thread is running",
        })
      );
      return;
    }
    if (
      !session.active_thread_id
      || !isViewingConversation(session)
      || !session.active_controller_device_id
      || isCurrentDeviceActiveController(session)
      || (!sessionWorking && !activeUnderReview)
    ) {
      controlBanner.hidden = true;
      return;
    }

    controlBanner.hidden = false;
    // Only the thread actually being reviewed is off-limits for take-over; a
    // background review elsewhere doesn't lock this thread's controls.
    renderReactContent(
      controlBanner,
      h(ControlBannerContent, {
        hint: activeUnderReview
          ? "This thread is being reviewed; it unlocks when the review finishes."
          : "You can still approve from this device. Take over when you want to type or continue the session.",
        // The review owns the reviewed thread's turn sequence — don't let a
        // take-over reassign its controller mid-review.
        showTakeOver: !activeUnderReview,
        summary: `Another device has control (${controllerLabel(session.active_controller_device_id)})`,
      })
    );
  }

  function renderPendingActionBanner(approval, pendingPairings, session = null) {
    if (!pendingActionBanner) {
      return;
    }

    if (approval) {
      pendingActionBanner.hidden = false;
      renderReactContent(
        pendingActionBanner,
        h(
          "div",
          { className: "pending-action-banner-inner pending-action-banner-approval" },
          h("span", { className: "pending-action-banner-text" }, approval.summary || "Approval required"),
          h(
            "div",
            { className: "pending-action-banner-actions" },
            h(
              "button",
              {
                className: "pending-action-btn pending-action-btn-primary",
                "data-approval-decision": "approve",
                "data-approval-scope": "once",
                type: "button",
              },
              "Approve"
            ),
            h(
              "button",
              {
                className: "pending-action-btn pending-action-btn-danger",
                "data-approval-decision": "deny",
                "data-approval-scope": "once",
                type: "button",
              },
              "Deny"
            )
          )
        )
      );
      return;
    }

    if (pendingPairings.length > 0) {
      const label = formatPendingPairingsBannerLabel(pendingPairings, shortId);
      pendingActionBanner.hidden = false;
      renderReactContent(
        pendingActionBanner,
        h(
          "div",
          { className: "pending-action-banner-inner pending-action-banner-pairing" },
          h("span", { className: "pending-action-banner-text" }, label),
          h(
            "button",
            {
              className: "pending-action-btn",
              "data-open-pairing-approval": "true",
              type: "button",
            },
            "Review"
          )
        )
      );
      return;
    }

    pendingActionBanner.hidden = true;
  }

  function renderTranscript(session, approval) {
    const viewingConversation = isViewingConversation(session);
    const entries = session.transcript || [];
    const localUi = readLocalUiState(state.localUiStore);
    const transcriptDetailEntries = buildExpandedTranscriptDetailEntries(state, {
      expandedItemIds: localUi.transcriptExpandedItemIds,
      threadId: session?.active_thread_id || null,
      autoDetailItemIds: collectFileChangeDetailItemIds(entries),
    });

    if (!viewingConversation) {
      const activeThread = resolveActiveThread(session.active_thread_id);
      const requestedThread =
        resolveActiveThread(state.viewThreadId) ||
        state.threads.find((thread) => thread.id === state.viewThreadId);

      // A review briefly hands the active thread to the (hidden) reviewer. If the
      // user is sitting on the thread being reviewed, keep the page calm instead
      // of flashing the "attached to a different session" message — the reviewer
      // lives in the Reviewer panel and the review posts back here when it's done.
      if (isReviewInProgressForThread(session, state.viewThreadId)) {
        renderConversationContent(
          h(ConversationEmptyState, {
            badge: "Review",
            className: "thread-empty-ready",
            copy: "Another agent is reviewing this conversation. Its progress and result show up in the Reviewer panel, and the review is posted back here when it finishes.",
            title: "Review in progress",
          })
        );
        return;
      }

      if (state.viewThreadId && state.viewThreadId !== session.active_thread_id) {
        renderConversationContent(
          h(ConversationEmptyState, {
            actions: [
              {
                attrs: { "data-go-console-home": "true" },
                label: "Back to console",
              },
            ],
            copy: "This saved thread is loading.",
            details: [
              `Requested thread: ${
                requestedThread
                  ? requestedThread.name || requestedThread.preview || shortId(requestedThread.id)
                  : shortId(state.viewThreadId)
              }`,
            ],
            title: "Loading thread",
          })
        );
        return;
      }

      if (session.active_thread_id) {
        const threadLabel =
          activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
        renderConversationContent(
          h(ConversationEmptyState, {
            actions: [
              {
                attrs: { "data-open-thread-id": session.active_thread_id },
                label: "Open live conversation",
              },
            ],
            badge: "Live",
            className: "thread-empty-ready",
            copy: "A live session is running, but the conversation stays behind its own thread page so the local home does not default into chat.",
            details: [`Current thread: ${threadLabel}`],
            title: "Relay console home",
          })
        );
        return;
      }
    }

    // A view-only thread whose transcript hasn't loaded yet — calm placeholder
    // instead of the live "send the first prompt" ready-state. The review flavor
    // keeps its reviewer-panel wording; a plain saved thread must not be mislabeled
    // "Review in progress".
    if (!entries.length && session.view_only) {
      const reviewView = Boolean(state.viewOnlyThread?.review);
      renderConversationContent(
        h(ConversationEmptyState, {
          badge: reviewView ? "Review" : "Read-only",
          className: "thread-empty-ready",
          copy: reviewView
            ? "Loading this thread's conversation. Another agent is reviewing it — its progress shows in the Reviewer panel."
            : "Loading this saved thread's conversation…",
          title: reviewView ? "Review in progress" : "Read-only view",
        })
      );
      return;
    }

    if (!entries.length && !approval) {
      renderConversationContent(
        h(TranscriptPane, {
          canWrite: canCurrentDeviceWrite(session),
          emptyContent: session.active_thread_id
            ? null
            : h(ConversationEmptyState, {
              actions: [
                {
                  attrs: {
                    "data-suggestion": "Summarize the structure of this repo and point out the important entry points.",
                  },
                  label: "Summarize this repo",
                },
                {
                  attrs: {
                    "data-suggestion": "Find the bug in this project and explain the likely root cause before changing code.",
                  },
                  label: "Find the bug",
                },
                {
                  attrs: {
                    "data-suggestion": "Review this codebase for areas that feel too complex and suggest a cleanup plan.",
                  },
                  label: "Suggest a cleanup",
                },
              ],
              copy: "Pick a workspace, then use this console to launch or open a session while keeping an eye on control, trust, and audit state.",
              details: state.selectedCwd ? [`Selected workspace: ${state.selectedCwd}`] : [],
              title: "Relay standing by",
            }),
          readyState: session.active_thread_id
            ? {
              readyCopy: `${providerLabel(session?.provider) || "The agent"} is connected. Send the first prompt below when you're ready.`,
              session,
              shortId,
              waitingCopy: "This thread is open, but another device currently has control. Take over to send the first prompt from here.",
            }
            : null,
        })
      );
      return;
    }

    const previousSnapshot = state.localTranscriptScrollSnapshot || null;
    const localThreadId = session?.active_thread_id || null;
    if (!state.localTranscriptScrollAnchors) {
      state.localTranscriptScrollAnchors = new Map();
    }
    if (!state.localTranscriptScrollPositions) {
      state.localTranscriptScrollPositions = new Map();
    }
    let restoredScrollTop = null;
    if (
      previousSnapshot?.activeThreadId
      && previousSnapshot.activeThreadId !== localThreadId
    ) {
      const evictedThreadId = rememberTranscriptScrollPosition(
        state.localTranscriptScrollPositions,
        previousSnapshot.activeThreadId,
        transcript
      );
      if (evictedThreadId) {
        state.localTranscriptScrollAnchors.delete(evictedThreadId);
      }
      restoredScrollTop = readTranscriptScrollPosition(
        state.localTranscriptScrollPositions,
        localThreadId
      );
    }
    const anchorsForThread =
      state.localTranscriptScrollAnchors.get(localThreadId) || new Set();

    renderConversationContent(
      h(TranscriptPane, {
        approval,
        canWrite: canComposeThread({
          activeTurnId: session.active_turn_id,
          hasActiveSession: Boolean(session.active_thread_id),
          hasControllerLease: canCurrentDeviceWrite(session),
          reviewLocked: isReviewInProgressForThread(session, session.active_thread_id),
        }),
        entries,
        hydrationLoading: shouldShowTranscriptLoading(session, state),
        transcriptOptions: {
          currentCwd: session?.current_cwd || state.selectedCwd || "",
          detailEntries: transcriptDetailEntries,
          // Hide rollback/reapply on a read-only view-only thread (the apply
          // endpoint resolves the item against the relay's REAL active thread, so
          // acting from a saved-thread view would mutate the wrong/live thread),
          // and while the active thread is itself under review.
          enableFileChangeActions:
            !session.view_only &&
            !isReviewInProgressForThread(session, session.active_thread_id),
          expandedKeys: localUi.transcriptExpandedItemIds,
          loadingItemIds: localUi.transcriptLoadingItemIds,
          onEnsureFileChangeDetail: (itemId) => {
            void state.controller?.ensureFileChangeDetail?.(itemId);
          },
          // Suppress the answer entry while the active thread is under review (the
          // orchestrator dismisses the reviewer's own questions; v1 is non-interactive).
          pendingAskUserQuestions: isReviewInProgressForThread(
            session,
            session.active_thread_id
          )
            ? []
            : session?.pending_ask_user_questions || [],
          onSubmitAskUserAnswers: (requestId, answers) => {
            void state.controller?.submitAskUserQuestionAnswer?.(requestId, answers);
          },
          askUserSubmittingRequestId: localUi.askUserSubmittingRequestId || "",
          askUserErrors: localUi.askUserErrors instanceof Map ? localUi.askUserErrors : new Map(),
        },
      })
    );

    const action = restoreTranscriptScrollPosition({
      alreadyAnchoredUserIds: anchorsForThread,
      nextEntries: entries,
      nextThreadId: localThreadId,
      previousSnapshot,
      restoredScrollTop,
      scrollElement: transcript,
    });
    if (action?.kind === "anchor-user" && action.userEntryId) {
      anchorsForThread.add(action.userEntryId);
      state.localTranscriptScrollAnchors.set(localThreadId, anchorsForThread);
    }
    state.localTranscriptScrollSnapshot = captureTranscriptScrollSnapshot({
      entries,
      scrollElement: transcript,
      threadId: localThreadId,
    });
  }

  function renderThreads() {
    const threadListUi = readThreadListUi(state.threadListStore);
    const selectedCwd = canonicalizeWorkspace(threadListUi.selectedCwd || state.selectedCwd);
    const viewedThreadId = state.viewThreadId || null;
    const previousScrollTop =
      appShell?.dataset.view === "conversation"
        ? state.pendingThreadHistoryScrollTop ??
          Math.max(state.threadHistoryScrollTop, threadsList?.scrollTop || 0)
        : 0;
    // Read the context-menu target so React can paint the `is-context-target`
    // highlight on the matching row below. If that thread has vanished (deleted
    // out from under an open menu), close the menu — but WITHOUT re-rendering,
    // since we're already inside renderThreads() and continue on to render the
    // list; then re-sync the local id so this pass doesn't highlight a ghost row.
    let openCtxThreadId = readThreadListContextMenu(state.threadListStore).threadId;
    if (openCtxThreadId && !state.threads.some((entry) => entry.id === openCtxThreadId)) {
      closeThreadContextMenu({ rerender: false });
      openCtxThreadId = readThreadListContextMenu(state.threadListStore).threadId;
    }

    const groups = state.threadGroups || [];
    const totalThreads = state.threads.length;

    renderWorkspaceSuggestions(state.session);
    threadsCount.textContent = summarizeThreadGroups(groups);
    threadsCount.title = groups.map((group) => group.cwd).join("\n");
    resumeLatestButton.disabled = totalThreads === 0;

    renderReactContent(
      threadsList,
      h(ThreadGroupList, {
        activeThreadId: viewedThreadId,
        contextMenuThreadId: openCtxThreadId,
        emptyMessage: "Start or open a session to build workspace groups.",
        expandedGroupCwds: threadListUi.expandedGroupCwds || new Set(),
        formatThreadMeta(thread) {
          return formatRelativeTime(thread.updated_at);
        },
        groups,
        onContextThread(threadId, clientX, clientY) {
          openThreadContextMenu(threadId, clientX, clientY);
        },
        onResumeThread(threadId) {
          // Opening a thread clears its attention dot immediately; the click also
          // doubles as the user gesture that unlocks notification permission.
          threadAttention.clear(threadId);
          void ensureNotificationPermission();
          renderThreads();
          if (typeof viewThread === "function") {
            viewThread(threadId);
          }
        },
        onSelectWorkspace(cwd) {
          setSelectedCwd(cwd || "");
          renderThreads();
          renderOverviewState(state.session);
        },
        onToggleExpandedGroup(cwd) {
          state.threadListStore.getState().toggleExpandedGroup(cwd);
          renderThreads();
        },
        selectedCwd,
        threadActivity: buildThreadActivityMap(state.session),
        threadAttention: threadAttention.snapshotMap(),
      })
    );

    window.requestAnimationFrame(() => {
      syncThreadHistoryScroll();
      if (appShell?.dataset.view === "conversation" && previousScrollTop > 0) {
        const maxScrollTop = Math.max(0, threadsList.scrollHeight - threadsList.clientHeight);
        threadsList.scrollTop = Math.min(previousScrollTop, maxScrollTop);
        state.threadHistoryScrollTop = threadsList.scrollTop;
      }
    });
  }

  function renderWorkspaceSuggestions(session) {
    if (!workspaceSuggestionsList) {
      return;
    }

    const suggestions = selectWorkspaceSuggestionsModel({
      session,
      selectedCwd: state.selectedCwd,
      threads: state.threads || [],
    });

    workspaceSuggestionsList.replaceChildren(
      ...suggestions.map((suggestion) => {
        const option = document.createElement("option");
        option.value = suggestion.cwd;
        option.label = suggestion.label || workspaceBasename(suggestion.cwd);
        return option;
      })
    );
  }

  function renderThreadListMessage(countLabel, message) {
    // rerender:false — this function renders its own (empty) thread-list content
    // just below, so let closeThreadContextMenu skip its own renderThreads().
    closeThreadContextMenu({ rerender: false });
    threadsCount.textContent = countLabel;
    threadsCount.title = "";
    resumeLatestButton.disabled = true;
    renderReactContent(
      threadsList,
      h(ThreadGroupList, {
        emptyMessage: message,
        groups: [],
      })
    );
  }

  function syncThreadSelection() {
    if (!threadsList) {
      return;
    }

    const viewedThreadId = state.viewThreadId || null;
    threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.threadId === viewedThreadId);
    });
  }

  function syncThreadHistoryScroll() {
    if (!threadsList || !sessionHistoryDrawer || !appShell) {
      return;
    }

    if (appShell.dataset.view !== "conversation") {
      threadsList.style.height = "";
      threadsList.style.maxHeight = "";
      return;
    }

    window.requestAnimationFrame(() => {
      const listRect = threadsList.getBoundingClientRect();
      const drawerRect = sessionHistoryDrawer.getBoundingClientRect();
      const availableHeight = Math.floor(drawerRect.bottom - listRect.top - 12);

      if (availableHeight > 120) {
        threadsList.style.height = `${availableHeight}px`;
        threadsList.style.maxHeight = `${availableHeight}px`;
      }
    });
  }

  function restoreThreadHistoryScroll() {
    if (!threadsList || !appShell || appShell.dataset.view !== "conversation") {
      return;
    }

    const desiredScrollTop =
      state.pendingThreadHistoryScrollTop ?? state.threadHistoryScrollTop ?? 0;
    if (desiredScrollTop <= 0) {
      return;
    }

    const applyScrollPosition = () => {
      const maxScrollTop = Math.max(0, threadsList.scrollHeight - threadsList.clientHeight);
      threadsList.scrollTop = Math.min(desiredScrollTop, maxScrollTop);
      state.threadHistoryScrollTop = threadsList.scrollTop;
    };

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        applyScrollPosition();
      });
    });

    window.setTimeout(() => {
      if (appShell?.dataset.view === "conversation") {
        applyScrollPosition();
      }
    }, 160);
  }

  function runViewTransition(update) {
    const startViewTransition = document.startViewTransition?.bind(document);
    if (typeof startViewTransition !== "function") {
      update();
      return Promise.resolve();
    }

    const transition = startViewTransition(() => {
      update();
    });

    return transition.finished.catch(() => {});
  }

  function renderLogs(entries) {
    // Feed the relay's server logs into the merged client-log view. This must
    // NOT replace the whole surface (the old behavior), or client-originated
    // status lines like "Prompt failed: ..." would be wiped on the next
    // snapshot before the user (or a test) can observe them.
    ingestRelayLogs?.(entries || []);
  }

  function metaChip(label, value) {
    return { label, value };
  }

  function overviewBadge(label, value) {
    return { label, value };
  }

  function sessionStatusLabel(session, approval) {
    if (approval) {
      return "Approval required";
    }

    if (!session?.provider_connected) {
      return "Offline";
    }

    if (!session?.active_thread_id) {
      return "Standby";
    }

    return "Live";
  }

  function classifyAuditEntry(entry) {
    const text = `${entry?.kind || ""} ${entry?.message || ""}`.toLowerCase();

    if (
      text.includes("failed") ||
      text.includes("denied") ||
      text.includes("rejected") ||
      text.includes("revoked") ||
      text.includes("offline") ||
      text.includes("disconnected")
    ) {
      return "alert";
    }

    if (
      text.includes("pairing approval required") ||
      text.includes("approval required for")
    ) {
      return "alert";
    }

    if (text.includes("approval") && text.includes("requested")) {
      return "alert";
    }

    if (
      text.includes("approved") ||
      text.includes("accepted") ||
      text.includes("started") ||
      text.includes("resumed") ||
      text.includes("connected") ||
      text.includes("saved") ||
      (text.includes("responded to approval") && text.includes("approve"))
    ) {
      return "ready";
    }

    if (text.includes("responded to approval") && text.includes("deny")) {
      return "alert";
    }

    return "neutral";
  }

  function shouldShowAuditEntry(entry) {
    const kind = String(entry?.kind || "").toLowerCase();
    const message = String(entry?.message || "");

    if (kind !== "codex") {
      return true;
    }

    return /approval|pair|revoke|connected|disconnected|take over|control|broker|session/i.test(
      message
    );
  }

  return {
    renderAuthRequiredState,
    renderOverviewState,
    renderSession,
    renderSessionMeta,
    renderSessionUnavailable,
    renderThreadListMessage,
    renderThreads,
    restoreThreadHistoryScroll,
    runViewTransition,
    setTranscriptHistorySync,
    syncThreadHistoryScroll,
    syncThreadSelection,
  };
}
