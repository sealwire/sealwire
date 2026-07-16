import {
  allowedRootsForm,
  allowedRootsInput,
  allowedRootsList,
  allowedRootsSummary,
  apiTokenInput,
  apiTokenLabel,
  appShell,
  applyTokenButton,
  archiveThreadButton,
  approvalPolicyInput,
  auditSummary,
  auditTimeline,
  chatShell,
  clientLogRoot,
  closeLaunchSettingsModalButton,
  closeSecurityModalBtn,
  closeSessionDetailsModalButton,
  connectionForm,
  controlBanner,
  copyPairingLinkButton,
  cwdInput,
  deleteThreadButton,
  directoryForm,
  goConsoleHomeButton,
  goConsoleHomeSidebarButton,
  launchSettingsModal,
  liveSurfacesList,
  liveSurfacesSummary,
  loadDirectoryButton,
  messageEffort,
  messageForm,
  messageInput,
  messageModel,
  modelInput,
  modelInputLabel,
  openLaunchSettingsButton,
  openSecurityConsoleButton,
  openSecurityHeaderButton,
  openSecurityModalBtn,
  openSessionDetailsButton,
  overviewSecurityBadges,
  pairedDevicesList,
  pairingApprovalList,
  pairingApprovalModal,
  closePairingApprovalModalBtn,
  pendingActionBanner,
  pendingPairingsList,
  providerInput,
  resumeLatestButton,
  sandboxInput,
  saveAllowedRootsButton,
  securityModal,
  sendButton,
  sessionDetailsModal,
  sessionHistoryDrawer,
  sessionMeta,
  startEffortInput,
  startEffortLabel,
  startPairingButton,
  startPromptInput,
  startSessionButton,
  statusBadge,
  agentWorkingIndicator,
  agentWorkingIndicatorLabel,
  stopButton,
  threadContextMenu,
  threadsCount,
  threadsList,
  threadsRefreshButton,
  transcript,
  workspaceTitle,
  workspaceSubtitle,
  workspaceDiffModal,
  closeWorkspaceDiffModalButton,
  workspaceDiffTitleMount,
  workspaceDiffMount,
  workspaceChangesMount,
  workspaceDiffChipMount,
  reviewerChipMount,
  sidebarElement,
  sidebarResizeHandle,
  rightRailResizeHandle,
  toggleLeftPanelButton,
  toggleRightPanelButton,
  sidebarTopToggleButton,
  railTopToggleButton,
  newSessionComposeButton,
} from "./local/dom.js";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  createApiFetch,
  createAuthSession,
  deleteAuthSession,
  fetchAuthSession,
  getReviews,
} from "./local/api.js";
import {
  createWorkspaceDiffStore,
  createWorkspaceDiffSheet,
  mountChangesPanel,
  mountChip,
  mountReviewerChip,
} from "./local/workspace-diff.js";
import { createPanelControl } from "./local/panel-controls.js";
import { setupHeaderBandSync } from "./local/header-band-sync.js";
import {
  createVerbCycler,
  isProgressStalled,
  progressPhaseLabel,
} from "./progress-verbs.js";
import {
  configureSecurityRenderers,
  renderAllowedRoots,
  renderDeviceRecords,
  renderPairingApprovalModal,
  renderPairingPanel,
  renderPendingPairingRequests,
} from "./local/render-security.js";
import { createSessionRenderer } from "./local/render-session.js";
import { createSessionController } from "./local/session-controller.js";
import {
  createLocalUiStore,
  readLocalUiState,
} from "./local/ui-store.js";
import { openSessionStream, sessionStreamUrl } from "./session-stream.js";
import {
  buildThreadGroups,
} from "./shared/thread-groups.js";
import {
  createThreadListStore,
  readThreadListContextMenu,
  readThreadListUi,
} from "./shared/thread-list-store.js";
import { installThreadListWheelProxy } from "./shared/thread-list-scroll.js";
import { fetchBuildInfo } from "./shared/build-badge.js";
import { providerLabel } from "./shared/provider-labels.js";
import { isReviewInProgressForThread } from "./shared/review-state.js";
import {
  buildViewOnlyPin,
  mergeOlderViewOnlyPage,
  viewOnlyEligible,
  viewOnlyPinNextAction,
  viewOnlySelfHealThreadId,
} from "./local/view-only-thread.js";
import { shouldRefreshViewedThread } from "./shared/viewed-thread-refresh.js";
import { ClientLog } from "./shared/client-log.js";
import { mapRelayLogEntries, mergeLogEntries } from "./shared/client-log-merge.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
  saveLastApprovalPolicy,
  saveLastEffort,
} from "./shared/last-used-settings.js";
import {
  renderSelectOptions,
  replaceSelectOptions,
} from "./shared/select-options.js";
import { buildModelSelectOptions } from "./shared/composer.js";
import {
  buildReasoningEffortOptions,
  resolveReasoningEffortValue,
} from "./shared/reasoning-efforts.js";
import {
  defaultModelForProvider,
  defaultProvider,
  normalizeProviderList,
  providerOptions,
  providerSettings,
  sandboxOptions,
} from "./shared/provider-settings.js";
import { localQueryClient } from "./local/query-client.js";
import { attachTranscriptHistoryLoader } from "./shared/transcript-history-loader.js";
import { copyTextToClipboard } from "./shared/clipboard.js";
import {
  countReviewerThreadsForParent,
  reviewerChoiceRequestInit,
} from "./shared/reviewer-threads.js";

const DEVICE_STORAGE_KEY = "agent-relay.device-id";
const API_TOKEN_STORAGE_KEY = "agent-relay.api-token";

const state = {
  apiToken: loadApiToken(),
  authRequired: false,
  authenticated: false,
  cookieSession: false,
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  currentPairing: null,
  // Client-originated status lines (sends, errors, etc.) kept as {at, text} so
  // they can be merged with the relay's server logs in one #client-log view.
  // These PERSIST across snapshots — a server-log refresh must not wipe them.
  clientLogLines: [{ at: Date.now(), text: "Booting web client..." }],
  // Latest server (relay) log entries, refreshed from each session snapshot.
  relayLogLines: [],
  deviceId: loadOrCreateDeviceId(),
  defaultsSeeded: false,
  selectedCwd: "",
  session: null,
  viewThreadId: readThreadIdFromUrl(),
  // Read-only "view projection" pin for ANY non-active thread the user is looking
  // at (see local/view-only-thread.js). `{ threadId, entries, olderCursor,
  // generation, review, reviewSig, loading }` or null. Loaded by
  // loadViewOnlyTranscript() below; paginated by loadOlderViewOnlyTranscript().
  viewOnlyThread: null,
  viewOnlyGeneration: 0,
  // True while a composer submit is in flight.
  // Freezes the composer and rejects re-entry so a draft edit / navigation /
  // double-submit during the async request can't change or duplicate the send.
  composerSubmitInFlight: false,
  sessionStream: null,
  streamConnected: false,
  transcriptEntryDetailCache: new Map(),
  transcriptEntryDetailOrder: [],
  transcriptHydrationBaseSnapshot: null,
  transcriptHydrationEntries: new Map(),
  transcriptHydrationLastFetchAt: 0,
  transcriptHydrationOrder: [],
  transcriptHydrationOlderCursor: null,
  transcriptHydrationPromise: null,
  transcriptHydrationSignature: null,
  transcriptHydrationStatus: "idle",
  transcriptHydrationTailReady: false,
  transcriptHydrationThreadId: null,
  transcriptLiveEntryDetails: new Map(),
  transcriptLiveEntryThreadId: null,
  transcriptPreserveScroll: false,
  pendingThreadHistoryScrollTop: null,
  providerModels: {},
  providers: [],
  threadGroups: [],
  threadHistoryScrollTop: 0,
  threadListStore: createThreadListStore(),
  localUiStore: createLocalUiStore(),
  streamReconnectTimer: null,
  sessionPollTimer: null,
  threads: [],
  threadsPollTimer: null,
};

const apiFetch = createApiFetch({
  getApiToken() {
    return state.apiToken;
  },
  onUnauthorized(message) {
    handleUnauthorized(message);
  },
});

const workspaceDiffStore = createWorkspaceDiffStore({ apiFetch, surface: "local" });
let clientLogRootHandle = null;
let clientLogRootElement = null;

// Reviewer-tab actions. Bound late through `state.controller` (assigned after
// the controller is built) so these can be wired into the rail + sheet mounts
// that run at module load; they only ever fire on user interaction.
const reviewerActions = {
  onRequestReview: (values) => state.controller?.requestReview(values),
  onResolveReview: (reviewJobId) => state.controller?.resolveReview(reviewJobId),
  onDeleteReview: (reviewId) => state.controller?.deleteReview(reviewId),
  fetchReviewerTranscript: (threadId) =>
    Promise.resolve(state.controller?.fetchTranscriptPage(threadId, {})).then(
      (page) => page?.entries || (Array.isArray(page) ? page : [])
    ),
};

const workspaceDiffSheet = createWorkspaceDiffSheet({
  store: workspaceDiffStore,
  mount: workspaceDiffMount,
  modal: workspaceDiffModal,
  closeButton: closeWorkspaceDiffModalButton,
  titleMount: workspaceDiffTitleMount,
  reviewer: reviewerActions,
  panelId: "review-panel-sheet",
});
mountChangesPanel({
  store: workspaceDiffStore,
  mount: workspaceChangesMount,
  reviewer: reviewerActions,
  panelId: "review-panel-rail",
});
setupHeaderBandSync({
  chatHeader: document.querySelector(".chat-shell > .chat-header"),
});
mountChip({
  store: workspaceDiffStore,
  mount: workspaceDiffChipMount,
  onTap: () => {
    // Mirror the Reviewer chip below: force the Changes tab rather than opening
    // on whatever tab was last persisted, so tapping the diff chip always shows
    // the diff (not the Reviewer panel under a now-"Reviewer" title).
    workspaceDiffStore.setActiveTab("changes");
    workspaceDiffSheet?.open();
  },
});
mountReviewerChip({
  store: workspaceDiffStore,
  mount: reviewerChipMount,
  onTap: () => {
    // Land the user straight on the Reviewer tab rather than whatever was last open.
    workspaceDiffStore.setActiveTab("reviewer");
    workspaceDiffSheet?.open();
  },
});
void workspaceDiffStore.refresh();

const leftPanelControl = createPanelControl({
  cssVarName: "--sidebar-width",
  widthStorageKey: "agent-relay:local-sidebar-width",
  openWidthStorageKey: "agent-relay:local-sidebar-open-width",
  minOpenWidth: 220,
  maxOpenWidth: 520,
  defaultOpenWidth: 300,
  side: "left",
});
leftPanelControl.attachResizeHandle(sidebarResizeHandle);
leftPanelControl.attachToggleButton(toggleLeftPanelButton);
leftPanelControl.attachToggleButton(sidebarTopToggleButton);
leftPanelControl.subscribe(({ isOpen }) => {
  document.body.classList.toggle("sidebar-collapsed", !isOpen);
});
newSessionComposeButton?.addEventListener("click", () => {
  document.getElementById("launch-start-session-dialog")?.setAttribute("open", "");
});

const rightPanelControl = createPanelControl({
  cssVarName: "--right-rail-width",
  widthStorageKey: "agent-relay:local-rail-width",
  openWidthStorageKey: "agent-relay:local-rail-open-width",
  minOpenWidth: 260,
  maxOpenWidth: 560,
  defaultOpenWidth: 320,
  side: "right",
});
rightPanelControl.attachResizeHandle(rightRailResizeHandle);
rightPanelControl.attachToggleButton(toggleRightPanelButton);
rightPanelControl.attachToggleButton(railTopToggleButton);
rightPanelControl.subscribe(({ isOpen }) => {
  document.body.classList.toggle("rail-collapsed", !isOpen);
});
document.addEventListener("keydown", (event) => {
  const isKeyB = event.key === "b" || event.key === "B" || event.code === "KeyB";
  if (!isKeyB) return;
  const metaLike = event.metaKey || event.ctrlKey;
  if (!metaLike || event.shiftKey) return;
  if (event.altKey) {
    event.preventDefault();
    rightPanelControl.toggle();
  } else {
    event.preventDefault();
    leftPanelControl.toggle();
  }
});

let lastTurnDiffItemId = null;
let lastWorkspaceCwd = null;
window.addEventListener("agent-relay:session-updated", () => {
  refreshWorkspaceDiffIfChanged();
});
function refreshWorkspaceDiffIfChanged() {
  const session = state.session;
  if (!session) return;
  const cwd = session.current_cwd || "";
  if (lastWorkspaceCwd !== null && cwd !== lastWorkspaceCwd) {
    lastWorkspaceCwd = cwd;
    lastTurnDiffItemId = null;
    void workspaceDiffStore.refresh();
    return;
  }
  lastWorkspaceCwd = cwd;
  const entries = session.transcript || [];
  let latest = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.tool?.item_type === "turnDiff") {
      latest = entries[i].item_id || null;
      break;
    }
  }
  if (latest && latest !== lastTurnDiffItemId) {
    lastTurnDiffItemId = latest;
    void workspaceDiffStore.refresh();
  } else if (!latest) {
    lastTurnDiffItemId = null;
  }
}

configureSecurityRenderers({
  escapeHtml,
  formatTimestamp,
  shortId,
  workspaceBasename,
});

let controller;

fetchBuildInfo("relay").then((info) => {
  const el = document.querySelector("#build-info-local");
  if (el) {
    el.textContent = info.label;
    el.title = info.title;
  }
});

// --- progress verb cycler --------------------------------------------------
//
// While `session.current_phase` is set we rotate through a small pool of
// gerund verbs every 2.5s so the inline working indicator above the composer
// keeps moving and proves the UI is live. The timer is fully driven by phase
// transitions reported in session snapshots — when phase clears we tear it
// down.

const VERB_CYCLE_MS = 2500;
const verbCycler = createVerbCycler();
let currentProgressVerb = null;
let verbTimer = null;

function syncVerbTimer(session) {
  const phase = session?.current_phase ?? null;
  if (phase) {
    if (!verbTimer) {
      currentProgressVerb = verbCycler.next();
      verbTimer = setInterval(() => {
        currentProgressVerb = verbCycler.next();
        refreshAgentWorkingIndicator();
      }, VERB_CYCLE_MS);
    }
  } else if (verbTimer) {
    clearInterval(verbTimer);
    verbTimer = null;
    currentProgressVerb = null;
    verbCycler.reset();
  }
  refreshAgentWorkingIndicator();
}

function refreshAgentWorkingIndicator() {
  const session = state.session;
  if (!agentWorkingIndicator) return;
  const approval = session?.pending_approvals?.[0] || null;
  const phase = session?.current_phase ?? null;
  // The snapshot's phase describes only the active thread. Show the working
  // indicator solely when the thread being viewed IS that active thread —
  // otherwise the console home (or another thread's page) would light up for
  // work happening elsewhere. Per-thread activity is surfaced by the sidebar
  // badge (session.thread_activity) instead.
  const viewingActive = Boolean(
    session?.active_thread_id && state.viewThreadId === session.active_thread_id
  );
  const offline = !session || approval || !session.provider_connected || !viewingActive || !phase;
  if (offline) {
    agentWorkingIndicator.hidden = true;
    return;
  }
  const stalled = isProgressStalled(session);
  const label = stalled
    ? "Stalled?"
    : progressPhaseLabel(phase, session.current_tool, currentProgressVerb);
  if (!label) {
    agentWorkingIndicator.hidden = true;
    return;
  }
  agentWorkingIndicator.hidden = false;
  const tone = stalled ? "alert" : "ready";
  agentWorkingIndicator.className = `agent-working-indicator agent-working-indicator-${tone}`;
  if (agentWorkingIndicatorLabel) {
    agentWorkingIndicatorLabel.textContent = label;
  }
}

const renderer = createSessionRenderer({
  state,
  renderAllowedRoots,
  renderPairingPanel,
  renderDeviceRecords,
  renderPendingPairingRequests,
  renderPairingApprovalModal,
  resolveActiveThread,
  setSelectedCwd,
  resumeSession(...args) {
    return controller.resumeSession(...args);
  },
  openThreadContextMenu,
  closeThreadContextMenu,
  scheduleControllerHeartbeat(...args) {
    return controller.scheduleControllerHeartbeat(...args);
  },
  scheduleControllerLeaseRefresh(...args) {
    return controller.scheduleControllerLeaseRefresh(...args);
  },
  cancelControllerHeartbeat() {
    return controller?.cancelControllerHeartbeat();
  },
  cancelControllerLeaseRefresh() {
    return controller?.cancelControllerLeaseRefresh();
  },
  logLine,
  renderClientLogLines,
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
  ensureConversationTranscript(session) {
    return controller?.ensureConversationTranscript(session);
  },
  syncComposerModel(session) {
    syncComposerModelForRenderedSession(session);
  },
  updateSessionSettings(payload) {
    return controller?.updateSessionSettings(payload);
  },
  requestReview(values) {
    return controller?.requestReview(values);
  },
  setReviewSlice(slice) {
    workspaceDiffStore.setReview(slice);
  },
  // The reviewer panel's dedicated, UNCOMPACTED data channel (review cards + reviewer
  // threads + revision). Decoupled from the byte-budgeted snapshot so the panel survives
  // live-turn compaction (which drains `active_review_jobs`).
  fetchReviews() {
    // Local is the operator surface (full access): the endpoint resolves reviews with no
    // device scope, so don't append a (dead) ?device_id query.
    return getReviews(apiFetch);
  },
  // View-only navigation: just update the URL/viewThreadId without calling the
  // backend resume_session, which is mutating (it moves the relay's single
  // active thread for EVERY connected client). Any non-active thread renders
  // from the client-local pin; an idle viewed thread can be sent to directly.
  viewThread(threadId) {
    void runViewTransition(() => {
      setThreadRoute(threadId);
      if (state.session) {
        renderer.renderSession(state.session);
      }
      renderer.syncThreadSelection();
    });
    // Fetch the viewed thread's transcript so it renders read-only (instead of
    // falling back to the console home). No-op / clears the projection when the
    // thread is the active one.
    void loadViewOnlyTranscript(threadId);
  },
});

// Wrap renderer.renderSession so every full render also reconciles the
// liveness verb timer. Patching the object (rather than only the local
// destructured binding) ensures controller callbacks below also flow
// through the wrapper.
const _baseRenderSession = renderer.renderSession;
renderer.renderSession = function wrappedRenderSession(session) {
  const previousLiveSession = state.session;
  const viewedThreadWasLive = Boolean(
    state.viewThreadId
    && previousLiveSession?.active_thread_id === state.viewThreadId
    && session?.active_thread_id !== state.viewThreadId
    && !state.viewOnlyThread
  );
  if (viewedThreadWasLive) {
    const summary =
      (state.threads || []).find((thread) => thread?.id === state.viewThreadId) || null;
    state.viewOnlyThread = buildViewOnlyPin({
      threadId: state.viewThreadId,
      priorEntries: previousLiveSession.transcript || [],
      cwd: summary?.cwd ?? previousLiveSession.current_cwd ?? null,
      provider: summary?.provider ?? previousLiveSession.provider ?? null,
      status: previousLiveSession.current_status || "idle",
      lastRefreshAt: Date.now(),
      wasWorking: Boolean(previousLiveSession.active_turn_id),
    });
  }
  // Make the real session current BEFORE reconciling the view-only pin.
  // maybeRefreshViewOnly() (and the loadViewOnlyTranscript it may trigger) read
  // state.session; without this, the very first render after a deep link to a
  // non-active thread runs while state.session is still null, the self-heal load
  // bails, and the one-attempt guard suppresses every retry. _baseRenderSession
  // sets it again (idempotent).
  state.session = session;
  maybeRefreshViewOnly(session);
  _baseRenderSession(session);
  syncVerbTimer(session);
  if (viewedThreadWasLive) {
    void loadViewOnlyTranscript(state.viewThreadId);
  }
};

// A stable signature of the review running on `threadId`, so the read-only view
// re-fetches when the review advances (a new round, a posted-back result) and is
// released when it ends.
function viewOnlyReviewSignature(session, threadId) {
  const job = (session?.active_review_jobs || []).find(
    (entry) => entry.parent_thread_id === threadId
  );
  return job ? `${job.status}:${job.round ?? 0}:${job.updated_at ?? 0}` : "none";
}

// Fetch a non-active thread's transcript tail into state.viewOnlyThread so
// render-session.js can project it read-only (with scroll-up pagination via the
// pin's olderCursor). Works for ANY non-active thread — the review-locked parent
// case is just one flavor (pin.review). For the active thread it clears the
// projection. A generation guard drops stale responses when the user navigates
// again mid-fetch.
async function loadViewOnlyTranscript(threadId) {
  const session = state.session;
  if (!viewOnlyEligible(session, threadId)) {
    if (state.viewOnlyThread) {
      state.viewOnlyThread = null;
      if (state.session) renderer.renderSession(state.session);
    }
    return;
  }

  const review = isReviewInProgressForThread(session, threadId);
  const generation = (state.viewOnlyGeneration = (state.viewOnlyGeneration || 0) + 1);
  const reviewSig = review ? viewOnlyReviewSignature(session, threadId) : null;
  // The viewed thread's own metadata (workspace + provider), so the projection
  // shows them instead of the live thread's for a cross-workspace saved thread.
  const summary = (state.threads || []).find((thread) => thread?.id === threadId) || null;
  const cwd = summary?.cwd ?? null;
  const provider = summary?.provider ?? null;
  const prior = state.viewOnlyThread?.threadId === threadId ? state.viewOnlyThread : null;
  const isWorking = Boolean(
    (session.thread_activity || []).find((entry) => entry?.thread_id === threadId)
  );
  const status = !isWorking && prior?.wasWorking ? "idle" : summary?.status ?? null;
  state.viewOnlyThread = buildViewOnlyPin({
    threadId,
    generation,
    review,
    reviewSig,
    cwd,
    provider,
    status,
    activeTurnId: prior?.activeTurnId || null,
    currentStatus: prior?.currentStatus || null,
    currentPhase: prior?.currentPhase || null,
    currentTool: prior?.currentTool || null,
    lastProgressAt: prior?.lastProgressAt ?? null,
    settings: prior?.settings || null,
    settingsWritable: Boolean(prior?.settingsWritable),
    availableModels: prior?.availableModels || [],
    lastRefreshAt: Date.now(),
    wasWorking: isWorking,
    priorEntries: prior?.entries || [],
    priorOlderCursor: prior?.olderCursor ?? null,
    loading: true,
  });
  if (state.session) renderer.renderSession(state.session);

  try {
    const page = await controller?.fetchTranscriptPage(threadId, {});
    if (generation !== state.viewOnlyGeneration) return;
    const normalized =
      page && Array.isArray(page.entries)
        ? page
        : { thread_id: threadId, entries: Array.isArray(page) ? page : [], prev_cursor: null };
    state.viewOnlyThread = buildViewOnlyPin({
      threadId,
      page: normalized,
      generation,
      review,
      reviewSig,
      cwd: normalized.thread_state?.current_cwd ?? cwd,
      provider: normalized.thread_state?.provider ?? provider,
      status,
      activeTurnId: normalized.thread_state?.active_turn_id || null,
      currentStatus: normalized.thread_state?.current_status || null,
      currentPhase: normalized.thread_state?.current_phase || null,
      currentTool: normalized.thread_state?.current_tool || null,
      lastProgressAt: normalized.thread_state?.last_progress_at ?? null,
      settings: normalized.thread_state
        ? {
          approval_policy: normalized.thread_state.approval_policy || "",
          sandbox: normalized.thread_state.sandbox || "",
          reasoning_effort: normalized.thread_state.reasoning_effort || "",
          model: normalized.thread_state.model || "",
        }
        : null,
      settingsWritable: Boolean(normalized.thread_state?.settings_writable),
      availableModels: normalized.thread_state?.available_models || [],
      lastRefreshAt: Date.now(),
      wasWorking: isWorking,
    });
  } catch (error) {
    if (generation !== state.viewOnlyGeneration) return;
    state.viewOnlyThread = buildViewOnlyPin({
      threadId,
      generation,
      review,
      reviewSig,
      cwd,
      provider,
      status,
      activeTurnId: prior?.activeTurnId || null,
      currentStatus: prior?.currentStatus || null,
      currentPhase: prior?.currentPhase || null,
      currentTool: prior?.currentTool || null,
      lastProgressAt: prior?.lastProgressAt ?? null,
      settings: prior?.settings || null,
      settingsWritable: Boolean(prior?.settingsWritable),
      availableModels: prior?.availableModels || [],
      lastRefreshAt: Date.now(),
      wasWorking: isWorking,
      priorEntries: prior?.entries || [],
      priorOlderCursor: prior?.olderCursor ?? null,
      // Mark the failure so the self-heal (viewOnlySelfHealThreadId) retries this
      // load after a backoff instead of treating the empty shell as settled.
      error: true,
    });
    logLine(`Couldn't load the read-only thread view: ${error.message}`);
  }
  if (state.session) renderer.renderSession(state.session);
}

// Scroll-up pagination for the read-only pin: fetch the page before the pin's
// olderCursor (cache-aware via the transcript page cache) and prepend it.
// Deliberately separate from the active-thread hydration pipeline — that store
// is keyed to the live thread and must not be re-keyed by a view-only visit.
let viewOnlyOlderLoading = false;
// Returns the same tri-state the active-thread loader uses so the history
// loader can keep prefetching read-only pins within one intersection:
//   true  → a page loaded and more remain
//   false → reached the pin's oldest page (stop for good)
//   null  → nothing loaded right now (in-flight / not viewing / error) — retry
async function loadOlderViewOnlyTranscript() {
  const pin = state.viewOnlyThread;
  if (!pin || state.viewThreadId !== pin.threadId) {
    return null;
  }
  if (pin.olderCursor == null) {
    return false; // no older cursor → this is the oldest page of the pin
  }
  if (pin.loading || viewOnlyOlderLoading) {
    return null; // a load is already in flight; not a definitive stop
  }
  const generation = pin.generation;
  viewOnlyOlderLoading = true;
  try {
    const page = await controller?.fetchTranscriptPage(pin.threadId, {
      before: pin.olderCursor,
    });
    const current = state.viewOnlyThread;
    if (!current || current.generation !== generation || current.threadId !== pin.threadId) {
      return null; // user navigated / pin replaced while the fetch was in flight
    }
    state.viewOnlyThread = mergeOlderViewOnlyPage(current, page);
    if (state.session) renderer.renderSession(state.session);
    return state.viewOnlyThread?.olderCursor != null;
  } catch (error) {
    logLine(`Couldn't load older messages for the read-only view: ${error.message}`);
    return null;
  } finally {
    viewOnlyOlderLoading = false;
  }
}

// Called on every render: keep the pin honest against the latest REAL session.
// Pins stay pinned while viewed and never auto-resume. Review pins refresh when
// their review advances or ends. Also self-heals: deep links / back-button land on a
// non-active thread without going through viewThread(), and a rapid-switch race can
// drop the pin — so re-arm the load here whenever the viewed thread lacks a good pin
// (viewOnlySelfHealThreadId), with a backoff on failures so a failing fetch can't loop.
function maybeRefreshViewOnly(session) {
  const pin = state.viewOnlyThread;
  if (pin && session) {
    const action = viewOnlyPinNextAction(session, pin, {
      viewThreadId: state.viewThreadId,
      reviewSignature: viewOnlyReviewSignature,
    });
    if (action.kind === "release") {
      state.viewOnlyThread = null;
    } else if (action.kind === "refresh") {
      void loadViewOnlyTranscript(pin.threadId);
    } else {
      const working = Boolean(
        (session.thread_activity || []).find((entry) => entry?.thread_id === pin.threadId)
      );
      if (shouldRefreshViewedThread({
        elapsedMs: Date.now() - (pin.lastRefreshAt || 0),
        loading: pin.loading,
        wasWorking: pin.wasWorking,
        working,
      })) {
        void loadViewOnlyTranscript(pin.threadId);
      }
    }
  }

  // The viewed thread's cwd/provider come from its thread summary, which on a
  // deep link loads AFTER the session — so a deep-linked pin can be built with
  // them null. Backfill once the summary appears (otherwise the projection shows
  // blank metadata until then).
  const metaPin = state.viewOnlyThread;
  if (metaPin && (metaPin.cwd == null || metaPin.provider == null)) {
    const summary = (state.threads || []).find((thread) => thread?.id === metaPin.threadId) || null;
    if (summary && (summary.cwd != null || summary.provider != null)) {
      state.viewOnlyThread = {
        ...metaPin,
        cwd: metaPin.cwd ?? summary.cwd ?? null,
        provider: metaPin.provider ?? summary.provider ?? null,
      };
    }
  }

  const selfHeal = viewOnlySelfHealThreadId(session, {
    viewThreadId: state.viewThreadId,
    viewOnlyThread: state.viewOnlyThread,
    now: Date.now(),
  });
  if (selfHeal) {
    void loadViewOnlyTranscript(selfHeal);
  }
}

controller = createSessionController({
  state,
  apiFetch,
  queryClient: localQueryClient,
  shortId,
  logLine,
  seedDefaults,
  setSelectedCwd,
  setThreadRoute,
  canCurrentDeviceWrite,
  renderSession: renderer.renderSession,
  renderOverviewState: renderer.renderOverviewState,
  renderSessionUnavailable: renderer.renderSessionUnavailable,
  renderThreadListMessage: renderer.renderThreadListMessage,
  renderThreads: renderer.renderThreads,
  renderAuthRequiredState: renderer.renderAuthRequiredState,
  runViewTransition: renderer.runViewTransition,
  handleUnauthorized,
});
// Stash on state so React render paths (e.g. transcript-react.js's
// AskUserEntry onClick) can call back into the controller without an
// additional prop-drilling layer through every render entrypoint.
state.controller = controller;

const {
  renderAuthRequiredState,
  renderSession,
  renderSessionMeta,
  renderThreads,
  runViewTransition,
  syncThreadHistoryScroll,
  syncThreadSelection,
} = renderer;

const {
  cancelControllerHeartbeat,
  cancelControllerLeaseRefresh,
  cancelSessionPoll,
  cancelStreamReconnect,
  cancelThreadsPoll,
  connectSessionStream,
  copyPairingLink,
  decidePairingRequest,
  loadSession,
  loadThreads,
  resumeLatestSession,
  resumeSession,
  revokeOtherDevices,
  revokePairedDevice,
  saveAllowedRoots,
  scheduleThreadsPoll,
  sendMessage,
  stopActiveTurn,
  startPairing,
  startSession,
  submitDecision,
  takeOverControl,
  toggleTranscriptEntry,
  toggleTranscriptExpandKey,
  applyFileChange,
} = controller;

threadsList?.addEventListener("scroll", () => {
  state.threadHistoryScrollTop = threadsList.scrollTop;
});

sessionHistoryDrawer?.addEventListener("toggle", () => {
  state.threadListStore.getState().setDrawerOpen(Boolean(sessionHistoryDrawer.open));
});

installThreadListWheelProxy({
  root: sessionHistoryDrawer,
  scrollElement: threadsList,
  shouldProxyWheel() {
    return Boolean(sessionHistoryDrawer?.open);
  },
});

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuthSession();
});

startPairingButton.addEventListener("click", () => {
  void startPairing();
});

function openSecurityModal() {
  state.localUiStore.getState().setAllowedRootsDraftDirty(false);
  renderAllowedRoots(state.session?.allowed_roots || [], {
    draftDirty: readLocalUiState(state.localUiStore).allowedRootsDraftDirty,
  });
  renderPairingPanel(state.currentPairing);
  renderDeviceRecords(state.session?.device_records || []);
  renderPendingPairingRequests(
    state.session?.pending_pairing_requests || [],
    state.pendingPairingDecisions || {}
  );
  securityModal?.showModal();
}

openSecurityModalBtn?.addEventListener("click", openSecurityModal);
openSecurityConsoleButton?.addEventListener("click", openSecurityModal);
openSecurityHeaderButton?.addEventListener("click", openSecurityModal);

closeSecurityModalBtn?.addEventListener("click", () => {
  securityModal?.close();
});

securityModal?.addEventListener("click", (event) => {
  if (event.target === securityModal) {
    securityModal.close();
  }
});

closePairingApprovalModalBtn?.addEventListener("click", () => {
  pairingApprovalModal?.close();
});

pairingApprovalModal?.addEventListener("click", (event) => {
  if (event.target === pairingApprovalModal) {
    pairingApprovalModal.close();
    return;
  }

  const decisionButton = event.target.closest("[data-pairing-id][data-pairing-decision]");
  if (!decisionButton) {
    return;
  }

  void decidePairingRequest(
    decisionButton.dataset.pairingId,
    decisionButton.dataset.pairingDecision
  );
});

openLaunchSettingsButton?.addEventListener("click", () => {
  launchSettingsModal?.showModal();
});

closeLaunchSettingsModalButton?.addEventListener("click", () => {
  launchSettingsModal?.close();
});

launchSettingsModal?.addEventListener("click", (event) => {
  if (event.target === launchSettingsModal) {
    launchSettingsModal.close();
  }
});

openSessionDetailsButton?.addEventListener("click", () => {
  if (state.session) {
    renderSessionMeta(state.session);
  }
  sessionDetailsModal?.showModal();
});

closeSessionDetailsModalButton?.addEventListener("click", () => {
  sessionDetailsModal?.close();
});

sessionDetailsModal?.addEventListener("click", (event) => {
  if (event.target === sessionDetailsModal) {
    sessionDetailsModal.close();
  }
});

copyPairingLinkButton.addEventListener("click", () => {
  void copyPairingLink();
});

allowedRootsInput?.addEventListener("input", () => {
  state.localUiStore.getState().setAllowedRootsDraftDirty(true);
});

allowedRootsForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAllowedRoots();
});

goConsoleHomeButton?.addEventListener("click", () => {
  clearThreadRoute();
  if (state.session) {
    renderSession(state.session);
  }
  renderThreads();
});

goConsoleHomeSidebarButton?.addEventListener("click", () => {
  clearThreadRoute();
  if (state.session) {
    renderSession(state.session);
  }
  renderThreads();
});

threadsRefreshButton.addEventListener("click", () => {
  void loadThreads("manual refresh");
});

archiveThreadButton?.addEventListener("click", () => {
  void archiveThreadFromContextMenu();
});

deleteThreadButton?.addEventListener("click", () => {
  void deleteThreadFromContextMenu();
});

document.addEventListener("click", (event) => {
  if (!threadContextMenu || threadContextMenu.hidden) {
    return;
  }

  if (event.target.closest("#thread-context-menu")) {
    return;
  }

  closeThreadContextMenu();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeThreadContextMenu();
  }
});

window.addEventListener("blur", () => {
  closeThreadContextMenu();
});

window.addEventListener("resize", () => {
  closeThreadContextMenu();
  syncThreadHistoryScroll();
});

window.addEventListener("popstate", () => {
  state.viewThreadId = readThreadIdFromUrl();
  if (state.session) {
    renderSession(state.session);
  }
  renderThreads();
});

directoryForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  clearThreadRoute();
  setSelectedCwd(cwdInput.value.trim());
  void loadThreads("directory change");
});

resumeLatestButton?.addEventListener("click", () => {
  void resumeLatestSession();
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target?.closest("#start-session-button")) {
    return;
  }
  void startSession();
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) && !(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) {
    return;
  }
  handleLaunchFieldInput(target.id, target.value);
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement)) {
    return;
  }
  handleLaunchFieldInput(target.id, target.value);
});

controlBanner?.addEventListener("click", (event) => {
  if (!event.target.closest("#take-over-button")) {
    return;
  }

  void takeOverControl();
});

// Drive a composer submit. The draft text and the target thread are captured
// synchronously at submit time and the composer is frozen, so a draft edit /
// navigation / second submit during the async send can't change or duplicate it.
// The send carries the target thread id; the relay starts the turn directly on
// that thread and moves control after success.
async function runComposerSubmit() {
  const text = messageInput.value;
  const pin = state.viewOnlyThread;
  if (pin?.review) {
    // A thread mid-review can't be sent to (the relay rejects resume/send for it).
    if (text.trim()) {
      logLine("This thread is being reviewed — you can’t send to it right now.");
    }
    return;
  }
  if (!text.trim()) {
    void sendMessage(text); // empty → sendMessage logs the parity message
    return;
  }
  // The thread the user is looking at (the read-only pin's thread, else active).
  const targetThreadId = pin?.threadId || state.session?.active_thread_id || null;
  state.composerSubmitInFlight = true;
  if (state.session) renderer.renderSession(state.session); // freeze the composer
  try {
    await sendMessage(text, targetThreadId);
  } finally {
    state.composerSubmitInFlight = false;
    if (state.session) renderer.renderSession(state.session); // unfreeze
  }
}

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.composerSubmitInFlight) {
    return; // a submit is already in flight — ignore the re-entry (double click)
  }
  void runComposerSubmit();
});

providerInput?.addEventListener("change", () => {
  void selectLaunchProvider(providerInput.value);
});

modelInput?.addEventListener("change", () => {
  const provider = providerInput?.value || state.session?.provider || "codex";
  const models = modelsForProvider(provider, state.session?.available_models || []);
  syncEffortSuggestions(startEffortInput, models, modelInput.value, startEffortInput.value, provider);
});

messageModel?.addEventListener("change", () => {
  // Effort is no longer in the composer; the popover owns it. Just react
  // to model changes so an effort default can still be persisted for this
  // provider+model pair.
  const provider = state.session?.provider;
  if (!provider) return;
  const models = state.session?.available_models || [];
  const resolved = resolveReasoningEffortValue(
    models,
    messageModel.value,
    loadLastEffort(provider) || state.session?.reasoning_effort || ""
  );
  if (resolved) saveLastEffort(provider, resolved);
});

stopButton?.addEventListener("click", () => {
  void stopActiveTurn();
});

transcript.addEventListener("click", (event) => {
  const copyButton = event.target.closest("[data-copy-message]");
  if (copyButton) {
    void copyTextToClipboard(copyButton.dataset.copyMessage || "", copyButton);
    return;
  }

  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    void submitDecision(
      approvalButton.dataset.approvalDecision,
      approvalButton.dataset.approvalScope || "once"
    );
    return;
  }

  const transcriptGroupToggleButton = event.target.closest("[data-transcript-toggle='group']");
  if (transcriptGroupToggleButton) {
    toggleTranscriptExpandKey(transcriptGroupToggleButton.dataset.expandKey || "");
    return;
  }

  const transcriptToggleButton = event.target.closest("[data-transcript-toggle='entry']");
  if (transcriptToggleButton) {
    void toggleTranscriptEntry(transcriptToggleButton.dataset.itemId);
    return;
  }

  const fileChangeActionButton = event.target.closest("[data-file-change-action]");
  if (fileChangeActionButton) {
    void applyFileChange(
      fileChangeActionButton.dataset.itemId,
      fileChangeActionButton.dataset.fileChangeAction
    );
    return;
  }

  const suggestionButton = event.target.closest("[data-suggestion]");
  if (suggestionButton) {
    messageInput.value = suggestionButton.dataset.suggestion || "";
    messageInput.focus();
    return;
  }

  const openThreadButton = event.target.closest("[data-open-thread-id]");
  if (openThreadButton) {
    const threadId = openThreadButton.dataset.openThreadId;
    if (threadId) {
      void runViewTransition(() => {
        setThreadRoute(threadId);
        if (state.session) {
          renderSession(state.session);
        }
        syncThreadSelection();
      });
      void loadViewOnlyTranscript(threadId);
    }
    return;
  }

  const goHomeButton = event.target.closest("[data-go-console-home]");
  if (goHomeButton) {
    void runViewTransition(() => {
      clearThreadRoute();
      if (state.session) {
        renderSession(state.session);
      }
      syncThreadSelection();
    });
    return;
  }

});

// IntersectionObserver-driven prefetch: when the zero-height history sentinel
// (the first child of TranscriptContent) gets within ~600px of the top edge of
// the scroller, we kick off the next older-page fetch. Compared to the old
// `addEventListener("scroll")` path, this (a) starts loading *before* the
// user reaches the top, hiding the network round-trip, and (b) doesn't fire
// dozens of times per second while scrolling. `sync()` is called after each
// renderSession because the sentinel is part of the React tree and may be
// replaced when the active branch swaps.
const transcriptHistoryLoader = attachTranscriptHistoryLoader({
  onLoad: () => {
    // A pinned read-only view paginates through its own pin (the hydration
    // pipeline is keyed to the live thread); everything else takes the normal
    // active-thread path, which no-ops while a pin is showing.
    const pin = state.viewOnlyThread;
    if (pin && state.viewThreadId === pin.threadId) {
      return loadOlderViewOnlyTranscript();
    }
    return controller?.maybeLoadOlderTranscript();
  },
  scrollElement: transcript,
});
renderer.setTranscriptHistorySync(() => transcriptHistoryLoader.sync());

pendingActionBanner?.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    void submitDecision(
      approvalButton.dataset.approvalDecision,
      approvalButton.dataset.approvalScope || "once"
    );
    return;
  }

  const openPairingApproval = event.target.closest("[data-open-pairing-approval]");
  if (openPairingApproval) {
    if (pairingApprovalModal && !pairingApprovalModal.open) {
      try {
        pairingApprovalModal.showModal();
      } catch {}
    }
    return;
  }

  const openSecurity = event.target.closest("[data-open-security]");
  if (openSecurity) {
    openSecurityModal();
  }
});

pairedDevicesList.addEventListener("click", (event) => {
  const revokeOthersButton = event.target.closest("[data-revoke-others-except-device-id]");
  if (revokeOthersButton) {
    void revokeOtherDevices(revokeOthersButton.dataset.revokeOthersExceptDeviceId);
    return;
  }

  const revokeButton = event.target.closest("[data-revoke-device-id]");
  if (!revokeButton) {
    return;
  }

  void revokePairedDevice(revokeButton.dataset.revokeDeviceId);
});

pendingPairingsList.addEventListener("click", (event) => {
  const decisionButton = event.target.closest("[data-pairing-id][data-pairing-decision]");
  if (!decisionButton) {
    return;
  }

  void decidePairingRequest(
    decisionButton.dataset.pairingId,
    decisionButton.dataset.pairingDecision
  );
});

void boot();

async function boot() {
  apiTokenInput.value = state.apiToken;
  updateConnectionForm();

  await refreshAuthSession("initial boot");
  if (state.apiToken && state.authRequired && !state.authenticated) {
    await signInWithApiToken(state.apiToken, "stored token migration");
  }
  if (state.authRequired && !state.authenticated) {
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    updateConnectionForm();
    renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
    return;
  }

  await loadSession("initial boot");
  await loadThreads("initial boot");
  connectSessionStream();
  scheduleThreadsPoll();
}

async function refreshAuthSession(reason) {
  try {
    const data = await fetchAuthSession();
    applyAuthSessionState(data);
    return data;
  } catch (error) {
    logLine(`Auth session check failed (${reason}): ${error.message}`);
    return null;
  }
}

async function submitAuthSession() {
  if (!state.authRequired) {
    logLine("This relay does not require an API token on the current bind host.");
    return;
  }

  const token = apiTokenInput.value.trim();
  if (token) {
    await signInWithApiToken(token, "manual sign-in");
    return;
  }

  if (!state.authenticated) {
    logLine("Enter RELAY_API_TOKEN to sign in.");
    apiTokenInput.focus();
    return;
  }

  await signOutAuthSession("manual sign-out");
}

async function signInWithApiToken(token, reason) {
  setConnectionFormBusy(true);

  try {
    const data = await createAuthSession(token);
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(data);
    logLine(`Local relay sign-in succeeded (${reason}).`);
    await resumeAfterAuthChange("sign-in");
  } catch (error) {
    clearStoredApiToken();
    state.apiToken = "";
    logLine(`Local relay sign-in failed: ${error.message}`);
  } finally {
    setConnectionFormBusy(false);
  }
}

async function signOutAuthSession(reason) {
  setConnectionFormBusy(true);

  try {
    const data = await deleteAuthSession();
    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(data);
    logLine(`Local relay sign-out succeeded (${reason}).`);
    await resumeAfterAuthChange("sign-out");
  } catch (error) {
    logLine(`Local relay sign-out failed: ${error.message}`);
  } finally {
    setConnectionFormBusy(false);
  }
}

function applyAuthSessionState(view) {
  state.authRequired = Boolean(view?.auth_required);
  state.authenticated = Boolean(view?.authenticated);
  state.cookieSession = Boolean(view?.cookie_session);
  if (state.authenticated || !state.authRequired) {
    clearStoredApiToken();
    state.apiToken = "";
  }
  updateConnectionForm();
}

function updateConnectionForm() {
  if (!apiTokenLabel || !applyTokenButton) {
    return;
  }

  connectionForm.hidden = !state.authRequired;

  if (!state.authRequired) {
    apiTokenLabel.textContent = "Local Access";
    apiTokenInput.value = "";
    apiTokenInput.disabled = true;
    apiTokenInput.placeholder = "No API token required on this relay";
    applyTokenButton.textContent = "Ready";
    applyTokenButton.disabled = true;
    return;
  }

  apiTokenLabel.textContent = state.cookieSession ? "Local Session" : "API Token";
  apiTokenInput.disabled = false;
  applyTokenButton.disabled = false;

  if (state.authenticated) {
    apiTokenInput.placeholder = "Signed in. Submit an empty field to sign out.";
    applyTokenButton.textContent = "Sign Out";
  } else {
    apiTokenInput.placeholder = "Enter RELAY_API_TOKEN to sign in";
    applyTokenButton.textContent = "Sign In";
  }
}

function setConnectionFormBusy(busy) {
  apiTokenInput.disabled = busy || !state.authRequired;
  applyTokenButton.disabled = busy || !state.authRequired;
}

async function resumeAfterAuthChange(reason) {
  state.streamConnected = false;
  cancelStreamReconnect();
  cancelSessionPoll();
  cancelThreadsPoll();
  if (state.sessionStream) {
    state.sessionStream.close();
    state.sessionStream = null;
  }

  if (state.authRequired && !state.authenticated) {
    renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
    return;
  }

  await loadSession(reason);
  await loadThreads(reason);
  connectSessionStream();
}

function handleUnauthorized(message) {
  const alreadySignedOut = state.authRequired && !state.authenticated;
  clearStoredApiToken();
  state.apiToken = "";
  apiTokenInput.value = "";
  state.authenticated = false;
  state.cookieSession = false;
  state.streamConnected = false;
  cancelStreamReconnect();
  cancelSessionPoll();
  cancelThreadsPoll();
  if (state.sessionStream) {
    state.sessionStream.close();
    state.sessionStream = null;
  }
  updateConnectionForm();
  renderAuthRequiredState(message);
  if (!alreadySignedOut) {
    logLine(message);
  }
}

function seedDefaults(session) {
  void refreshProviderCatalogs(session);
  const activeProvider = session.provider || defaultProvider(state.providers);
  const launchProvider = providerInput?.value || activeProvider;
  const launchModels = modelsForProvider(launchProvider, session.available_models || []);

  syncModelSuggestions(
    messageModel,
    session.available_models || [],
    messageModel?.value || session.model,
    true,
    true
  );

  if (!state.defaultsSeeded) {
    if (messageModel) {
      messageModel.value = session.model || defaultModelForProvider(activeProvider);
    }
    state.defaultsSeeded = true;
  }

  // Effort is no longer rendered in the composer (it lives in the settings
  // popover and persists via localStorage). If a stale messageEffort element
  // is still in the DOM, keep it in sync for backwards-compat.
  if (messageEffort) {
    syncEffortSuggestions(
      messageEffort,
      session.available_models || [],
      messageModel?.value || session.model,
      messageEffort.value || session.reasoning_effort,
      session.provider || ""
    );
  }

  syncLaunchSettingsModal(session, launchProvider, launchModels, activeProvider);

  if (!state.selectedCwd && session.current_cwd) {
    setSelectedCwd(session.current_cwd);
  }
}

async function refreshProviderCatalogs(session) {
  try {
    const launchDraft = readLocalUiState(state.localUiStore).sessionDraft || {};
    const liveProviderInput = document.getElementById("provider-input") || providerInput;
    const selectedProvider = launchDraft.provider || liveProviderInput?.value || session.provider;
    if (!state.providers.length) {
      const providersResponse = await apiFetch("/api/providers");
      const providersPayload = await providersResponse.json();
      if (providersResponse.ok && providersPayload.ok) {
        state.providers = normalizeProviderList(providersPayload.data);
        syncProviderSuggestions(liveProviderInput, state.providers, selectedProvider);
      }
    }
    await Promise.all(state.providers.map(async (provider) => {
      if (state.providerModels[provider]?.length) return;
      const response = await apiFetch(`/api/providers/${encodeURIComponent(provider)}/models`);
      const payload = await response.json();
      if (response.ok && payload.ok) {
        state.providerModels[provider] = payload.data || [];
      }
    }));
    const provider = selectedProvider || defaultProvider(state.providers);
    const liveModelInput = document.getElementById("model-input") || modelInput;
    const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;
    syncLaunchSettingLabels(provider);
    syncModelSuggestions(
      liveModelInput,
      modelsForProvider(provider, session.available_models || []),
      liveModelInput?.value || defaultModelForProvider(provider)
    );
    syncEffortSuggestions(
      liveStartEffortInput,
      modelsForProvider(provider, session.available_models || []),
      liveModelInput?.value || defaultModelForProvider(provider),
      liveStartEffortInput?.value || "",
      provider
    );
  } catch (error) {
    logLine(`Provider model refresh failed: ${error.message}`);
  }
}

function syncModelSuggestions(
  select,
  models,
  selectedModel,
  allowForeign = false,
  replaceExisting = false
) {
  if (!select) {
    return;
  }

  // Drop hidden models + keep the current selection representable (snapping a
  // stale foreign value to the provider default when !allowForeign). Shared with
  // the composer/dialog pickers via buildModelOptions, so the filtering rule has
  // a single tested definition.
  const { options, value: currentValue } = buildModelSelectOptions(
    models,
    selectedModel || select.value || "",
    { allowForeign }
  );

  const renderedOptions = options.map((model) => ({
    label: model.display_name || model.model,
    value: model.model,
  }));
  if (replaceExisting) {
    replaceSelectOptions(select, renderedOptions, currentValue);
  } else {
    renderSelectOptions(select, renderedOptions, currentValue);
  }
}

function syncComposerModelForRenderedSession(session) {
  if (!messageModel || !session?.active_thread_id) {
    return;
  }

  const models = session.available_models || [];
  const currentModel = models.some((model) => model.model === messageModel.value)
    ? messageModel.value
    : session.model || messageModel.value;

  // The rendered session may be a client-local view-only projection for a
  // provider different from the relay's live session. Use that projection's
  // catalog, reject a foreign current value in view-only mode, and reassert the
  // projection after every live snapshot. Preserve a manual selection whenever
  // it still belongs to the rendered provider's catalog.
  syncModelSuggestions(
    messageModel,
    models,
    currentModel,
    !session.view_only,
    true
  );
}

function syncProviderSuggestions(select, providers, selectedProvider) {
  if (!select) {
    return;
  }
  const options = providerOptions(providers);
  renderSelectOptions(select, options, selectedProvider || defaultProvider(providers));
}

function modelsForProvider(provider, fallbackModels = []) {
  const normalized = provider || "codex";
  return state.providerModels[normalized]?.length
    ? state.providerModels[normalized]
    : fallbackModels;
}

function handleLaunchFieldInput(id, value) {
  const fieldById = {
    "approval-policy-input": "approvalPolicy",
    "cwd-input": "cwd",
    "model-input": "model",
    "provider-input": "provider",
    "sandbox-input": "sandbox",
    "start-effort": "effort",
    "start-prompt": "initialPrompt",
  };
  const field = fieldById[id];
  if (!field) {
    return;
  }
  state.localUiStore.getState().setSessionDraftField(field, value);
  const draftProvider = readLocalUiState(state.localUiStore).sessionDraft?.provider || "codex";
  if (field === "effort") saveLastEffort(draftProvider, value);
  if (field === "approvalPolicy") saveLastApprovalPolicy(draftProvider, value);
  if (field !== "provider") {
    return;
  }

  const session = state.session || {};
  void refreshProviderCatalogs(session);
  const nextModels = modelsForProvider(value, session.available_models || []);
  const liveModelInput = document.getElementById("model-input") || modelInput;
  const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;
  const liveApprovalInput = document.getElementById("approval-policy-input") || approvalPolicyInput;
  const nextModel = defaultModelForProvider(value);
  const storedEffort = loadLastEffort(value);
  const storedApproval = loadLastApprovalPolicy(value);
  if (storedApproval) {
    state.localUiStore.getState().setSessionDraftField("approvalPolicy", storedApproval);
    if (liveApprovalInput) liveApprovalInput.value = storedApproval;
  }
  if (storedEffort) {
    state.localUiStore.getState().setSessionDraftField("effort", storedEffort);
  }
  syncLaunchSettingLabels(value);
  syncModelSuggestions(liveModelInput, nextModels, nextModel);
  syncEffortSuggestions(
    liveStartEffortInput,
    nextModels,
    nextModel,
    storedEffort || liveStartEffortInput?.value || "",
    value
  );
}

function syncLaunchSettingsModal(session, provider, launchModels, activeProvider) {
  const prov = provider || activeProvider || "codex";
  const models = launchModels?.length ? launchModels : (session?.available_models || []);
  const settings = providerSettings(prov);
  const launchDraft = readLocalUiState(state.localUiStore).sessionDraft || {};
  const fields = {
    approvalPolicy: launchDraft.approvalPolicy || session?.approval_policy || "untrusted",
    cwd: session?.current_cwd || state.selectedCwd || "",
    effort: launchDraft.effort || session?.reasoning_effort || "medium",
    initialPrompt: launchDraft.initialPrompt || "",
    model: launchDraft.model || session?.model || defaultModelForProvider(prov),
    provider: prov,
    sandbox: launchDraft.sandbox || session?.sandbox || "workspace-write",
  };
  const liveCwdInput = document.getElementById("cwd-input") || cwdInput;
  const liveStartPromptInput = document.getElementById("start-prompt") || startPromptInput;
  const liveProviderInput = document.getElementById("provider-input") || providerInput;
  const liveModelInput = document.getElementById("model-input") || modelInput;
  const liveApprovalPolicyInput = document.getElementById("approval-policy-input") || approvalPolicyInput;
  const liveSandboxInput = document.getElementById("sandbox-input") || sandboxInput;
  const liveStartEffortInput = document.getElementById("start-effort") || startEffortInput;

  if (liveCwdInput && !liveCwdInput.value) liveCwdInput.value = fields.cwd;
  if (liveStartPromptInput) liveStartPromptInput.value = fields.initialPrompt;
  syncProviderSuggestions(liveProviderInput, state.providers, fields.provider);
  syncLaunchSettingLabels(fields.provider);
  syncModelSuggestions(liveModelInput, models, fields.model);
  renderSelectOptions(liveApprovalPolicyInput, settings.approvalOptions, fields.approvalPolicy);
  renderSelectOptions(liveSandboxInput, sandboxOptions(), fields.sandbox);
  syncEffortSuggestions(liveStartEffortInput, models, fields.model, fields.effort, fields.provider);
}

function syncLaunchSettingLabels(provider) {
  const settings = providerSettings(provider);
  if (modelInputLabel) {
    modelInputLabel.textContent = settings.modelLabel;
  }
  if (startEffortLabel) {
    startEffortLabel.textContent = settings.effortLabel;
  }
  renderSelectOptions(
    approvalPolicyInput,
    settings.approvalOptions,
    approvalPolicyInput?.value || "untrusted"
  );
  renderSelectOptions(
    sandboxInput,
    sandboxOptions(),
    sandboxInput?.value || "workspace-write"
  );
}

async function selectLaunchProvider(provider) {
  const selected = provider || defaultProvider(state.providers);
  syncLaunchSettingLabels(selected);
  if (!state.providerModels[selected]?.length) {
    await refreshProviderCatalogs(state.session || { provider: selected, available_models: [] });
  }
  const models = modelsForProvider(selected, state.session?.available_models || []);
  const model = models.find((option) => option.is_default)?.model
    || models[0]?.model
    || defaultModelForProvider(selected);
  syncModelSuggestions(modelInput, models, model);
  syncEffortSuggestions(startEffortInput, models, model, startEffortInput?.value || "", selected);
}

function syncEffortSuggestions(select, models, selectedModel, selectedEffort, provider = "") {
  if (!select) {
    return;
  }

  const resolvedEffort = resolveReasoningEffortValue(models, selectedModel, selectedEffort);
  renderSelectOptions(
    select,
    buildReasoningEffortOptions(models, selectedModel, provider),
    resolvedEffort
  );
}

function setSelectedCwd(cwd) {
  state.threadListStore.getState().setSelectedCwd(cwd);
  state.selectedCwd = readThreadListUi(state.threadListStore).selectedCwd;
  cwdInput.value = state.selectedCwd;
}

function resolveActiveThread(threadId) {
  if (!threadId) {
    return null;
  }

  return state.threads.find((thread) => thread.id === threadId) || null;
}

function openThreadContextMenu(threadId, clientX, clientY) {
  if (!threadContextMenu || !archiveThreadButton || !deleteThreadButton || !threadId) {
    return;
  }

  state.threadListStore.getState().openContextMenu(threadId, clientX, clientY);
  const isActive = state.session?.active_thread_id === threadId;
  const isRunningActiveSession =
    isActive && Boolean(state.session?.active_turn_id);
  archiveThreadButton.disabled = isRunningActiveSession;
  archiveThreadButton.textContent = isRunningActiveSession
    ? "Running session cannot be archived"
    : "Archive session";
  deleteThreadButton.disabled = isRunningActiveSession;
  deleteThreadButton.textContent = isRunningActiveSession
    ? "Running session cannot be deleted"
    : "Delete permanently";

  threadContextMenu.hidden = false;
  const left = Math.max(12, Math.min(clientX, window.innerWidth - 220));
  const top = Math.max(12, Math.min(clientY, window.innerHeight - 64));
  threadContextMenu.style.left = `${left}px`;
  threadContextMenu.style.top = `${top}px`;

  // Re-render the thread list so the `is-context-target` highlight lands via
  // React (driven by the store's context-menu target we just set). Opening the
  // menu is otherwise a store-only mutation with no subscriber, so without this
  // the class would only appear on the NEXT incidental render (an SSE/activity
  // tick or the 12s poll). Painting it imperatively here instead is fragile: any
  // React re-render in that window recomputes the row className from frozen props
  // (contextMenuThreadId=null) and strips it — the flake the delete-thread e2e hit.
  renderThreads();
}

// `rerender` re-renders the thread list so React drops the `is-context-target`
// highlight (mirrors openThreadContextMenu). Callers that are already inside
// renderThreads() — or that render their own thread-list content immediately
// after — pass `{ rerender: false }` to avoid a redundant/re-entrant render.
function closeThreadContextMenu({ rerender = true } = {}) {
  // Only worth a re-render if a menu was actually open — Escape/blur/resize call
  // this unconditionally, and we don't want to re-render the thread list on every
  // one of those when there's no highlight to clear.
  const wasOpen = readThreadListContextMenu(state.threadListStore).threadId != null;
  state.threadListStore.getState().closeContextMenu();
  if (threadContextMenu) {
    threadContextMenu.hidden = true;
  }
  if (archiveThreadButton) {
    archiveThreadButton.disabled = false;
    archiveThreadButton.textContent = "Archive session";
  }
  if (deleteThreadButton) {
    deleteThreadButton.disabled = false;
    deleteThreadButton.textContent = "Delete permanently";
  }
  if (rerender && wasOpen) {
    renderThreads();
  }
}

async function archiveThreadFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  closeThreadContextMenu();

  if (!threadId) {
    return;
  }

  const thread = resolveActiveThread(threadId) || state.threads.find((entry) => entry.id === threadId);
  const title = thread?.name || thread?.preview || shortId(threadId);
  if (!window.confirm(`Archive "${title}" from local history?`)) {
    return;
  }

  // If this thread is the parent of hidden reviewer thread(s), ask what to do with
  // them. Reviewer threads have no archived state of their own, so the choice is
  // delete vs keep-as-normal — same prompt as permanent delete. Default (OK) deletes
  // them; Cancel keeps them as normal threads.
  const reviewerCount = countReviewerThreadsForParent(
    state.session?.reviewer_threads,
    threadId
  );
  let deleteReviewers;
  if (reviewerCount > 0) {
    deleteReviewers = window.confirm(
      `This conversation has ${reviewerCount} reviewer thread${reviewerCount === 1 ? "" : "s"}.\n\n` +
        "OK: delete the reviewer thread(s) too.\n" +
        "Cancel: keep them as normal threads (they'll appear in your thread list)."
    );
  }

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
      method: "POST",
      ...reviewerChoiceRequestInit(deleteReviewers),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to archive session");
    }

    state.threads = state.threads.filter((entry) => entry.id !== threadId);
    state.threadGroups = buildThreadGroups(state.threads);
    renderThreads();
    await loadSession("post-archive refresh");
    await loadThreads("post-archive refresh");
    logLine(payload.data?.message || `Archived local session ${shortId(threadId)}.`);
  } catch (error) {
    logLine(`Failed to archive local session: ${error.message}`);
  }
}

async function deleteThreadFromContextMenu() {
  const threadId = readThreadListContextMenu(state.threadListStore).threadId;
  closeThreadContextMenu();

  if (!threadId) {
    return;
  }

  const thread = resolveActiveThread(threadId) || state.threads.find((entry) => entry.id === threadId);
  const shouldPreserveConversation = state.viewThreadId === threadId;
  const fallbackThreadId = shouldPreserveConversation ? findAdjacentThreadId(threadId) : null;
  const title = thread?.name || thread?.preview || shortId(threadId);
  // Name the thread's own provider — the old ternary mislabeled every
  // non-Claude provider (incl. future ones) as "Codex".
  const providerName = providerLabel(thread?.provider) || "agent";
  const confirmed = window.confirm(
    `Permanently delete "${title}" from local ${providerName} storage?\n\nThis removes the local thread file and related local index/state entries. This cannot be undone.`
  );
  if (!confirmed) {
    return;
  }

  // If this thread is the parent of hidden reviewer thread(s), ask what to do with
  // them. Default (OK) deletes them too; Cancel keeps them as normal threads.
  const reviewerCount = countReviewerThreadsForParent(
    state.session?.reviewer_threads,
    threadId
  );
  let deleteReviewers;
  if (reviewerCount > 0) {
    deleteReviewers = window.confirm(
      `This conversation has ${reviewerCount} reviewer thread${reviewerCount === 1 ? "" : "s"}.\n\n` +
        "OK: delete the reviewer thread(s) too.\n" +
        "Cancel: keep them as normal threads (they'll appear in your thread list)."
    );
  }

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/delete`, {
      method: "POST",
      ...reviewerChoiceRequestInit(deleteReviewers),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to permanently delete session");
    }

    state.threads = state.threads.filter((entry) => entry.id !== threadId);
    state.threadGroups = buildThreadGroups(state.threads);
    renderThreads();
    await loadThreads("post-delete refresh");
    if (shouldPreserveConversation) {
      const canResumeFallback =
        fallbackThreadId && state.threads.some((entry) => entry.id === fallbackThreadId);
      if (canResumeFallback) {
        setThreadRoute(fallbackThreadId, { replace: true });
        await loadViewOnlyTranscript(fallbackThreadId);
      } else {
        clearThreadRoute({ replace: true });
        await loadSession("post-delete refresh");
      }
    } else {
      await loadSession("post-delete refresh");
    }
    logLine(payload.data?.message || `Deleted local session ${shortId(threadId)} permanently.`);
  } catch (error) {
    logLine(`Failed to permanently delete local session: ${error.message}`);
  }
}

function findAdjacentThreadId(threadId) {
  const index = state.threads.findIndex((entry) => entry.id === threadId);
  if (index === -1) {
    return state.threads.find((entry) => entry.id !== threadId)?.id || null;
  }

  return (
    state.threads[index + 1]?.id ||
    state.threads[index - 1]?.id ||
    state.threads.find((entry) => entry.id !== threadId)?.id ||
    null
  );
}

function metaChip(label, value) {
  return `
    <span class="meta-chip">
      <strong>${escapeHtml(label)}:</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
}

function overviewBadge(label, value) {
  return `
    <span class="overview-badge">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
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

function securityModeLabel(session) {
  if (session?.security_mode === "managed") {
    return "Managed policy";
  }
  return "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Broker-readable with audit" : "Broker-readable";
  }
  return session?.e2ee_enabled ? "End-to-end encrypted" : "Broker cannot read content";
}

function brokerStatusLabel(session) {
  if (!session?.broker_channel_id) {
    return "Disabled";
  }

  const state = session.broker_connected ? "Connected" : "Offline";
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${state} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${state} · ${channel}`;
}

function pairedDeviceCountLabel(session) {
  const count = approvedDeviceCount(session);
  return count === 0 ? "None" : `${count} paired`;
}

function approvedDeviceCount(session) {
  if (Array.isArray(session?.paired_devices)) {
    return session.paired_devices.length;
  }

  if (!Array.isArray(session?.device_records)) {
    return 0;
  }

  return session.device_records.filter((record) => record.lifecycle_state === "approved").length;
}

function formatTimestamp(seconds) {
  if (!seconds) {
    return "unknown";
  }

  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(seconds) {
  if (!seconds) {
    return "now";
  }

  const diffSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(seconds));
  if (diffSeconds < 60) {
    return "now";
  }
  if (diffSeconds < 3600) {
    return `${Math.floor(diffSeconds / 60)}m`;
  }
  if (diffSeconds < 86400) {
    return `${Math.floor(diffSeconds / 3600)}h`;
  }
  if (diffSeconds < 604800) {
    return `${Math.floor(diffSeconds / 86400)}d`;
  }
  if (diffSeconds < 2592000) {
    return `${Math.floor(diffSeconds / 604800)}w`;
  }
  if (diffSeconds < 31536000) {
    return `${Math.floor(diffSeconds / 2592000)}mo`;
  }
  return `${Math.floor(diffSeconds / 31536000)}y`;
}

function humanizeLabel(value) {
  return String(value)
    .replaceAll(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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
    text.includes("approved") ||
    text.includes("accepted") ||
    text.includes("started") ||
    text.includes("resumed") ||
    text.includes("connected") ||
    text.includes("saved")
  ) {
    return "ready";
  }

  return "neutral";
}

function shouldShowAuditEntry(entry) {
  const kind = String(entry?.kind || "").toLowerCase();
  const message = String(entry?.message || "");

  if (kind !== "codex") {
    return true;
  }

  return /approval|pair|revoke|connected|disconnected|take over|control|broker|session/i.test(message);
}

function isCurrentDeviceActiveController(session) {
  if (!session?.active_thread_id || !session.active_controller_device_id) {
    return false;
  }

  return session.active_controller_device_id === state.deviceId;
}

function canCurrentDeviceWrite(session) {
  if (!session?.active_thread_id) {
    return false;
  }

  return !session.active_controller_device_id || session.active_controller_device_id === state.deviceId;
}

function sessionControllerState(session) {
  if (!session?.active_thread_id) {
    return "none";
  }

  if (!session.active_controller_device_id) {
    return "unclaimed";
  }

  return session.active_controller_device_id === state.deviceId ? "this_device" : "other_device";
}

function controllerLabel(deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === state.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
}

function controllerStateLabel(session) {
  if (session?.view_only) {
    return "View only";
  }
  if (session?.active_thread_id && !session.active_turn_id) {
    return "Available";
  }
  switch (sessionControllerState(session)) {
    case "this_device":
      return "This device";
    case "other_device":
      return controllerLabel(session.active_controller_device_id);
    case "unclaimed":
      return "Unclaimed";
    default:
      return "None";
  }
}

function readThreadIdFromUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.get("thread") || null;
}

function setThreadRoute(threadId, options = {}) {
  const url = new URL(window.location.href);
  if (threadId) {
    url.searchParams.set("thread", threadId);
  } else {
    url.searchParams.delete("thread");
  }

  const next = url.pathname + url.search + url.hash;
  if (options.replace) {
    window.history.replaceState({}, "", next);
  } else {
    window.history.pushState({}, "", next);
  }
  state.viewThreadId = threadId || null;
}

function clearThreadRoute(options = {}) {
  setThreadRoute(null, options);
}

function isViewingConversation(session) {
  return Boolean(session?.active_thread_id && state.viewThreadId === session.active_thread_id);
}

function workspaceBasename(cwd) {
  if (!cwd) {
    return "workspace";
  }

  const trimmed = String(cwd).replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || trimmed || "workspace";
}

function shortId(value) {
  return value ? value.slice(0, 8) : "unknown";
}

function loadOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const generated = window.crypto?.randomUUID?.()
    ? window.crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, generated);
  return generated;
}

function loadApiToken() {
  return window.localStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() || "";
}

function clearStoredApiToken() {
  window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
}

function logLine(message) {
  state.clientLogLines = [{ at: Date.now(), text: message }, ...state.clientLogLines].slice(0, 400);
  renderClientLog();
}

// Refresh the relay's server logs from a session snapshot. Replaces (rather than
// appends) so repeated snapshots don't duplicate, and re-renders the merged view
// WITHOUT discarding client-originated lines (e.g. "Prompt failed: ...").
function ingestRelayLogs(entries) {
  state.relayLogLines = mapRelayLogEntries(entries);
  renderClientLog();
}

// Merge client + server log entries into the single #client-log surface, newest
// first. Server-log refreshes and client status lines previously clobbered each
// other (last writer won); merging keeps both visible. The merge/cap logic lives
// in client-log-merge.js (unit-tested); only the locale-dependent timestamp
// formatting stays here.
function renderClientLog() {
  const combined = mergeLogEntries(state.clientLogLines, state.relayLogLines).map(
    (entry) => `${new Date(entry.at).toLocaleTimeString()}  ${entry.text}`
  );
  renderClientLogLines(combined);
}

function renderClientLogLines(lines) {
  if (!clientLogRoot) {
    return;
  }

  if (clientLogRootElement !== clientLogRoot) {
    clientLogRootHandle?.unmount();
    clientLogRootHandle = createRoot(clientLogRoot);
    clientLogRootElement = clientLogRoot;
  }

  flushSync(() => {
    clientLogRootHandle.render(React.createElement(ClientLog, { lines }));
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
