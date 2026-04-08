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
  newSessionPanelOpen: false,
  pendingPairingIds: [],
  selectedCwd: "",
  session: null,
  sessionStream: null,
  streamConnected: false,
  streamReconnectTimer: null,
  sessionPollTimer: null,
  threadContextMenuThreadId: null,
  threads: [],
  threadsPollTimer: null,
};

const transcript = document.querySelector("#transcript");
const clientLog = document.querySelector("#client-log");
const connectionForm = document.querySelector("#connection-form");
const apiTokenLabel = connectionForm.querySelector("label[for='api-token-input']");
const apiTokenInput = document.querySelector("#api-token-input");
const applyTokenButton = document.querySelector("#apply-token-button");
const startPairingButton = document.querySelector("#start-pairing-button");
const openSecurityModalBtn = document.querySelector("#open-security-modal");
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
const sendButton = document.querySelector("#send-button");
const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const messageEffort = document.querySelector("#message-effort");
const directoryForm = document.querySelector("#directory-form");
const loadDirectoryButton = document.querySelector("#load-directory-button");
const newSessionToggleButton = document.querySelector("#new-session-toggle");
const newSessionPanel = document.querySelector("#new-session-panel");
const startSessionButton = document.querySelector("#start-session-button");
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
const workspaceTitle = document.querySelector("#workspace-title");
const workspaceSubtitle = document.querySelector("#workspace-subtitle");
const statusBadge = document.querySelector("#status-badge");
const sessionMeta = document.querySelector("#session-meta");
const overviewSessionTitle = document.querySelector("#overview-session-title");
const overviewSessionCopy = document.querySelector("#overview-session-copy");
const overviewSessionBadges = document.querySelector("#overview-session-badges");
const overviewSecurityTitle = document.querySelector("#overview-security-title");
const overviewSecurityCopy = document.querySelector("#overview-security-copy");
const overviewSecurityBadges = document.querySelector("#overview-security-badges");
const controlBanner = document.querySelector("#control-banner");
const controlSummary = document.querySelector("#control-summary");
const controlHint = document.querySelector("#control-hint");
const takeOverButton = document.querySelector("#take-over-button");

connectionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitAuthSession();
});

startPairingButton.addEventListener("click", () => {
  void startPairing();
});

openSecurityModalBtn?.addEventListener("click", () => {
  state.allowedRootsDraftDirty = false;
  renderAllowedRoots(state.session?.allowed_roots || []);
  securityModal?.showModal();
});

closeSecurityModalBtn?.addEventListener("click", () => {
  securityModal?.close();
});

securityModal?.addEventListener("click", (event) => {
  if (event.target === securityModal) {
    securityModal.close();
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
});

directoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  setSelectedCwd(cwdInput.value.trim());
  void loadThreads("directory change");
});

newSessionToggleButton.addEventListener("click", () => {
  setNewSessionPanelOpen(!state.newSessionPanelOpen);
});

startSessionButton.addEventListener("click", () => {
  void startSession();
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
  if (!approvalButton) {
    return;
  }

  void submitDecision(
    approvalButton.dataset.approvalDecision,
    approvalButton.dataset.approvalScope || "once"
  );
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
  setNewSessionPanelOpen(false);

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
  if (state.selectedCwd) {
    await loadThreads("initial boot");
  } else {
    renderThreads([]);
  }
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
  if (state.selectedCwd) {
    await loadThreads(reason);
  }
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
  if (!state.selectedCwd) {
    state.threads = [];
    renderThreads([]);
    renderOverview(
      state.session,
      resolveActiveThread(state.session?.active_thread_id),
      state.session?.pending_approvals?.[0] || null
    );
    logLine("History skipped because no directory is selected.");
    return;
  }

  threadsCount.textContent = "Loading...";
  threadsCount.title = state.selectedCwd;
  logLine(`Fetching thread list for ${state.selectedCwd} (${reason})`);

  try {
    const url = new URL("/api/threads", window.location.origin);
    url.searchParams.set("cwd", state.selectedCwd);
    url.searchParams.set("limit", "80");

    const response = await apiFetch(url);
    const payload = await response.json();

    if (!response.ok || !payload.ok) {
      throw new Error(payload?.error?.message || "Failed to load threads");
    }

    state.threads = payload.data.threads;
    renderThreads(payload.data.threads);
    renderOverview(
      state.session,
      resolveActiveThread(state.session?.active_thread_id),
      state.session?.pending_approvals?.[0] || null
    );
  } catch (error) {
    if (state.authRequired && !state.authenticated) {
      threadsCount.textContent = "Sign in";
      threadsList.innerHTML = `<p class="sidebar-empty">Enter RELAY_API_TOKEN to load threads.</p>`;
      logLine(`Thread fetch blocked by local auth: ${error.message}`);
      return;
    }

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
    setSelectedCwd(payload.data.current_cwd || cwd);
    seedDefaults(payload.data);
    renderSession(payload.data);
    if (canCurrentDeviceWrite(payload.data)) {
      messageInput.focus();
    }
    await loadThreads("post-start refresh");
    setNewSessionPanelOpen(false);
    logLine("Started a new Codex thread");
  } catch (error) {
    logLine(`Session start failed: ${error.message}`);
  } finally {
    setStartControlsBusy(false);
  }
}

async function resumeSession(threadId) {
  logLine(`Resuming thread ${threadId}`);

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
    setSelectedCwd(payload.data.current_cwd || state.selectedCwd);
    seedDefaults(payload.data);
    renderSession(payload.data);
    if (canCurrentDeviceWrite(payload.data)) {
      messageInput.focus();
    }
    await loadThreads("post-resume refresh");
    setNewSessionPanelOpen(false);
    logLine(`Resumed thread ${threadId}`);
  } catch (error) {
    logLine(`Resume failed: ${error.message}`);
  }
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
  const canWrite = canCurrentDeviceWrite(session);
  state.currentApprovalId = approval?.request_id || null;

  workspaceTitle.textContent = session.active_thread_id
    ? activeThread?.name || activeThread?.preview || shortId(session.active_thread_id)
    : "New session";
  workspaceSubtitle.textContent = session.active_thread_id
    ? session.current_cwd
    : "Pick a workspace on the left and start or resume a session.";

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
    statusBadge.textContent = session.current_status || "Ready";
    statusBadge.className = "status-badge status-badge-ready";
  }

  renderOverview(session, activeThread, approval);
  renderSessionMeta(session);
  renderAllowedRoots(session.allowed_roots || []);
  renderPairingPanel();
  renderDeviceRecords(session.device_records || []);
  renderPendingPairingRequests(pendingPairings);
  announceNewPendingPairings(pendingPairings);
  renderControlBanner(session);
  renderTranscript(session, approval);
  renderLogs(session.logs);
  renderThreads(state.threads);
  scheduleControllerHeartbeat(session);
  scheduleControllerLeaseRefresh(session);

  sendButton.disabled = !hasActiveSession || !canWrite;
  messageInput.disabled = !hasActiveSession || !canWrite;
  messageInput.placeholder = !hasActiveSession
    ? "Start or resume a session first."
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

function renderSessionMeta(session) {
  const securityChips = [
    metaChip("Security", securityModeLabel(session)),
    metaChip("Visibility", contentVisibilityLabel(session)),
    metaChip("Broker", brokerStatusLabel(session)),
    metaChip("Devices", pairedDeviceCountLabel(session)),
    metaChip(
      "Roots",
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
    metaChip("Directory", session.current_cwd || "None"),
    metaChip("Model", session.model),
    metaChip("Approval", session.approval_policy),
    metaChip("Sandbox", session.sandbox),
    metaChip("Effort", session.reasoning_effort),
    metaChip(
      "Control",
      session.active_controller_device_id
        ? controllerLabel(session.active_controller_device_id)
        : "Unclaimed"
    ),
    metaChip("Thread", shortId(session.active_thread_id)),
  ].join("");
}

function renderOverview(session, activeThread, approval, errorMessage = null) {
  const workspace = session?.current_cwd || state.selectedCwd || "";
  const workspaceName = workspaceBasename(workspace);
  const historyCount = state.threads.length;
  const pendingPairings = session?.pending_pairing_requests?.length || 0;
  const approvedDevices = approvedDeviceCount(session);

  let sessionTitle = workspace ? `Launch from ${workspaceName}` : "Pick a workspace to launch";
  let sessionCopy = workspace
    ? "History is scoped to this workspace. Start a fresh session or reopen a previous thread."
    : "Load a workspace, review prior threads, and start a fresh Codex relay session.";
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
    } else if (canCurrentDeviceWrite(session)) {
      sessionTitle = workspace ? `Ready in ${workspaceName}` : "Session ready";
      sessionCopy = `This device controls ${threadTitle}. Use the composer below to continue the live thread.`;
    } else {
      sessionTitle = workspace ? `Watching ${workspaceName}` : "Session active elsewhere";
      sessionCopy = `Another paired device controls ${threadTitle}. Review context here or take over when you want to continue.`;
    }

    sessionBadges = [
      overviewBadge("Status", sessionStatusLabel(session, approval)),
      overviewBadge("Thread", shortId(session.active_thread_id)),
      overviewBadge("Model", session.model || "Unknown"),
      overviewBadge("Approval", session.approval_policy || "Unknown"),
      overviewBadge(
        "Control",
        session.active_controller_device_id
          ? controllerLabel(session.active_controller_device_id)
          : "Open"
      ),
    ];

    if (session.reasoning_effort) {
      sessionBadges.push(overviewBadge("Effort", session.reasoning_effort));
    }
  } else {
    sessionBadges = [
      ...(workspace ? [overviewBadge("Workspace", workspaceName)] : []),
      overviewBadge(
        "History",
        historyCount > 0 ? `${historyCount} saved thread${historyCount === 1 ? "" : "s"}` : "No saved threads"
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
    overviewBadge("Security", securityModeLabel(session)),
    overviewBadge("Visibility", contentVisibilityLabel(session)),
    overviewBadge("Broker", brokerStatusLabel(session)),
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
  if (!session.active_thread_id) {
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
  const entries = session.transcript || [];

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
        <h2>No active conversation yet</h2>
        <p>Start a new session or resume one from the sidebar.</p>
        ${
          state.selectedCwd
            ? `<p class="thread-empty-detail">Selected workspace: ${escapeHtml(state.selectedCwd)}</p>`
            : ""
        }
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

function renderThreads(threads) {
  const selectedCwd = state.selectedCwd;
  const activeThreadId = state.session?.active_thread_id || null;
  closeThreadContextMenu();

  if (!selectedCwd) {
    threadsCount.textContent = "Choose a directory";
    threadsCount.title = "";
    threadsList.innerHTML = `<p class="sidebar-empty">Choose a directory to load history sessions.</p>`;
    return;
  }

  threadsCount.textContent = `${threads.length} ${threads.length === 1 ? "session" : "sessions"}`;
  threadsCount.title = selectedCwd;

  if (!threads.length) {
    threadsList.innerHTML = `<p class="sidebar-empty">No saved sessions found for this workspace.</p>`;
    return;
  }

  threadsList.innerHTML = threads
    .map((thread) => {
      const title = thread.name || thread.preview || shortId(thread.id);
      const activeClass = activeThreadId === thread.id ? " is-active" : "";

      return `
        <button
          class="conversation-item${activeClass}"
          type="button"
          data-thread-id="${escapeHtml(thread.id)}"
          data-thread-title="${escapeHtml(title)}"
        >
          <span class="conversation-title">${escapeHtml(title)}</span>
          <span class="conversation-preview">${escapeHtml(thread.preview || "No preview yet.")}</span>
          <span class="conversation-meta">${escapeHtml(formatTimestamp(thread.updated_at))}</span>
        </button>
      `;
    })
    .join("");

  threadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      void resumeSession(button.dataset.threadId);
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openThreadContextMenu(button.dataset.threadId, event.clientX, event.clientY);
    });
  });
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

function setNewSessionPanelOpen(open) {
  state.newSessionPanelOpen = open;
  newSessionPanel.hidden = !open;
  newSessionToggleButton.setAttribute("aria-expanded", String(open));
  newSessionToggleButton.textContent = open ? "Hide Launch Pad" : "Launch Session";
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
    if (state.selectedCwd) {
      await loadThreads("post-allowed-roots refresh");
    }
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
    renderThreads(state.threads);
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
    renderThreads(state.threads);
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

  return humanizeLabel(session.current_status || "ready");
}

function securityModeLabel(session) {
  if (session?.security_mode === "managed") {
    return "Managed";
  }
  return "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Org-readable + audit" : "Readable";
  }
  return session?.e2ee_enabled ? "E2EE broker-blind" : "Broker-blind";
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

function controllerLabel(deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === state.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
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
  cancelControllerHeartbeat();
  cancelControllerLeaseRefresh();
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
