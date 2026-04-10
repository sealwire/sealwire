import { openSessionStream, sessionStreamUrl } from "./session-stream.js";
import { svgDataUrl } from "./svg.js";

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
  deviceId: loadOrCreateDeviceId(),
  defaultsSeeded: false,
  pendingPairingIds: [],
  selectedCwd: "",
  session: null,
  viewThreadId: readThreadIdFromUrl(),
  sessionStream: null,
  streamConnected: false,
  pendingThreadHistoryScrollTop: null,
  threadGroups: [],
  threadHistoryScrollTop: 0,
  streamReconnectTimer: null,
  sessionPollTimer: null,
  threadContextMenuThreadId: null,
  threads: [],
  threadsPollTimer: null,
};

const appShell = document.querySelector(".app-shell");
const transcript = document.querySelector("#transcript");
const clientLog = document.querySelector("#client-log");
const connectionForm = document.querySelector("#connection-form");
const apiTokenLabel = connectionForm.querySelector("label[for='api-token-input']");
const apiTokenInput = document.querySelector("#api-token-input");
const applyTokenButton = document.querySelector("#apply-token-button");
const startPairingButton = document.querySelector("#start-pairing-button");
const openSecurityModalBtn = document.querySelector("#open-security-modal");
const openSecurityConsoleButton = document.querySelector("#open-security-console");
const closeSecurityModalBtn = document.querySelector("#close-security-modal");
const securityModal = document.querySelector("#security-modal");
const pairingPanel = document.querySelector("#pairing-panel");
const pairingQr = document.querySelector("#pairing-qr");
const pairingExpiry = document.querySelector("#pairing-expiry");
const pairingLinkInput = document.querySelector("#pairing-link-input");
const copyPairingLinkButton = document.querySelector("#copy-pairing-link-button");
const allowedRootsForm = document.querySelector("#allowed-roots-form");
const allowedRootsInput = document.querySelector("#allowed-roots-input");
const saveAllowedRootsButton = document.querySelector("#save-allowed-roots-button");
const allowedRootsSummary = document.querySelector("#allowed-roots-summary");
const allowedRootsList = document.querySelector("#allowed-roots-list");
const pendingPairingsList = document.querySelector("#pending-pairings-list");
const refreshButton = document.querySelector("#refresh-button");
const threadsRefreshButton = document.querySelector("#threads-refresh-button");
const sessionHistoryDrawer = document.querySelector(".sidebar-drawer");
const goConsoleHomeSidebarButton = document.querySelector("#go-console-home-sidebar");
const sendButton = document.querySelector("#send-button");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const messageEffort = document.querySelector("#message-effort");
const directoryForm = document.querySelector("#directory-form");
const loadDirectoryButton = document.querySelector("#load-directory-button");
const startSessionButton = document.querySelector("#start-session-button");
const resumeLatestButton = document.querySelector("#resume-latest-button");
const openLaunchSettingsButton = document.querySelector("#open-launch-settings");
const launchSettingsModal = document.querySelector("#launch-settings-modal");
const closeLaunchSettingsModalButton = document.querySelector("#close-launch-settings-modal");
const cwdInput = document.querySelector("#cwd-input");
const startPromptInput = document.querySelector("#start-prompt");
const modelInput = document.querySelector("#model-input");
const approvalPolicyInput = document.querySelector("#approval-policy-input");
const sandboxInput = document.querySelector("#sandbox-input");
const startEffortInput = document.querySelector("#start-effort");
const threadsList = document.querySelector("#threads-list");
const threadsCount = document.querySelector("#threads-count");
const threadContextMenu = document.querySelector("#thread-context-menu");
const archiveThreadButton = document.querySelector("#archive-thread-button");
const deleteThreadButton = document.querySelector("#delete-thread-button");
const pairedDevicesList = document.querySelector("#paired-devices-list");
const chatShell = document.querySelector(".chat-shell");
const workspaceTitle = document.querySelector("#workspace-title");
const workspaceSubtitle = document.querySelector("#workspace-subtitle");
const statusBadge = document.querySelector("#status-badge");
const goConsoleHomeButton = document.querySelector("#go-console-home");
const openSessionDetailsButton = document.querySelector("#open-session-details");
const sessionDetailsModal = document.querySelector("#session-details-modal");
const closeSessionDetailsModalButton = document.querySelector("#close-session-details-modal");
const sessionMeta = document.querySelector("#session-meta");
const overviewSessionTitle = document.querySelector("#overview-session-title");
const overviewSessionCopy = document.querySelector("#overview-session-copy");
const overviewSessionBadges = document.querySelector("#overview-session-badges");
const overviewSecurityTitle = document.querySelector("#overview-security-title");
const overviewSecurityCopy = document.querySelector("#overview-security-copy");
const overviewSecurityBadges = document.querySelector("#overview-security-badges");
const liveSurfacesList = document.querySelector("#live-surfaces-list");
const liveSurfacesSummary = document.querySelector("#live-surfaces-summary");
const auditTimeline = document.querySelector("#audit-timeline");
const auditSummary = document.querySelector("#audit-summary");
const controlBanner = document.querySelector("#control-banner");
const controlSummary = document.querySelector("#control-summary");
const controlHint = document.querySelector("#control-hint");
const takeOverButton = document.querySelector("#take-over-button");

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
  renderAllowedRoots(state.session?.allowed_roots || []);
  renderPairingPanel();
  renderDeviceRecords(state.session?.device_records || []);
  renderPendingPairingRequests(state.session?.pending_pairing_requests || []);
  securityModal?.showModal();
}

openSecurityModalBtn?.addEventListener("click", openSecurityModal);
openSecurityConsoleButton?.addEventListener("click", openSecurityModal);

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

takeOverButton.addEventListener("click", () => {
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
    const response = await fetch("/api/auth/session", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to check local auth session");
    }

    applyAuthSessionState(payload.data);
    return payload.data;
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
    const headers = new Headers({
      "Content-Type": "application/json",
    });
    applyCsrfHeader(headers, "POST");
    const response = await fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({ token }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to create local auth session");
    }

    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(payload.data);
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
    const headers = new Headers();
    applyCsrfHeader(headers, "DELETE");
    const response = await fetch("/api/auth/session", {
      method: "DELETE",
      credentials: "same-origin",
      headers,
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to clear local auth session");
    }

    clearStoredApiToken();
    state.apiToken = "";
    apiTokenInput.value = "";
    applyAuthSessionState(payload.data);
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

async function loadSession(reason) {
  logLine(`Fetching session snapshot (${reason})`);

  try {
    const response = await apiFetch("/api/session");
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load session");
    }

    seedDefaults(payload.data);
    renderSession(payload.data);
  } catch (error) {
    if (state.authRequired && !state.authenticated) {
      renderAuthRequiredState("Enter RELAY_API_TOKEN to access the local relay.");
      logLine(`Session fetch blocked by local auth: ${error.message}`);
      return;
    }

    state.session = null;
    cancelControllerHeartbeat();
    cancelControllerLeaseRefresh();
    renderOverview(null, null, null, error.message);
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-badge-offline";
    sessionMeta.innerHTML = `<span class="meta-empty">${escapeHtml(error.message)}</span>`;
    transcript.innerHTML = `
      <div class="thread-empty">
        <h2>Relay unavailable</h2>
        <p>${escapeHtml(error.message)}</p>
      </div>
    `;
    logLine(`Session fetch failed: ${error.message}`);
  } finally {
    if (!state.streamConnected) {
      scheduleSessionPoll();
    }
  }
}

async function loadThreads(reason) {
  threadsCount.textContent = "Loading...";
  threadsCount.title = "";
  logLine(`Fetching thread list across saved workspaces (${reason})`);

  try {
    const url = new URL("/api/threads", window.location.origin);
    url.searchParams.set("limit", "120");

    const response = await apiFetch(url);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load threads");
    }

    state.threadGroups = groupThreadsByWorkspace(payload.data.threads || []);
    state.threads = state.threadGroups.flatMap((group) => group.threads);
    renderThreads();
    renderOverview(
      state.session,
      resolveActiveThread(state.session?.active_thread_id),
      state.session?.pending_approvals?.[0] || null
    );
  } catch (error) {
    if (state.authRequired && !state.authenticated) {
      state.threadGroups = [];
      state.threads = [];
      threadsCount.textContent = "Sign in";
      threadsList.innerHTML = `<p class="sidebar-empty">Enter RELAY_API_TOKEN to load threads.</p>`;
      logLine(`Thread fetch blocked by local auth: ${error.message}`);
      return;
    }

    state.threadGroups = [];
    state.threads = [];
    threadsCount.textContent = "Error";
    threadsList.innerHTML = `<p class="sidebar-empty">${escapeHtml(error.message)}</p>`;
    logLine(`Thread fetch failed: ${error.message}`);
  } finally {
    scheduleThreadsPoll();
  }
}

async function startSession() {
  const cwd = cwdInput.value.trim();

  if (!cwd) {
    logLine("Choose a directory before starting a session.");
    cwdInput.focus();
    return;
  }

  setSelectedCwd(cwd);
  setStartControlsBusy(true);
  logLine(`Starting a new Codex thread in ${cwd}`);

  try {
    const response = await apiFetch("/api/session/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cwd,
        initial_prompt: startPromptInput.value.trim() || null,
        model: modelInput.value.trim() || null,
        approval_policy: approvalPolicyInput.value,
        sandbox: sandboxInput.value,
        effort: startEffortInput.value,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to start session");
    }

    state.defaultsSeeded = false;
    await runViewTransition(() => {
      setSelectedCwd(payload.data.current_cwd || cwd);
      setThreadRoute(payload.data.active_thread_id || null);
      seedDefaults(payload.data);
      renderSession(payload.data);
    });
    if (canCurrentDeviceWrite(payload.data)) {
      messageInput.focus();
    }
    await loadThreads("post-start refresh");
    logLine("Started a new Codex thread");
  } catch (error) {
    logLine(`Session start failed: ${error.message}`);
  } finally {
    setStartControlsBusy(false);
  }
}

async function resumeSession(threadId) {
  logLine(`Resuming thread ${threadId}`);
  state.pendingThreadHistoryScrollTop = threadsList?.scrollTop || state.threadHistoryScrollTop || 0;

  try {
    const response = await apiFetch("/api/session/resume", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        thread_id: threadId,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to resume session");
    }

    state.defaultsSeeded = false;
    await runViewTransition(() => {
      setSelectedCwd(payload.data.current_cwd || state.selectedCwd);
      setThreadRoute(payload.data.active_thread_id || threadId);
      seedDefaults(payload.data);
      renderSession(payload.data);
    });
    if (canCurrentDeviceWrite(payload.data)) {
      messageInput.focus();
    }
    logLine(`Resumed thread ${threadId}`);
  } catch (error) {
    logLine(`Resume failed: ${error.message}`);
  } finally {
    state.pendingThreadHistoryScrollTop = null;
  }
}

async function resumeLatestSession() {
  const cwd = cwdInput.value.trim();

  if (cwd && cwd !== state.selectedCwd) {
    setSelectedCwd(cwd);
    await loadThreads("continue latest");
  } else if (!state.threads.length) {
    await loadThreads("continue latest");
  }

  const latestThread = findLatestThread(cwd || state.selectedCwd);
  if (!latestThread) {
    logLine(
      cwd || state.selectedCwd
        ? "No recent sessions were found for this workspace."
        : "No recent sessions were found."
    );
    return;
  }

  await resumeSession(latestThread.id);
}

async function sendMessage() {
  const text = messageInput.value.trim();

  if (!text) {
    logLine("Message is empty.");
    return;
  }

  sendButton.disabled = true;
  logLine("Sending prompt to Codex");

  try {
    const response = await apiFetch("/api/session/message", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        effort: messageEffort.value,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to send prompt");
    }

    messageInput.value = "";
    renderSession(payload.data);
    logLine("Prompt accepted by relay");
  } catch (error) {
    logLine(`Prompt failed: ${error.message}`);
  } finally {
    sendButton.disabled = false;
  }
}

async function startPairing() {
  startPairingButton.disabled = true;
  logLine("Creating a broker pairing ticket.");

  try {
    const response = await apiFetch("/api/pairing/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to start pairing");
    }

    state.currentPairing = payload.data;
    renderPairingPanel();
    logLine(`Pairing ticket ${payload.data.pairing_id} is ready.`);
  } catch (error) {
    logLine(`Pairing failed: ${error.message}`);
  } finally {
    startPairingButton.disabled = false;
  }
}

async function copyPairingLink() {
  const pairingUrl = state.currentPairing?.pairing_url;
  if (!pairingUrl) {
    logLine("No pairing link is available yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(pairingUrl);
    logLine("Copied pairing link to clipboard.");
  } catch (error) {
    pairingLinkInput.focus();
    pairingLinkInput.select();
    logLine(`Clipboard copy failed: ${error.message}`);
  }
}

async function revokePairedDevice(deviceId) {
  if (!deviceId) {
    return;
  }

  if (!window.confirm(`Revoke paired device ${deviceId}?`)) {
    return;
  }

  logLine(`Revoking paired device ${shortId(deviceId)}.`);

  try {
    const response = await apiFetch(`/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to revoke paired device");
    }

    await loadSession("post-device-revoke refresh");
    logLine(`Revoked paired device ${shortId(deviceId)}.`);
  } catch (error) {
    logLine(`Revoke failed: ${error.message}`);
  }
}

async function revokeOtherDevices(keepDeviceId) {
  if (!keepDeviceId) {
    return;
  }

  if (!window.confirm(`Keep ${keepDeviceId} and revoke every other paired device?`)) {
    return;
  }

  logLine(`Keeping ${shortId(keepDeviceId)} and revoking every other paired device.`);

  try {
    const response = await apiFetch(
      `/api/devices/${encodeURIComponent(keepDeviceId)}/revoke-others`,
      {
        method: "POST",
      }
    );
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to revoke other paired devices");
    }

    await loadSession("post-bulk-device-revoke refresh");
    logLine(
      payload.data.revoked_count > 0
        ? `Revoked ${payload.data.revoked_count} other device(s); kept ${shortId(keepDeviceId)}.`
        : `No other paired devices were active; kept ${shortId(keepDeviceId)}.`
    );
  } catch (error) {
    logLine(`Bulk revoke failed: ${error.message}`);
  }
}

async function decidePairingRequest(pairingId, decision) {
  if (!pairingId || !decision) {
    return;
  }

  logLine(`Submitting ${decision} for pairing ${shortId(pairingId)}.`);

  try {
    const response = await apiFetch(
      `/api/pairings/${encodeURIComponent(pairingId)}/decision`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision }),
      }
    );
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Pairing decision failed");
    }

    logLine(payload.data.message);
    await loadSession("post-pairing-decision refresh");
  } catch (error) {
    logLine(`Pairing decision failed: ${error.message}`);
  }
}

async function takeOverControl() {
  if (!state.session?.active_thread_id) {
    logLine("There is no active session to take over.");
    return;
  }

  takeOverButton.disabled = true;
  logLine(`Taking control from device ${shortId(state.deviceId)}`);

  try {
    const response = await apiFetch("/api/session/take-over", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to take control");
    }

    renderSession(payload.data);
    messageInput.focus();
    logLine("This device now has control.");
  } catch (error) {
    logLine(`Take over failed: ${error.message}`);
  } finally {
    takeOverButton.disabled = false;
  }
}

async function submitDecision(decision, scope) {
  if (!state.currentApprovalId) {
    logLine("No pending approval to submit.");
    return;
  }

  logLine(`Submitting ${decision} for ${state.currentApprovalId}`);

  try {
    const response = await apiFetch(`/api/approvals/${encodeURIComponent(state.currentApprovalId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        decision,
        scope,
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Approval submission failed");
    }

    logLine(payload.data.message);
    await loadSession("post-decision refresh");
  } catch (error) {
    logLine(`Approval failed: ${error.message}`);
  }
}

function renderSession(session) {
  state.session = session;

  const approval = session.pending_approvals[0] || null;
  const pendingPairings = session.pending_pairing_requests || [];
  const activeThread = resolveActiveThread(session.active_thread_id);
  const hasActiveSession = Boolean(session.active_thread_id);
  const viewingConversation = isViewingConversation(session);
  const canWrite = canCurrentDeviceWrite(session);
  const workspace = session.current_cwd || state.selectedCwd || "";
  const workspaceName = workspace ? workspaceBasename(workspace) : "";
  const viewingSessionDetails = Boolean(sessionDetailsModal?.open);
  const viewingSecurityDetails = Boolean(securityModal?.open);
  state.currentApprovalId = approval?.request_id || null;

  workspaceTitle.textContent = workspaceName || "Relay console";
  if (viewingConversation && session.active_thread_id) {
    const threadLabel = activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
    workspaceSubtitle.textContent = `Live thread: ${threadLabel}`;
  } else if (session.active_thread_id) {
    const threadLabel = activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
    workspaceSubtitle.textContent = `A live session is running in ${workspaceName || "this workspace"}. Open ${threadLabel} only when you want the conversation view.`;
  } else if (workspace) {
    workspaceSubtitle.textContent =
      "Relay is standing by in this workspace. Watch control, trust, and audit state here before starting or resuming.";
  } else {
    workspaceSubtitle.textContent =
      "Choose a workspace to bring the relay into focus, then use this page as the local control console.";
  }

  if (chatShell) {
    chatShell.dataset.view = viewingConversation ? "conversation" : "console";
  }
  if (appShell) {
    appShell.dataset.view = viewingConversation ? "conversation" : "console";
  }
  if (sessionHistoryDrawer) {
    sessionHistoryDrawer.open = viewingConversation;
  }

  syncThreadHistoryScroll();

  if (approval) {
    statusBadge.textContent = "Approval required";
    statusBadge.className = "status-badge status-badge-alert";
  } else if (pendingPairings.length > 0) {
    statusBadge.textContent =
      pendingPairings.length === 1 ? "Pairing request" : `${pendingPairings.length} pairing requests`;
    statusBadge.className = "status-badge status-badge-alert";
  } else if (!session.codex_connected) {
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-badge-offline";
  } else {
    statusBadge.textContent = sessionStatusLabel(session, approval);
    statusBadge.className = "status-badge status-badge-ready";
  }

  if (!viewingConversation) {
    renderOverview(session, activeThread, approval);
    renderLiveSurfaces(session, activeThread);
    renderAuditTimeline(session.logs || []);
  }
  if (!viewingConversation || viewingSessionDetails) {
    renderSessionMeta(session);
  }
  if (!viewingConversation || viewingSecurityDetails) {
    renderAllowedRoots(session.allowed_roots || []);
    renderPairingPanel();
    renderDeviceRecords(session.device_records || []);
    renderPendingPairingRequests(pendingPairings);
  }
  announceNewPendingPairings(pendingPairings);
  renderControlBanner(session);
  renderTranscript(session, approval);
  renderLogs(session.logs);
  syncThreadSelection();
  syncThreadHistoryScroll();
  restoreThreadHistoryScroll();
  scheduleControllerHeartbeat(session);
  scheduleControllerLeaseRefresh(session);

  openSessionDetailsButton.disabled = false;
  if (goConsoleHomeButton) {
    goConsoleHomeButton.hidden = !viewingConversation;
  }
  if (goConsoleHomeSidebarButton) {
    goConsoleHomeSidebarButton.hidden = !viewingConversation;
  }
  messageForm.hidden = !viewingConversation;
  sendButton.disabled = !hasActiveSession || !canWrite || !viewingConversation;
  messageInput.disabled = !hasActiveSession || !canWrite || !viewingConversation;
  messageInput.placeholder = !hasActiveSession
    ? "Start or resume a session first."
    : !viewingConversation
      ? "Open the thread page to send a message."
    : canWrite
      ? "Message Codex..."
      : "Another device has control. Take over to reply.";
}

function announceNewPendingPairings(requests) {
  const pendingIds = requests.map((request) => request.pairing_id);
  const newRequests = requests.filter((request) => !state.pendingPairingIds.includes(request.pairing_id));
  state.pendingPairingIds = pendingIds;

  if (!newRequests.length) {
    return;
  }

  const labels = newRequests.map((request) => request.label || shortId(request.device_id));
  const summary =
    labels.length === 1 ? labels[0] : `${labels.length} devices`;
  logLine(`Local pairing approval required for ${summary}.`);
}

function renderPairingPanel() {
  const pairing = state.currentPairing;
  pairingPanel.hidden = !pairing;

  if (!pairing) {
    pairingQr.replaceChildren();
    pairingLinkInput.value = "";
    pairingExpiry.textContent = "Pairing ticket not created yet.";
    return;
  }

  const qrImage = document.createElement("img");
  qrImage.alt = "Pairing QR code";
  qrImage.className = "pairing-qr-image";
  qrImage.src = svgDataUrl(pairing.pairing_qr_svg);
  pairingQr.replaceChildren(qrImage);
  pairingLinkInput.value = pairing.pairing_url;
  pairingExpiry.textContent = `Expires ${formatTimestamp(pairing.expires_at)}`;
}

function renderAllowedRoots(roots) {
  const configuredRoots = Array.isArray(roots) ? roots : [];

  if (!state.allowedRootsDraftDirty && allowedRootsInput) {
    allowedRootsInput.value = configuredRoots.join("\n");
  }

  if (!configuredRoots.length) {
    allowedRootsSummary.textContent =
      "This relay is currently unrestricted. Any device can start or resume sessions in any workspace.";
    allowedRootsList.innerHTML =
      `<p class="sidebar-empty">No workspace restrictions are configured.</p>`;
    return;
  }

  allowedRootsSummary.textContent =
    configuredRoots.length === 1
      ? "Every device on this relay is limited to one root directory."
      : `Every device on this relay is limited to ${configuredRoots.length} root directories.`;
  allowedRootsList.innerHTML = configuredRoots
    .map((root) => {
      const name = workspaceBasename(root) || root;
      return `
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <div class="paired-device-heading">
              <strong>${escapeHtml(name)}</strong>
              <span class="device-state-badge device-state-approved">Allowed root</span>
            </div>
            <p class="paired-device-meta paired-device-id">${escapeHtml(root)}</p>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderDeviceRecords(records) {
  if (!records.length) {
    pairedDevicesList.innerHTML = `<p class="sidebar-empty">No remote devices have touched this relay yet.</p>`;
    return;
  }

  const activeRecords = records.filter((r) => r.lifecycle_state !== "revoked");
  const revokedRecords = records.filter((r) => r.lifecycle_state === "revoked");

  const renderCard = (record) => {
    const lastSeen = record.last_seen_at ? formatTimestamp(record.last_seen_at) : "Never";
    const lastPeer = record.last_peer_id ? shortId(record.last_peer_id) : "None";
    const fingerprint = record.fingerprint || "Unavailable";
    const canManage = record.lifecycle_state === "approved";
    const ticketExpiry = formatBrokerJoinTicketExpiry(
      record.lifecycle_state,
      record.broker_join_ticket_expires_at
    );

    return `
      <article class="paired-device-card">
        <div class="paired-device-copy">
          <div class="paired-device-heading">
            <strong>${escapeHtml(record.label)}</strong>
            <span class="device-state-badge ${deviceLifecycleBadgeClass(record.lifecycle_state)}">${escapeHtml(deviceLifecycleLabel(record.lifecycle_state))}</span>
          </div>
          <p class="paired-device-meta paired-device-id">${escapeHtml(record.device_id)}</p>
          <dl class="paired-device-fields">
            <div class="paired-device-field">
              <dt>Last Seen</dt>
              <dd>${escapeHtml(lastSeen)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>Last Peer</dt>
              <dd>${escapeHtml(lastPeer)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>Broker Ticket</dt>
              <dd>${escapeHtml(ticketExpiry)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>Fingerprint</dt>
              <dd class="paired-device-fingerprint">${escapeHtml(fingerprint)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>State Updated</dt>
              <dd>${escapeHtml(formatTimestamp(record.state_changed_at))}</dd>
            </div>
          </dl>
        </div>
        ${
          canManage
            ? `
              <div class="paired-device-actions">
                <button
                  class="approval-button"
                  type="button"
                  data-revoke-others-except-device-id="${escapeHtml(record.device_id)}"
                >
                  Keep Only This
                </button>
                <button
                  class="approval-button approval-button-danger"
                  type="button"
                  data-revoke-device-id="${escapeHtml(record.device_id)}"
                >
                  Revoke
                </button>
              </div>
            `
            : ""
        }
      </article>
    `;
  };

  let html = "";
  if (activeRecords.length) {
    html += activeRecords.map(renderCard).join("");
  } else if (!revokedRecords.length) {
    html += `<p class="sidebar-empty">No active devices.</p>`;
  }

  if (revokedRecords.length) {
    html += `
      <details class="revoked-drawer">
        <summary>${revokedRecords.length} Revoked Device${revokedRecords.length === 1 ? "" : "s"}</summary>
        <div class="revoked-devices-nested">
          ${revokedRecords.map(renderCard).join("")}
        </div>
      </details>
    `;
  }

  pairedDevicesList.innerHTML = html;
}

function renderPendingPairingRequests(requests) {
  if (!requests.length) {
    pendingPairingsList.innerHTML =
      `<p class="sidebar-empty">No devices are waiting for local approval.</p>`;
    return;
  }

  pendingPairingsList.innerHTML = requests
    .map((request) => {
      return `
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <div class="paired-device-heading">
              <strong>${escapeHtml(request.label)}</strong>
              <span class="device-state-badge ${deviceLifecycleBadgeClass(request.lifecycle_state)}">${escapeHtml(deviceLifecycleLabel(request.lifecycle_state))}</span>
            </div>
            <p class="paired-device-meta">${escapeHtml(shortId(request.device_id))} · requested ${escapeHtml(formatTimestamp(request.requested_at))}</p>
            <p class="paired-device-meta">Broker peer ${escapeHtml(shortId(request.broker_peer_id))}</p>
            <p class="paired-device-meta">Fingerprint ${escapeHtml(request.fingerprint || "Unavailable")}</p>
          </div>
          <div class="paired-device-actions">
            <button
              class="approval-button approval-button-primary"
              type="button"
              data-pairing-id="${escapeHtml(request.pairing_id)}"
              data-pairing-decision="approve"
            >
              Approve
            </button>
            <button
              class="approval-button approval-button-danger"
              type="button"
              data-pairing-id="${escapeHtml(request.pairing_id)}"
              data-pairing-decision="reject"
            >
              Reject
            </button>
          </div>
        </article>
      `;
    })
    .join("");
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
  const activeController = controllerStateLabel(session);

  liveSurfacesSummary.textContent =
    `${surfaces.length} active surface${surfaces.length === 1 ? "" : "s"} · ${approvedCount} trusted · ${pendingCount} pending · controller ${activeController}${revokedCount > 0 ? ` · ${revokedCount} revoked hidden` : ""}`;

  liveSurfacesList.innerHTML = surfaces
    .map(
      (surface) => `
        <article class="surface-card">
          <div class="surface-card-heading">
            <div>
              <h3 class="surface-card-title">${escapeHtml(surface.title)}</h3>
              <p class="surface-card-copy">${escapeHtml(surface.copy)}</p>
            </div>
            <span class="device-state-badge ${escapeHtml(surface.badgeClass)}">${escapeHtml(surface.badgeLabel)}</span>
          </div>
          <div class="surface-card-meta">
            ${surface.chips
              .map(
                (chip) => `
                  <span class="surface-chip"><strong>${escapeHtml(chip.label)}</strong>${escapeHtml(chip.value)}</span>
                `
              )
              .join("")}
          </div>
        </article>
      `
    )
    .join("");
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
    title: "This browser",
    copy: hasControl
      ? "You currently control the live session from this surface."
      : canClaim
        ? "No device currently owns typing control. This surface can open the thread and claim it."
        : session?.active_thread_id
          ? "This surface can review the live session and take over when needed."
        : "This surface is ready to launch or resume a session locally.",
    badgeLabel: status,
    badgeClass,
    chips: [
      { label: "Role", value: hasControl ? "Typing + approvals" : "Local console" },
      {
        label: "Workspace",
        value: session?.current_cwd ? workspaceBasename(session.current_cwd) : state.selectedCwd ? workspaceBasename(state.selectedCwd) : "Unset",
      },
      {
        label: "Thread",
        value: activeThread?.name || activeThread?.preview || (session?.active_thread_id ? shortId(session.active_thread_id) : "Standby"),
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

  let copy = "Trusted remote surface remembered by this relay.";
  if (lifecycle === "pending") {
    copy = "Waiting for local approval before it can join the relay.";
  } else if (lifecycle === "revoked") {
    copy = "Revoked from this relay. It can no longer reconnect without pairing again.";
  } else if (isController) {
    copy = activeThread
      ? `Currently controlling ${activeThread.name || activeThread.preview || shortId(session.active_thread_id)}.`
      : "Currently owns control of the active relay session.";
  }

  return {
    title: record.label,
    copy,
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
    auditSummary.textContent = "Recent relay, control, and security events will appear here.";
    auditTimeline.innerHTML = `<p class="sidebar-empty">No relay events yet.</p>`;
    return;
  }

  const filteredEntries = entries.filter((entry) => shouldShowAuditEntry(entry));
  const visibleEntries = filteredEntries.slice(0, 8);
  const hiddenDebugCount = entries.length - filteredEntries.length;
  const significantCount = visibleEntries.filter((entry) => classifyAuditEntry(entry) !== "neutral").length;
  auditSummary.textContent =
    significantCount > 0
      ? `${visibleEntries.length} recent events · ${significantCount} notable${hiddenDebugCount > 0 ? ` · ${hiddenDebugCount} debug hidden` : ""}`
      : `${visibleEntries.length} recent relay events${hiddenDebugCount > 0 ? ` · ${hiddenDebugCount} debug hidden` : ""}`;

  if (!visibleEntries.length) {
    auditTimeline.innerHTML = `<p class="sidebar-empty">No relay-level audit events yet.</p>`;
    return;
  }

  auditTimeline.innerHTML = visibleEntries
    .map((entry) => {
      const tone = classifyAuditEntry(entry);
      const toneClass =
        tone === "alert" ? " is-alert" : tone === "ready" ? " is-ready" : "";
      return `
        <article class="audit-item${toneClass}">
          <div class="audit-item-header">
            <span class="audit-item-kind">${escapeHtml(humanizeLabel(entry.kind || "relay"))}</span>
            <time class="audit-item-time">${escapeHtml(formatTimestamp(entry.created_at))}</time>
          </div>
          <p class="audit-item-message">${escapeHtml(entry.message || "")}</p>
        </article>
      `;
    })
    .join("");
}

function renderSessionMeta(session) {
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
    sessionMeta.innerHTML = [
      ...securityChips,
      `<span class="meta-empty">Session details will appear here.</span>`,
    ].join("");
    return;
  }

  sessionMeta.innerHTML = [
    ...securityChips,
    metaChip("Workspace", session.current_cwd || "None"),
    metaChip("Model", session.model),
    metaChip("Permissions", session.approval_policy),
    metaChip("File access", session.sandbox),
    metaChip("Effort", session.reasoning_effort),
    metaChip("Control", controllerStateLabel(session)),
    metaChip("Thread", shortId(session.active_thread_id)),
  ].join("");
}

function renderOverview(session, activeThread, approval, errorMessage = null) {
  const workspace = session?.current_cwd || state.selectedCwd || "";
  const workspaceName = workspaceBasename(workspace);
  const historyCount = state.threads.length;
  const pendingPairings = session?.pending_pairing_requests?.length || 0;
  const approvedDevices = approvedDeviceCount(session);
  const controllerState = sessionControllerState(session);
  const viewingConversation = isViewingConversation(session);

  let sessionTitle = workspace ? `Ready in ${workspaceName}` : "Pick a workspace";
  let sessionCopy = workspace
    ? "This relay is pointed at the current workspace. Use the live console to watch control, trust state, and the current thread."
    : "Choose a workspace, then use this page as the local relay console for the active session.";
  let sessionBadges = [];

  if (errorMessage) {
    sessionTitle = "Relay unavailable";
    sessionCopy = errorMessage;
    sessionBadges = [
      overviewBadge("Status", "Offline"),
      ...(workspace ? [overviewBadge("Workspace", workspaceName)] : []),
    ];
  } else if (session?.active_thread_id) {
    const threadTitle = activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);

    if (approval) {
      sessionTitle = workspace ? `Approval needed in ${workspaceName}` : "Approval required";
      sessionCopy = approval.summary || "Codex is blocked on a decision before it can continue.";
    } else if (controllerState === "this_device") {
      sessionTitle = workspace ? `Ready in ${workspaceName}` : "Session ready";
      sessionCopy = viewingConversation
        ? `This device controls ${threadTitle}. Use the composer below to continue the live thread.`
        : `This device controls ${threadTitle}. Open the thread page only when you want the conversation view.`;
    } else if (controllerState === "unclaimed") {
      sessionTitle = workspace ? `Live in ${workspaceName}` : "Live session";
      sessionCopy = `${threadTitle} is live, but no device currently holds typing control. Open the thread only when you want to claim it.`;
    } else {
      sessionTitle = workspace ? `Watching ${workspaceName}` : "Session active elsewhere";
      sessionCopy = `Another paired device controls ${threadTitle}. Use the console to monitor trust and activity until you want to take over.`;
    }

    sessionBadges = [
      overviewBadge("Status", sessionStatusLabel(session, approval)),
      overviewBadge("Model", session.model || "Unknown"),
      overviewBadge("Permissions", session.approval_policy || "Unknown"),
      overviewBadge("Control", controllerStateLabel(session)),
    ];

    if (session.reasoning_effort) {
      sessionBadges.push(overviewBadge("Effort", session.reasoning_effort));
    }
  } else {
    sessionBadges = [
      ...(workspace ? [overviewBadge("Workspace", workspaceName)] : []),
      overviewBadge(
        "History",
        historyCount > 0 ? `${historyCount} saved session${historyCount === 1 ? "" : "s"}` : "No saved sessions"
      ),
      overviewBadge("Status", sessionStatusLabel(session, approval)),
    ];
  }

  let securityTitle = "Private by default";
  let securityCopy =
    "Create a QR ticket when you want remote access. Broker visibility and trusted devices will surface here.";

  if (errorMessage) {
    securityTitle = "Last known relay posture";
    securityCopy =
      "The session snapshot could not be refreshed, so broker and device state may be stale.";
  } else if (pendingPairings > 0) {
    securityTitle = `${pendingPairings} pairing request${pendingPairings === 1 ? "" : "s"} waiting`;
    securityCopy =
      "New devices are waiting for local approval before they can join the relay.";
  } else if (approvedDevices > 0) {
    securityTitle = `${approvedDevices} trusted device${approvedDevices === 1 ? "" : "s"}`;
    securityCopy = session?.broker_connected
      ? "Remote access is live and approved devices can reconnect quickly."
      : "Approved devices are remembered, but the broker link is currently offline.";
  } else if (session?.broker_channel_id) {
    securityTitle = session.broker_connected ? "Remote access ready" : "Broker link configured";
    securityCopy = session.broker_connected
      ? "The relay is reachable through the broker, but no extra devices are trusted yet."
      : "A broker channel is configured, but it is not connected right now.";
  }

  const securityBadges = [
    ...(pendingPairings > 0 ? [overviewBadge("Pending", String(pendingPairings))] : []),
    overviewBadge("Access", securityModeLabel(session)),
    overviewBadge("Sharing", contentVisibilityLabel(session)),
    overviewBadge("Remote", brokerStatusLabel(session)),
    overviewBadge("Devices", pairedDeviceCountLabel(session)),
  ];

  overviewSessionTitle.textContent = sessionTitle;
  overviewSessionCopy.textContent = sessionCopy;
  overviewSessionBadges.innerHTML = sessionBadges.join("");
  overviewSecurityTitle.textContent = securityTitle;
  overviewSecurityCopy.textContent = securityCopy;
  overviewSecurityBadges.innerHTML = securityBadges.join("");
}

function renderControlBanner(session) {
  if (!session.active_thread_id || !isViewingConversation(session)) {
    controlBanner.hidden = true;
    takeOverButton.hidden = true;
    return;
  }

  controlBanner.hidden = false;

  if (!session.active_controller_device_id) {
    controlSummary.textContent = "No device currently has control";
    controlHint.textContent = "The next device to send a message will claim control.";
    takeOverButton.hidden = true;
    return;
  }

  if (isCurrentDeviceActiveController(session)) {
    controlSummary.textContent = "This device has control";
    controlHint.textContent = "You can type here. Other owner devices can still approve pending actions.";
    takeOverButton.hidden = true;
    return;
  }

  controlSummary.textContent = session.active_controller_device_id
    ? `Another device has control (${controllerLabel(session.active_controller_device_id)})`
    : "No device currently has control";
  controlHint.textContent = "You can still approve from this device. Take over when you want to type or continue the session.";
  takeOverButton.hidden = false;
}

function renderTranscript(session, approval) {
  const viewingConversation = isViewingConversation(session);
  const entries = session.transcript || [];

  if (!viewingConversation) {
    const activeThread = resolveActiveThread(session.active_thread_id);
    const requestedThread =
      resolveActiveThread(state.viewThreadId) || state.threads.find((thread) => thread.id === state.viewThreadId);

    if (state.viewThreadId && state.viewThreadId !== session.active_thread_id) {
      transcript.innerHTML = `
        <div class="thread-empty">
          <h2>Thread page not active yet</h2>
          <p>This URL points at a saved thread, but the relay is currently attached to a different session.</p>
          ${
            requestedThread
              ? `<p class="thread-empty-detail">Requested thread: ${escapeHtml(requestedThread.name || requestedThread.preview || shortId(requestedThread.id))}</p>`
              : `<p class="thread-empty-detail">Requested thread: ${escapeHtml(shortId(state.viewThreadId))}</p>`
          }
          <div class="suggestion-row">
            <button class="suggestion-button" type="button" data-resume-thread-id="${escapeHtml(state.viewThreadId)}">Resume this thread</button>
            <button class="suggestion-button" type="button" data-go-console-home="true">Back to console</button>
          </div>
        </div>
      `;
      return;
    }

    if (session.active_thread_id) {
      const threadLabel = activeThread?.name || activeThread?.preview || shortId(session.active_thread_id);
      transcript.innerHTML = `
        <div class="thread-empty thread-empty-ready">
          <span class="thread-empty-badge">Live</span>
          <h2>Relay console home</h2>
          <p>A live session is running, but the conversation stays behind its own thread page so the local home does not default into chat.</p>
          <p class="thread-empty-detail">Current thread: ${escapeHtml(threadLabel)}</p>
          <div class="suggestion-row">
            <button class="suggestion-button" type="button" data-open-thread-id="${escapeHtml(session.active_thread_id)}">Open live conversation</button>
          </div>
        </div>
      `;
      return;
    }
  }

  if (!entries.length && !approval) {
    if (session.active_thread_id) {
      const hasControl = canCurrentDeviceWrite(session);
      const title = hasControl ? "Session ready" : "Session active on another device";
      const copy = hasControl
        ? "Codex is connected. Send the first prompt below when you're ready."
        : "This thread is open, but another device currently has control. Take over to send the first prompt from here.";
      const detailParts = [];

      if (session.current_cwd) {
        detailParts.push(`Workspace: ${escapeHtml(session.current_cwd)}`);
      }
      if (session.active_thread_id) {
        detailParts.push(`Thread: ${escapeHtml(shortId(session.active_thread_id))}`);
      }

      transcript.innerHTML = `
        <div class="thread-empty thread-empty-ready">
          <span class="thread-empty-badge">${hasControl ? "Ready" : "Waiting"}</span>
          <h2>${title}</h2>
          <p>${copy}</p>
          ${
            detailParts.length
              ? `<p class="thread-empty-detail">${detailParts.join(" · ")}</p>`
              : ""
          }
        </div>
      `;
      return;
    }

    transcript.innerHTML = `
      <div class="thread-empty">
        <h2>Relay standing by</h2>
        <p>Pick a workspace, then use this console to launch or resume a session while keeping an eye on control, trust, and audit state.</p>
        ${
          state.selectedCwd
            ? `<p class="thread-empty-detail">Selected workspace: ${escapeHtml(state.selectedCwd)}</p>`
            : ""
        }
        <div class="suggestion-row">
          <button class="suggestion-button" type="button" data-suggestion="Summarize the structure of this repo and point out the important entry points.">Summarize this repo</button>
          <button class="suggestion-button" type="button" data-suggestion="Find the bug in this project and explain the likely root cause before changing code.">Find the bug</button>
          <button class="suggestion-button" type="button" data-suggestion="Review this codebase for areas that feel too complex and suggest a cleanup plan.">Suggest a cleanup</button>
        </div>
      </div>
    `;
    return;
  }

  const items = entries.map(renderEntry);
  if (approval) {
    items.push(renderApprovalCard(approval));
  }

  transcript.innerHTML = `<div class="thread-content">${items.join("")}</div>`;
  transcript.scrollTop = transcript.scrollHeight;
}

function renderEntry(entry) {
  const role = entry.role || "system";

  if (role === "user") {
    return `
      <article class="chat-message chat-message-user">
        <div class="message-card">
          <div class="message-meta">
            <strong>You</strong>
            <span>${escapeHtml(entry.status || "completed")}</span>
          </div>
          <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
        </div>
      </article>
    `;
  }

  if (role === "assistant") {
    return `
      <article class="chat-message chat-message-assistant">
        <div class="message-avatar">C</div>
        <div class="message-card">
          <div class="message-meta">
            <strong>Codex</strong>
            <span>${escapeHtml(entry.status || "completed")}</span>
            <span>${escapeHtml(shortId(entry.turn_id || ""))}</span>
          </div>
          <div class="message-body">${escapeHtml(entry.text || "(empty)")}</div>
        </div>
      </article>
    `;
  }

  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-system">
        <div class="message-meta">
          <strong>${escapeHtml(roleLabel(role))}</strong>
          <span>${escapeHtml(entry.status || "completed")}</span>
        </div>
        <pre class="message-pre">${escapeHtml(entry.text || "(empty)")}</pre>
      </div>
    </article>
  `;
}

function renderApprovalCard(approval) {
  return `
    <article class="chat-message chat-message-system">
      <div class="message-card message-card-approval">
        <div class="message-meta">
          <strong>Approval required</strong>
          <span>${escapeHtml(approval.kind)}</span>
        </div>
        <h3 class="approval-title">${escapeHtml(approval.summary)}</h3>
        <p class="approval-copy">${escapeHtml(approval.detail || "Codex is waiting for a remote approval.")}</p>
        ${approval.cwd ? `<p class="approval-copy">cwd: ${escapeHtml(approval.cwd)}</p>` : ""}
        ${approval.command ? `<pre class="message-pre">${escapeHtml(approval.command)}</pre>` : ""}
        ${
          approval.requested_permissions
            ? `<pre class="message-pre">${escapeHtml(JSON.stringify(approval.requested_permissions, null, 2))}</pre>`
            : ""
        }
        <div class="approval-actions">
          <button
            class="approval-button approval-button-primary"
            type="button"
            data-approval-decision="approve"
            data-approval-scope="once"
          >
            Approve
          </button>
          ${
            approval.supports_session_scope
              ? `
                <button
                  class="approval-button"
                  type="button"
                  data-approval-decision="approve"
                  data-approval-scope="session"
                >
                  Approve Session
                </button>
              `
              : ""
          }
          <button
            class="approval-button approval-button-danger"
            type="button"
            data-approval-decision="deny"
            data-approval-scope="once"
          >
            Deny
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderThreads() {
  const selectedCwd = canonicalizeWorkspace(state.selectedCwd);
  const viewedThreadId = state.viewThreadId || null;
  const previousScrollTop =
    appShell?.dataset.view === "conversation"
      ? state.pendingThreadHistoryScrollTop ?? Math.max(state.threadHistoryScrollTop, threadsList?.scrollTop || 0)
      : 0;
  closeThreadContextMenu();

  const groups = state.threadGroups || [];
  const totalThreads = state.threads.length;

  threadsCount.textContent =
    totalThreads > 0
      ? `${groups.length} ${groups.length === 1 ? "folder" : "folders"} · ${totalThreads} ${
          totalThreads === 1 ? "thread" : "threads"
        }`
      : "No saved threads yet.";
  threadsCount.title = groups.map((group) => group.cwd).join("\n");
  resumeLatestButton.disabled = totalThreads === 0;

  if (!groups.length) {
    threadsList.innerHTML = `<p class="sidebar-empty">Start or resume a session to build workspace groups.</p>`;
    syncThreadHistoryScroll();
    return;
  }

  threadsList.innerHTML = groups
    .map((group) => {
      const selectedWorkspaceClass =
        selectedCwd && canonicalizeWorkspace(group.cwd) === selectedCwd
          ? " is-selected-workspace"
          : "";

      const threadItems = group.threads
        .map((thread) => {
          const title = thread.name || thread.preview || shortId(thread.id);
          const activeClass = viewedThreadId === thread.id ? " is-active" : "";

          return `
            <button
              class="conversation-item${activeClass}"
              type="button"
              data-thread-id="${escapeHtml(thread.id)}"
              data-thread-cwd="${escapeHtml(group.cwd)}"
              data-thread-title="${escapeHtml(title)}"
              title="${escapeHtml(title)}"
            >
              <span class="conversation-title">${escapeHtml(title)}</span>
              <span class="conversation-meta">${escapeHtml(formatRelativeTime(thread.updated_at))}</span>
            </button>
          `;
        })
        .join("");

      return `
        <section class="thread-group${selectedWorkspaceClass}" data-thread-group-cwd="${escapeHtml(group.cwd)}">
          <button
            class="thread-group-header"
            type="button"
            data-select-workspace="${escapeHtml(group.cwd)}"
            title="${escapeHtml(group.cwd)}"
          >
            <span class="thread-group-icon" aria-hidden="true"></span>
            <span class="thread-group-name">${escapeHtml(group.label)}</span>
          </button>
          <div class="thread-group-list">
            ${threadItems}
          </div>
        </section>
      `;
    })
    .join("");

  threadsList.querySelectorAll("[data-select-workspace]").forEach((button) => {
    button.addEventListener("click", () => {
      setSelectedCwd(button.dataset.selectWorkspace || "");
      renderThreads();
      renderOverview(
        state.session,
        resolveActiveThread(state.session?.active_thread_id),
        state.session?.pending_approvals?.[0] || null
      );
    });
  });

  threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void resumeSession(button.dataset.threadId);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openThreadContextMenu(button.dataset.threadId, event.clientX, event.clientY);
    });
  });

  window.requestAnimationFrame(() => {
    syncThreadHistoryScroll();
    if (appShell?.dataset.view === "conversation" && previousScrollTop > 0) {
      const maxScrollTop = Math.max(0, threadsList.scrollHeight - threadsList.clientHeight);
      threadsList.scrollTop = Math.min(previousScrollTop, maxScrollTop);
      state.threadHistoryScrollTop = threadsList.scrollTop;
    }
  });
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

  const desiredScrollTop = state.pendingThreadHistoryScrollTop ?? state.threadHistoryScrollTop ?? 0;
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
  clientLog.textContent = entries
    .map(
      (entry) =>
        `${new Date(entry.created_at * 1000).toLocaleTimeString()}  [${entry.kind}] ${entry.message}`
    )
    .join("\n");
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

  select.innerHTML = options
    .map((model) => `<option value="${escapeHtml(model.model)}">${escapeHtml(model.display_name)}</option>`)
    .join("");
  select.value = currentValue;
}

function setSelectedCwd(cwd) {
  state.selectedCwd = cwd;
  cwdInput.value = cwd;
}

function canonicalizeWorkspace(cwd) {
  return String(cwd || "").trim().replace(/[\\/]+$/, "");
}

function groupThreadsByWorkspace(threads) {
  const groups = new Map();

  for (const thread of threads || []) {
    const cwd = canonicalizeWorkspace(thread.cwd);
    if (!cwd) {
      continue;
    }

    if (!groups.has(cwd)) {
      groups.set(cwd, {
        cwd,
        label: workspaceBasename(cwd),
        latestUpdatedAt: 0,
        threads: [],
      });
    }

    const group = groups.get(cwd);
    group.threads.push(thread);
    group.latestUpdatedAt = Math.max(group.latestUpdatedAt, Number(thread.updated_at) || 0);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      threads: [...group.threads].sort((left, right) => (right.updated_at || 0) - (left.updated_at || 0)),
    }))
    .sort((left, right) => {
      if (right.latestUpdatedAt !== left.latestUpdatedAt) {
        return right.latestUpdatedAt - left.latestUpdatedAt;
      }
      return left.label.localeCompare(right.label);
    });
}

function findLatestThread(preferredCwd) {
  if (!state.threads.length) {
    return null;
  }

  const normalizedCwd = canonicalizeWorkspace(preferredCwd);
  if (!normalizedCwd) {
    return state.threads[0] || null;
  }

  return (
    state.threads.find((thread) => canonicalizeWorkspace(thread.cwd) === normalizedCwd) ||
    null
  );
}

function resolveActiveThread(threadId) {
  if (!threadId) {
    return null;
  }

  return state.threads.find((thread) => thread.id === threadId) || null;
}

function setStartControlsBusy(busy) {
  [
    loadDirectoryButton,
    startSessionButton,
    resumeLatestButton,
    openLaunchSettingsButton,
    cwdInput,
    startPromptInput,
    modelInput,
    approvalPolicyInput,
    sandboxInput,
    startEffortInput,
  ].forEach((element) => {
    element.disabled = busy;
  });
}

function scheduleSessionPoll() {
  if (state.streamConnected || (state.authRequired && !state.authenticated)) {
    return;
  }

  if (state.sessionPollTimer) {
    window.clearTimeout(state.sessionPollTimer);
  }

  state.sessionPollTimer = window.setTimeout(() => {
    void loadSession("poll");
  }, nextSessionPollDelay());
}

function scheduleThreadsPoll() {
  if (state.authRequired && !state.authenticated) {
    cancelThreadsPoll();
    return;
  }

  if (state.threadsPollTimer) {
    window.clearTimeout(state.threadsPollTimer);
  }

  state.threadsPollTimer = window.setTimeout(() => {
    void loadThreads("poll");
  }, 12000);
}

function cancelThreadsPoll() {
  if (!state.threadsPollTimer) {
    return;
  }

  window.clearTimeout(state.threadsPollTimer);
  state.threadsPollTimer = null;
}

function scheduleControllerHeartbeat(session) {
  cancelControllerHeartbeat();

  if (!session?.active_thread_id || !isCurrentDeviceActiveController(session)) {
    return;
  }

  state.controllerHeartbeatTimer = window.setTimeout(() => {
    void sendSessionHeartbeat();
  }, CONTROL_HEARTBEAT_MS);
}

async function sendSessionHeartbeat() {
  if (!state.session?.active_thread_id || !isCurrentDeviceActiveController(state.session)) {
    return;
  }

  try {
    const response = await apiFetch("/api/session/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_id: state.deviceId,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to refresh control lease");
    }
  } catch (error) {
    logLine(`Control heartbeat failed: ${error.message}`);
  } finally {
    if (state.session?.active_thread_id && isCurrentDeviceActiveController(state.session)) {
      scheduleControllerHeartbeat(state.session);
    }
  }
}

async function saveAllowedRoots() {
  const allowed_roots = (allowedRootsInput?.value || "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (saveAllowedRootsButton) {
    saveAllowedRootsButton.disabled = true;
  }
  if (allowedRootsInput) {
    allowedRootsInput.disabled = true;
  }

  logLine(
    allowed_roots.length
      ? `Saving ${allowed_roots.length} allowed workspace root${allowed_roots.length === 1 ? "" : "s"}.`
      : "Clearing relay workspace restrictions."
  );

  try {
    const response = await apiFetch("/api/allowed-roots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        allowed_roots,
      }),
    });
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to save allowed roots");
    }

    state.allowedRootsDraftDirty = false;
    renderAllowedRoots(payload.data.allowed_roots || []);
    await loadSession("post-allowed-roots refresh");
    await loadThreads("post-allowed-roots refresh");
    logLine(payload.data?.message || "Relay workspace restrictions saved.");
  } catch (error) {
    logLine(`Allowed roots update failed: ${error.message}`);
  } finally {
    if (saveAllowedRootsButton) {
      saveAllowedRootsButton.disabled = false;
    }
    if (allowedRootsInput) {
      allowedRootsInput.disabled = false;
    }
  }
}

function cancelControllerHeartbeat() {
  if (!state.controllerHeartbeatTimer) {
    return;
  }

  window.clearTimeout(state.controllerHeartbeatTimer);
  state.controllerHeartbeatTimer = null;
}

function scheduleControllerLeaseRefresh(session) {
  cancelControllerLeaseRefresh();

  if (
    !session?.active_thread_id ||
    !session.active_controller_device_id ||
    isCurrentDeviceActiveController(session) ||
    !session.controller_lease_expires_at
  ) {
    return;
  }

  const delayMs = Math.max(
    LEASE_EXPIRY_REFRESH_SKEW_MS,
    session.controller_lease_expires_at * 1000 - Date.now() + LEASE_EXPIRY_REFRESH_SKEW_MS
  );

  state.controllerLeaseRefreshTimer = window.setTimeout(() => {
    void loadSession("controller lease expiry");
  }, delayMs);
}

function cancelControllerLeaseRefresh() {
  if (!state.controllerLeaseRefreshTimer) {
    return;
  }

  window.clearTimeout(state.controllerLeaseRefreshTimer);
  state.controllerLeaseRefreshTimer = null;
}

function connectSessionStream() {
  if (state.authRequired && !state.authenticated) {
    return;
  }

  if (typeof fetch !== "function" || typeof AbortController === "undefined") {
    logLine("Fetch streaming is unavailable. Falling back to polling.");
    state.streamConnected = false;
    scheduleSessionPoll();
    return;
  }

  if (state.sessionStream) {
    state.sessionStream.close();
  }

  const stream = openSessionStream({
    url: sessionStreamUrl(window.location.origin),
    apiToken: state.apiToken,
    onSession(data) {
      try {
        const snapshot = JSON.parse(data);
        state.streamConnected = true;
        cancelSessionPoll();
        seedDefaults(snapshot);
        renderSession(snapshot);
      } catch (error) {
        logLine(`Stream payload failed: ${error.message}`);
      }
    },
    onOpen() {
      if (!state.streamConnected) {
        logLine("Session stream connected.");
      }
      state.streamConnected = true;
      cancelSessionPoll();
      cancelStreamReconnect();
    },
    onError(error) {
      if (state.sessionStream !== stream) {
        return;
      }

      if (error?.code === "unauthorized") {
        state.sessionStream = null;
        handleUnauthorized("Local auth session expired. Sign in again.");
        return;
      }

      logLine("Session stream disconnected. Falling back to polling.");
      state.streamConnected = false;
      state.sessionStream = null;
      scheduleSessionPoll();
      scheduleStreamReconnect();
    },
  });
  state.sessionStream = stream;
}

function cancelSessionPoll() {
  if (!state.sessionPollTimer) {
    return;
  }

  window.clearTimeout(state.sessionPollTimer);
  state.sessionPollTimer = null;
}

async function apiFetch(input, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || {});
  if (state.apiToken) {
    headers.set("Authorization", `Bearer ${state.apiToken}`);
  }
  applyCsrfHeader(headers, method);

  const response = await fetch(input, {
    ...init,
    method,
    credentials: "same-origin",
    headers,
  });

  if (response.status === 401) {
    handleUnauthorized("Local authentication is required. Sign in with RELAY_API_TOKEN.");
  }

  return response;
}

function applyCsrfHeader(headers, method) {
  if (method === "GET" || method === "HEAD") {
    return;
  }

  headers.set("X-Agent-Relay-CSRF", "1");
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
    state.threadGroups = groupThreadsByWorkspace(state.threads);
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
    state.threadGroups = groupThreadsByWorkspace(state.threads);
    renderThreads();
    await loadSession("post-delete refresh");
    await loadThreads("post-delete refresh");
    logLine(payload.data?.message || `Deleted local session ${shortId(threadId)} permanently.`);
  } catch (error) {
    logLine(`Failed to permanently delete local session: ${error.message}`);
  }
}

function scheduleStreamReconnect() {
  cancelStreamReconnect();
  state.streamReconnectTimer = window.setTimeout(() => {
    connectSessionStream();
  }, 1500);
}

function cancelStreamReconnect() {
  if (!state.streamReconnectTimer) {
    return;
  }

  window.clearTimeout(state.streamReconnectTimer);
  state.streamReconnectTimer = null;
}

function nextSessionPollDelay() {
  const session = state.session;
  if (!session || !session.active_thread_id) {
    return 2200;
  }

  if (session.pending_approvals?.length) {
    return 700;
  }

  if (session.active_turn_id) {
    return 700;
  }

  if (session.current_status && session.current_status !== "idle") {
    return 1100;
  }

  return 2200;
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

function deviceLifecycleLabel(state) {
  switch (state) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "revoked":
      return "Revoked";
    default:
      return "Unknown";
  }
}

function deviceLifecycleBadgeClass(state) {
  switch (state) {
    case "pending":
      return "device-state-pending";
    case "approved":
      return "device-state-approved";
    case "rejected":
      return "device-state-rejected";
    case "revoked":
      return "device-state-revoked";
    default:
      return "device-state-neutral";
  }
}

function formatBrokerJoinTicketExpiry(state, expiresAt) {
  if (state !== "approved") {
    return "Not active";
  }

  if (!expiresAt) {
    return "Until revoked";
  }

  return formatTimestamp(expiresAt);
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

function roleLabel(role) {
  if (role === "command") {
    return "Command";
  }
  return role;
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

function renderAuthRequiredState(message) {
  state.session = null;
  state.threads = [];
  state.threadGroups = [];
  cancelControllerHeartbeat();
  cancelControllerLeaseRefresh();
  openSessionDetailsButton.disabled = true;
  renderOverview(null, null, null, message);
  threadsCount.textContent = "Sign in";
  threadsList.innerHTML = `<p class="sidebar-empty">Enter RELAY_API_TOKEN to load threads.</p>`;
  statusBadge.textContent = "Sign in";
  statusBadge.className = "status-badge status-badge-offline";
  sessionMeta.innerHTML = `<span class="meta-empty">${escapeHtml(message)}</span>`;
  transcript.innerHTML = `
    <div class="thread-empty">
      <h2>Authentication required</h2>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function logLine(message) {
  const time = new Date().toLocaleTimeString();
  clientLog.textContent = `${time}  ${message}\n${clientLog.textContent}`.trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
