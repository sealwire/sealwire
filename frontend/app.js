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
  headerOverflowButton,
  headerOverflowMenu,
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
  refreshButton,
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
  stopButton,
  threadContextMenu,
  threadsCount,
  threadsList,
  threadsRefreshButton,
  transcript,
  workspaceTitle,
  workspaceSubtitle,
} from "./local/dom.js";
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  createApiFetch,
  createAuthSession,
  deleteAuthSession,
  fetchAuthSession,
} from "./local/api.js";
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
import { ClientLog } from "./shared/client-log.js";
import {
  loadLastApprovalPolicy,
  loadLastEffort,
  saveLastApprovalPolicy,
  saveLastEffort,
} from "./shared/last-used-settings.js";
import { renderSelectOptions } from "./shared/select-options.js";
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

const DEVICE_STORAGE_KEY = "agent-relay.device-id";
const API_TOKEN_STORAGE_KEY = "agent-relay.api-token";
const CONTROL_HEARTBEAT_MS = 5000;
const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;

const state = {
  apiToken: loadApiToken(),
  authRequired: false,
  authenticated: false,
  cookieSession: false,
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  currentPairing: null,
  clientLogLines: ["Booting web client..."],
  deviceId: loadOrCreateDeviceId(),
  defaultsSeeded: false,
  selectedCwd: "",
  session: null,
  viewThreadId: readThreadIdFromUrl(),
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
// gerund verbs every 2.5s so the badge animates and proves the UI is live.
// The timer is fully driven by phase transitions reported in session
// snapshots — when phase clears we tear it down.

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
        refreshStatusBadgeForVerb();
      }, VERB_CYCLE_MS);
    }
  } else if (verbTimer) {
    clearInterval(verbTimer);
    verbTimer = null;
    currentProgressVerb = null;
    verbCycler.reset();
  }
}

function refreshStatusBadgeForVerb() {
  const session = state.session;
  if (!session || !statusBadge) return;
  const approval = session.pending_approvals?.[0] || null;
  if (approval) return;
  if (!session.provider_connected) return;
  if ((session.pending_pairing_requests || []).length > 0) return;
  if (!session.current_phase) return;

  if (isProgressStalled(session)) {
    statusBadge.textContent = "Stalled?";
    statusBadge.className = "status-badge status-badge-alert";
  } else {
    statusBadge.textContent = sessionStatusLabel(session, approval);
    statusBadge.className = "status-badge status-badge-ready";
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
  updateSessionSettings(payload) {
    return controller?.updateSessionSettings(payload);
  },
});

// Wrap renderer.renderSession so every full render also reconciles the
// liveness verb timer. Patching the object (rather than only the local
// destructured binding) ensures controller callbacks below also flow
// through the wrapper.
const _baseRenderSession = renderer.renderSession;
renderer.renderSession = function wrappedRenderSession(session) {
  _baseRenderSession(session);
  syncVerbTimer(session);
};

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
    return appShell?.dataset.view === "conversation";
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
  renderPendingPairingRequests(state.session?.pending_pairing_requests || []);
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

headerOverflowButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (headerOverflowMenu) {
    state.localUiStore.getState().toggleHeaderOverflow();
    headerOverflowMenu.hidden = !readLocalUiState(state.localUiStore).headerOverflowOpen;
  }
});

document.addEventListener("click", () => {
  if (headerOverflowMenu && !headerOverflowMenu.hidden) {
    state.localUiStore.getState().closeHeaderOverflow();
    headerOverflowMenu.hidden = true;
  }
});

refreshButton.addEventListener("click", () => {
  void loadSession("manual refresh");
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

directoryForm.addEventListener("submit", (event) => {
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

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
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
  const models = state.session?.available_models || [];
  syncEffortSuggestions(messageEffort, models, messageModel.value, messageEffort.value, state.session?.provider || "");
  const provider = state.session?.provider;
  if (provider && messageEffort?.value) saveLastEffort(provider, messageEffort.value);
});

messageEffort?.addEventListener("change", () => {
  const provider = state.session?.provider;
  if (provider && messageEffort.value) saveLastEffort(provider, messageEffort.value);
});

stopButton?.addEventListener("click", () => {
  void stopActiveTurn();
});

transcript.addEventListener("click", (event) => {
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

  const resumeThreadButton = event.target.closest("[data-resume-thread-id]");
  if (resumeThreadButton) {
    const threadId = resumeThreadButton.dataset.resumeThreadId;
    if (threadId) {
      void resumeSession(threadId);
    }
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
  onLoad: () => controller?.maybeLoadOlderTranscript(),
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

  syncModelSuggestions(messageModel, session.available_models || [], messageModel?.value || session.model);

  if (!state.defaultsSeeded) {
    if (messageModel) {
      messageModel.value = session.model || defaultModelForProvider(activeProvider);
    }
    messageEffort.value = session.reasoning_effort;
    state.defaultsSeeded = true;
  }

  syncEffortSuggestions(
    messageEffort,
    session.available_models || [],
    messageModel?.value || session.model,
    messageEffort?.value || session.reasoning_effort,
    session.provider || ""
  );

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

function syncModelSuggestions(select, models, selectedModel) {
  if (!select) {
    return;
  }

  const currentValue = selectedModel || select.value || "gpt-5.4";
  const options = [...(models || [])];
  if (currentValue && !options.some((model) => model.model === currentValue)) {
    options.unshift({
      model: currentValue,
      display_name: currentValue,
    });
  }

  renderSelectOptions(
    select,
    options.map((model) => ({
      label: model.display_name,
      value: model.model,
    })),
    currentValue
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

  threadsList
    .querySelectorAll(".conversation-item")
    .forEach((item) => item.classList.toggle("is-context-target", item.dataset.threadId === threadId));
}

function closeThreadContextMenu() {
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
  threadsList
    .querySelectorAll(".conversation-item")
    .forEach((item) => item.classList.remove("is-context-target"));
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

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/archive`, {
      method: "POST",
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
  const providerLabel = thread?.provider === "claude_code" ? "Claude Code" : "Codex";
  const confirmed = window.confirm(
    `Permanently delete "${title}" from local ${providerLabel} storage?\n\nThis removes the local thread file and related local index/state entries. This cannot be undone.`
  );
  if (!confirmed) {
    return;
  }

  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/delete`, {
      method: "POST",
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
        await resumeSession(fallbackThreadId);
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

  const phaseLabel = progressPhaseLabel(
    session.current_phase,
    session.current_tool,
    currentProgressVerb,
  );
  if (phaseLabel) {
    return phaseLabel;
  }

  if (!session.active_controller_device_id && (session.current_status || "idle") === "idle") {
    return "Live";
  }

  return humanizeLabel(session.current_status || "ready");
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
  const time = new Date().toLocaleTimeString();
  state.clientLogLines = [`${time}  ${message}`, ...state.clientLogLines].slice(0, 400);
  renderClientLogLines(state.clientLogLines);
}

let clientLogRootHandle = null;
let clientLogRootElement = null;

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
