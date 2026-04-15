import * as dom from "./dom.js";
import { renderEmptyState } from "./render-transcript.js";
import { state } from "./state.js";
import { escapeHtml, formatTimestamp, shortId, workspaceBasename } from "./utils.js";

export function renderSessionChrome(session) {
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  const workspaceName = session.current_cwd ? workspaceBasename(session.current_cwd) : workspaceTitle();
  const headerPath = currentHeaderPath(session);
  const headerSubtitle = headerPath || workspaceSubtitle();

  dom.remoteWorkspaceTitle.textContent = hasActiveSession ? workspaceName : workspaceTitle();
  dom.remoteWorkspaceSubtitle.textContent = headerSubtitle;
  dom.remoteWorkspaceSubtitle.hidden = !headerSubtitle;
  dom.remoteWorkspaceTitle.title = session.current_cwd || "";
  dom.remoteWorkspaceSubtitle.title = headerPath || headerSubtitle;
  renderSessionPath(headerPath);

  if (approval) {
    setStatusBadge("alert", "Approval required");
  } else if (!state.socketConnected || !session.codex_connected) {
    setStatusBadge("offline", "Offline");
  } else {
    setStatusBadge("ready", session.current_status || "Ready");
  }

  renderSessionMeta(session);
  renderOverviewCards();
  renderControlBanner(session);
}

export function renderDeviceMeta() {
  if (!state.remoteAuth && !state.pairingTicket) {
    dom.deviceMeta.innerHTML = `
      <p class="sidebar-empty">${
        state.relayDirectory?.length
          ? "Open one of your relays from home or the sidebar to enter its remote surface."
          : "No paired remote device is stored in this browser yet."
      }</p>
    `;
    syncWorkspaceHeading();
    updatePairingControls();
    updateHomeButton();
    renderOverviewCards();
    return;
  }

  const rows = [];

  if (state.pairingTicket) {
    rows.push(`
      <article class="paired-device-card">
        <div class="paired-device-copy">
          <strong>${escapeHtml(pairingHeading())}</strong>
          <div class="paired-device-badges">
            ${statusBadgeMarkup(pairingBadgeText(), pairingBadgeTone())}
          </div>
          <p class="paired-device-meta">${escapeHtml(shortId(state.pairingTicket.pairing_id))} · expires ${escapeHtml(formatTimestamp(state.pairingTicket.expires_at))}</p>
          <p class="paired-device-meta">${escapeHtml(pairingCopy())}</p>
        </div>
      </article>
    `);
  }

  if (state.remoteAuth) {
    rows.push(`
      <article class="paired-device-card">
        <div class="paired-device-copy">
          <strong>${escapeHtml(state.remoteAuth.deviceLabel)}</strong>
          <div class="paired-device-badges">
            ${statusBadgeMarkup(selectedRelayNeedsRepair() ? "Re-pair required" : "Paired", selectedRelayNeedsRepair() ? "alert" : "ready")}
            ${statusBadgeMarkup(securityModeLabel(state.session), state.remoteAuth.securityMode === "managed" ? "alert" : "ready")}
            ${statusBadgeMarkup(remoteAccessStatusText(), remoteAccessBadgeTone())}
          </div>
          <p class="paired-device-meta">Device ${escapeHtml(shortId(state.remoteAuth.deviceId))}</p>
          <p class="paired-device-meta">Broker ${escapeHtml(state.remoteAuth.brokerChannelId)} via ${escapeHtml(shortId(state.remoteAuth.relayPeerId))}</p>
          <p class="paired-device-meta">${escapeHtml(remoteAccessLabel())}</p>
        </div>
      </article>
    `);
  }

  dom.deviceMeta.innerHTML = rows.join("");
  syncWorkspaceHeading();
  updatePairingControls();
  updateHomeButton();
  renderOverviewCards();
}

export function updateStatusBadge() {
  if (state.session) {
    if (state.session.pending_approvals?.length) {
      setStatusBadge("alert", "Approval required");
      renderOverviewCards();
      return;
    }

    if (!state.socketConnected || !state.session.codex_connected) {
      setStatusBadge("offline", "Offline");
      renderOverviewCards();
      return;
    }

    setStatusBadge("ready", state.session.current_status || "Ready");
    renderOverviewCards();
    return;
  }

  if (state.socketConnected) {
    setStatusBadge("ready", "Connected");
    renderOverviewCards();
    return;
  }

  if (state.pairingTicket) {
    setStatusBadge(pairingBadgeTone(), pairingBadgeText());
    renderOverviewCards();
    return;
  }

  if (!state.remoteAuth && state.relayDirectory?.length) {
    setStatusBadge("ready", "Home");
    renderOverviewCards();
    return;
  }

  if (selectedRelayNeedsRepair()) {
    setStatusBadge("alert", "Re-pair required");
    renderOverviewCards();
    return;
  }

  setStatusBadge("offline", state.remoteAuth ? "Connecting" : "Offline");
  renderOverviewCards();
}

export function resetRemoteSurfaceChrome() {
  renderDeviceMeta();
  renderOverviewCards();
  renderSessionPath("");
  dom.remoteSessionMeta.innerHTML = `<span class="meta-empty">Pair a remote device to start streaming session details.</span>`;
  dom.remoteControlBanner.hidden = true;
  dom.remoteWorkspaceTitle.textContent = workspaceTitle();
  dom.remoteWorkspaceSubtitle.textContent = workspaceSubtitle();
  dom.remoteWorkspaceSubtitle.hidden = !dom.remoteWorkspaceSubtitle.textContent;
  dom.remoteWorkspaceSubtitle.title = dom.remoteWorkspaceSubtitle.textContent;
  renderEmptyState();
  updateHomeButton();
  updateStatusBadge();
}

export function isCurrentDeviceActiveController(session) {
  return Boolean(
    session?.active_thread_id &&
      session.active_controller_device_id &&
      session.active_controller_device_id === state.remoteAuth?.deviceId
  );
}

export function canCurrentDeviceWrite(session) {
  if (!session?.active_thread_id) {
    return false;
  }

  return (
    !session.active_controller_device_id ||
    session.active_controller_device_id === state.remoteAuth?.deviceId
  );
}

function renderSessionMeta(session) {
  dom.remoteSessionMeta.innerHTML = [
    metaChip("Status", currentStatusLabel(session)),
    metaChip("Security", securityModeLabel(session)),
    metaChip("Visibility", contentVisibilityLabel(session)),
    metaChip("Broker", brokerStatusLabel(session)),
    metaChip("Device", state.remoteAuth?.deviceLabel || "Unpaired"),
    metaChip(
      "Control",
      session.active_controller_device_id
        ? controllerLabel(session.active_controller_device_id)
        : "Unclaimed"
    ),
    session.active_thread_id
      ? metaChip("Thread", shortId(session.active_thread_id))
      : `<span class="meta-empty">No live session yet.</span>`,
  ].join("");
}

function renderControlBanner(session) {
  if (!session.active_thread_id || !session.active_controller_device_id) {
    dom.remoteControlBanner.hidden = true;
    return;
  }

  if (isCurrentDeviceActiveController(session)) {
    dom.remoteControlBanner.hidden = true;
    return;
  }

  dom.remoteControlBanner.hidden = false;
  dom.remoteControlSummary.textContent = `Controlled by ${controllerLabel(session.active_controller_device_id)}`;
  dom.remoteControlHint.textContent = "Read-only here until you take over.";
  dom.remoteTakeOverButton.hidden = false;
}

function renderOverviewCards() {}

function renderDeviceOverview() {}

function renderSessionOverview() {}

function metaChip(label, value) {
  return `
    <span class="meta-chip">
      <strong>${escapeHtml(label)}:</strong>
      <span>${escapeHtml(value)}</span>
    </span>
  `;
}

function securityModeLabel(session) {
  const mode = session?.security_mode || state.remoteAuth?.securityMode || "private";
  return mode === "managed" ? "Managed" : "Private";
}

function contentVisibilityLabel(session) {
  if (session?.broker_can_read_content) {
    return session.audit_enabled ? "Org-readable + audit" : "Readable";
  }
  return session?.e2ee_enabled ? "E2EE broker-blind" : "Broker-blind";
}

function brokerStatusLabel(session) {
  if (!session?.broker_channel_id) {
    return state.socketConnected ? "Connected" : "Connecting";
  }

  const brokerState = session.broker_connected ? "Connected" : "Offline";
  const channel = shortId(session.broker_channel_id);
  return session.broker_peer_id
    ? `${brokerState} · ${channel} · ${shortId(session.broker_peer_id)}`
    : `${brokerState} · ${channel}`;
}

function remoteAccessLabel() {
  if (!state.remoteAuth) {
    return "Unpaired";
  }

  if (selectedRelayNeedsRepair()) {
    return "This browser still knows this relay, but its local encrypted credentials are unavailable. Pair it again on this device to restore remote access.";
  }

  if (!state.session?.active_thread_id) {
    return "Standby until you start or resume a session";
  }

  if (!state.session.active_controller_device_id) {
    return "Standby until you send the first message";
  }

  if (state.session.active_controller_device_id === state.remoteAuth.deviceId) {
    if (!state.remoteAuth.sessionClaim) {
      return "Ready here; control refresh happens automatically when you type";
    }

    if (!state.remoteAuth.sessionClaimExpiresAt) {
      return "Ready to type from this browser";
    }

    return `Ready here until ${formatTimestamp(state.remoteAuth.sessionClaimExpiresAt)}`;
  }

  return `Viewing while ${controllerLabel(state.session.active_controller_device_id)} has control`;
}

function remoteAccessStatusText() {
  if (!state.remoteAuth) {
    return "Unpaired";
  }

  if (selectedRelayNeedsRepair()) {
    return "Re-pair required";
  }

  if (!state.session?.active_thread_id) {
    return "Standby";
  }

  if (!state.session.active_controller_device_id) {
    return "Auto-control";
  }

  if (state.session.active_controller_device_id === state.remoteAuth.deviceId) {
    return "Ready";
  }

  return "View only";
}

function remoteAccessBadgeTone() {
  if (!state.remoteAuth) {
    return "offline";
  }

  if (selectedRelayNeedsRepair()) {
    return "alert";
  }

  if (
    state.session?.active_thread_id &&
    state.session.active_controller_device_id &&
    state.session.active_controller_device_id !== state.remoteAuth.deviceId
  ) {
    return "alert";
  }

  return "ready";
}

function controlStatusText(session) {
  if (!session.active_controller_device_id) {
    return "Control unclaimed";
  }
  if (isCurrentDeviceActiveController(session)) {
    return "You have control";
  }
  return `Controlled by ${controllerLabel(session.active_controller_device_id)}`;
}

function controlStatusTone(session) {
  if (!session.active_controller_device_id) {
    return "alert";
  }
  return isCurrentDeviceActiveController(session) ? "ready" : "offline";
}

function brokerStatusText(session) {
  return session.broker_connected ? "Broker linked" : "Broker offline";
}

function controllerLabel(deviceId) {
  if (!deviceId) {
    return "Unclaimed";
  }

  if (deviceId === state.remoteAuth?.deviceId) {
    return `This device (${shortId(deviceId)})`;
  }

  return shortId(deviceId);
}

function statusBadgeMarkup(label, tone = "ready") {
  return `<span class="status-badge status-badge-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function updatePairingControls() {
  const pairingBusy = Boolean(state.pairingTicket) && state.pairingPhase !== "error";
  dom.connectButton.disabled = pairingBusy;
  dom.connectButton.textContent = pairingBusy ? pairingButtonLabel() : "Pair";
  dom.pairingInput.readOnly = pairingBusy;
}

function updateHomeButton() {
  dom.remoteHomeButton.hidden = !state.remoteAuth || !(state.relayDirectory?.length);
}

function syncWorkspaceHeading() {
  if (state.session?.active_thread_id) {
    return;
  }

  dom.remoteWorkspaceTitle.textContent = workspaceTitle();
  dom.remoteWorkspaceSubtitle.textContent = workspaceSubtitle();
  dom.remoteWorkspaceSubtitle.hidden = !dom.remoteWorkspaceSubtitle.textContent;
  dom.remoteWorkspaceTitle.title = "";
  dom.remoteWorkspaceSubtitle.title = dom.remoteWorkspaceSubtitle.textContent;
  renderSessionPath("");
}

function workspaceTitle() {
  if (state.remoteAuth) {
    return state.remoteAuth.relayLabel || "Remote surface ready";
  }
  if (state.pairingTicket) {
    return state.pairingPhase === "error" ? "Pairing failed" : "Pairing this browser";
  }
  if (state.relayDirectory?.length) {
    return "My relays";
  }
  return state.clientAuth ? "No relays yet" : "Pair this browser";
}

function workspaceSubtitle() {
  if (state.remoteAuth) {
    if (selectedRelayNeedsRepair()) {
      return "Local encrypted credentials are unavailable in this browser. Pair this relay again on this device to restore remote access.";
    }
    return "Remote device paired. Start a session, resume one from history, or wait for a live thread.";
  }
  if (state.pairingTicket) {
    return pairingCopy();
  }
  if (state.relayDirectory?.length) {
    return "This browser already has access to one or more relays. Open one from the home view or sidebar, or pair another from your local relay.";
  }
  return state.clientAuth
    ? "This browser has a client identity but no relay grants yet. Pair a relay from your local machine to add one here."
    : "Open a pairing QR from your local relay to control Codex remotely.";
}

function currentHeaderPath(session = state.session) {
  if (session?.current_cwd) {
    return session.current_cwd;
  }

  if (selectedRelayNeedsRepair()) {
    return "Re-pair this relay on this device to restore access.";
  }

  return "";
}

function currentStatusLabel(session = state.session) {
  if (session?.pending_approvals?.length) {
    return "Approval required";
  }

  if (selectedRelayNeedsRepair()) {
    return "Re-pair required";
  }

  if (session) {
    if (!state.socketConnected || !session.codex_connected) {
      return "Offline";
    }

    return session.current_status || "Ready";
  }

  if (state.socketConnected) {
    return "Connected";
  }

  if (state.pairingTicket) {
    return pairingBadgeText();
  }

  if (!state.remoteAuth && state.relayDirectory?.length) {
    return "Home";
  }

  return state.remoteAuth ? "Connecting" : "Offline";
}

function setStatusBadge(tone, label) {
  const compactLabel = compactStatusLabel(label);
  dom.remoteStatusBadge.textContent = compactLabel;
  dom.remoteStatusBadge.className = `status-badge status-badge-${tone} status-badge-compact`;
  dom.remoteStatusBadge.title = label;
  dom.remoteStatusBadge.setAttribute("aria-label", label);
}

function renderSessionPath(path) {
  if (!dom.remoteSessionPath) {
    return;
  }

  if (!path) {
    dom.remoteSessionPath.textContent = "No workspace path yet.";
    return;
  }

  dom.remoteSessionPath.textContent = path;
}

function compactStatusLabel(label) {
  const normalized = String(label || "").trim().toLowerCase();

  switch (normalized) {
    case "idle":
    case "ready":
      return "Ready";
    case "connected":
      return "Connected";
    case "home":
      return "Home";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting";
    case "approval required":
      return "Approval";
    case "re-pair required":
      return "Re-pair";
    case "pairing failed":
      return "Failed";
    case "approval pending":
      return "Pending";
    default:
      return label
        ? String(label)
            .trim()
            .replace(/\b\w/g, (char) => char.toUpperCase())
        : "Ready";
  }
}

function pairingHeading() {
  if (state.pairingPhase === "error") {
    return "Pairing needs attention";
  }
  if (state.pairingPhase === "requesting") {
    return "Waiting for local approval";
  }
  return "Pairing this browser";
}

function pairingCopy() {
  if (state.pairingPhase === "error") {
    return state.pairingError || "Pairing could not complete. Retry from this page or rescan the QR.";
  }
  if (state.pairingPhase === "requesting") {
    return "This browser sent its device key to the local relay and is waiting for local approval.";
  }
  return "This page is connecting to the broker with the scanned pairing ticket. You should not need to press Pair again.";
}

function pairingBadgeText() {
  if (state.pairingPhase === "error") {
    return "Pairing failed";
  }
  if (state.pairingPhase === "requesting") {
    return "Approval pending";
  }
  return "Pairing…";
}

function pairingBadgeTone() {
  if (state.pairingPhase === "error") {
    return "alert";
  }
  if (state.pairingPhase === "requesting") {
    return "ready";
  }
  return "alert";
}

function pairingButtonLabel() {
  if (state.pairingPhase === "requesting") {
    return "Waiting...";
  }
  return "Pairing...";
}

function selectedRelayNeedsRepair() {
  return Boolean(state.remoteAuth && !state.remoteAuth.payloadSecret);
}
