import {
  allowedRootsForm,
  allowedRootsInput,
  allowedRootsList,
  allowedRootsSummary,
  approvalPolicyInput,
  apiTokenInput,
  apiTokenLabel,
  appShell,
  applyTokenButton,
  archiveThreadButton,
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
  modelInput,
  openLaunchSettingsButton,
  openSecurityConsoleButton,
  openSecurityHeaderButton,
  openSecurityModalBtn,
  openSessionDetailsButton,
  overviewSecurityBadges,
  overviewSecurityCopy,
  overviewSecurityTitle,
  overviewSessionBadges,
  overviewSessionCopy,
  overviewSessionTitle,
  pairedDevicesList,
  pendingPairingsList,
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
  startPairingButton,
  startPromptInput,
  startSessionButton,
  statusBadge,
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
  configureSecurityRenderers,
  renderAllowedRoots,
  renderDeviceRecords,
  renderPairingPanel,
  renderPendingPairingRequests,
} from "./local/render-security.js";
import { createSessionRenderer } from "./local/render-session.js";
import { createSessionController } from "./local/session-controller.js";
import { openSessionStream, sessionStreamUrl } from "./session-stream.js";
import {
  buildThreadGroups,
} from "./shared/thread-groups.js";
import { mountBuildBadge } from "./shared/build-badge.js";
import { ClientLog } from "./shared/client-log.js";
import { renderSelectOptions } from "./shared/select-options.js";

const DEVICE_STORAGE_KEY = "agent-relay.device-id";
const API_TOKEN_STORAGE_KEY = "agent-relay.api-token";
const CONTROL_HEARTBEAT_MS = 5000;
const LEASE_EXPIRY_REFRESH_SKEW_MS = 250;

const state = {
  apiToken: loadApiToken(),
  authRequired: false,
  authenticated: false,
  allowedRootsDraftDirty: false,
  cookieSession: false,
  controllerHeartbeatTimer: null,
  controllerLeaseRefreshTimer: null,
  currentApprovalId: null,
  currentPairing: null,
  clientLogLines: ["Booting web client..."],
  deviceId: loadOrCreateDeviceId(),
  defaultsSeeded: false,
  pendingPairingIds: [],
  selectedCwd: "",
  session: null,
  viewThreadId: readThreadIdFromUrl(),
  sessionStream: null,
  streamConnected: false,
  transcriptDetailEntries: new Map(),
  transcriptDetailThreadId: null,
  transcriptExpandedItemIds: new Set(),
  transcriptHydrationBaseSnapshot: null,
  transcriptHydrationEntries: new Map(),
  transcriptHydrationOrder: [],
  transcriptHydrationOlderCursor: null,
  transcriptHydrationPromise: null,
  transcriptHydrationSignature: null,
  transcriptHydrationStatus: "idle",
  transcriptHydrationTailReady: false,
  transcriptHydrationThreadId: null,
  transcriptLoadingItemIds: new Set(),
  transcriptPreserveScroll: false,
  pendingThreadHistoryScrollTop: null,
  threadGroups: [],
  threadHistoryScrollTop: 0,
  streamReconnectTimer: null,
  sessionPollTimer: null,
  threadContextMenuThreadId: null,
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

void mountBuildBadge({
  surface: "relay",
});

const renderer = createSessionRenderer({
  state,
  renderAllowedRoots,
  renderPairingPanel,
  renderDeviceRecords,
  renderPendingPairingRequests,
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
});

controller = createSessionController({
  state,
  apiFetch,
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
  startPairing,
  startSession,
  submitDecision,
  takeOverControl,
  toggleTranscriptEntry,
  applyFileChange,
} = controller;

threadsList?.addEventListener("scroll", () => {
  state.threadHistoryScrollTop = threadsList.scrollTop;
});

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuthSession();
});

startPairingButton.addEventListener("click", () => {
  void startPairing();
});

function openSecurityModal() {
  state.allowedRootsDraftDirty = false;
  renderAllowedRoots(state.session?.allowed_roots || [], {
    draftDirty: state.allowedRootsDraftDirty,
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
  state.allowedRootsDraftDirty = true;
});

allowedRootsForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveAllowedRoots();
});

headerOverflowButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (headerOverflowMenu) {
    headerOverflowMenu.hidden = !headerOverflowMenu.hidden;
  }
});

document.addEventListener("click", () => {
  if (headerOverflowMenu && !headerOverflowMenu.hidden) {
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

startSessionButton.addEventListener("click", () => {
  void startSession();
});

resumeLatestButton?.addEventListener("click", () => {
  void resumeLatestSession();
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

transcript.addEventListener("click", (event) => {
  const approvalButton = event.target.closest("[data-approval-decision]");
  if (approvalButton) {
    void submitDecision(
      approvalButton.dataset.approvalDecision,
      approvalButton.dataset.approvalScope || "once"
    );
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

transcript.addEventListener("scroll", () => {
  void controller?.maybeLoadOlderTranscript();
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
  syncModelSuggestions(modelInput, session.available_models || [], session.model);

  if (!state.defaultsSeeded) {
    if (!modelInput.value || modelInput.value === "gpt-5-codex") {
      modelInput.value = session.model || "gpt-5.4";
    }
    approvalPolicyInput.value = session.approval_policy;
    sandboxInput.value = session.sandbox;
    startEffortInput.value = session.reasoning_effort;
    messageEffort.value = session.reasoning_effort;
    state.defaultsSeeded = true;
  }

  if (!state.selectedCwd && session.current_cwd) {
    setSelectedCwd(session.current_cwd);
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

function setSelectedCwd(cwd) {
  state.selectedCwd = cwd;
  cwdInput.value = cwd;
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

  state.threadContextMenuThreadId = threadId;
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
  state.threadContextMenuThreadId = null;
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
  const threadId = state.threadContextMenuThreadId;
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
  const threadId = state.threadContextMenuThreadId;
  closeThreadContextMenu();

  if (!threadId) {
    return;
  }

  const thread = resolveActiveThread(threadId) || state.threads.find((entry) => entry.id === threadId);
  const title = thread?.name || thread?.preview || shortId(threadId);
  const confirmed = window.confirm(
    `Permanently delete "${title}" from local Codex storage?\n\nThis removes the local thread file and related local index/state entries. This cannot be undone.`
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
    await loadSession("post-delete refresh");
    await loadThreads("post-delete refresh");
    logLine(payload.data?.message || `Deleted local session ${shortId(threadId)} permanently.`);
  } catch (error) {
    logLine(`Failed to permanently delete local session: ${error.message}`);
  }
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

  if (!session?.codex_connected) {
    return "Offline";
  }

  if (!session?.active_thread_id) {
    return "Standby";
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
