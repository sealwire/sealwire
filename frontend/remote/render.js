import * as dom from "./dom.js";
import {
  canCurrentDeviceWrite as canRemoteDeviceWrite,
  renderDeviceMeta as renderDeviceChrome,
  renderSessionChrome,
  resetRemoteSurfaceChrome,
  updateStatusBadge as updateChromeStatusBadge,
} from "./render-chrome.js";
import {
  renderEmptyState as renderTranscriptEmptyState,
  renderLog as appendClientLog,
  renderLogs,
  renderTranscriptPanel,
} from "./render-transcript.js";
import { state } from "./state.js";
import { escapeHtml, formatTimestamp, shortId } from "./utils.js";

let onResumeThread = () => {};
let onSelectRelay = () => {};

export function configureRenderHandlers(handlers) {
  onResumeThread = handlers.onResumeThread || onResumeThread;
  onSelectRelay = handlers.onSelectRelay || onSelectRelay;
}

export function renderSession(session) {
  state.session = session;
  const approval = session.pending_approvals?.[0] || null;
  const hasActiveSession = Boolean(session.active_thread_id);
  const hasControllerLease = canCurrentDeviceWrite(session);
  const canWrite = hasControllerLease;
  state.currentApprovalId = approval?.request_id || null;

  if (session.current_cwd && !dom.remoteThreadsCwdInput.value.trim()) {
    dom.remoteThreadsCwdInput.value = session.current_cwd;
  }

  syncRemoteModelSuggestions(session.available_models || [], session.model);

  renderSessionChrome(session);
  renderTranscriptPanel(session, approval, canWrite);
  renderLogs(session.logs || []);
  renderThreads(state.threads);

  dom.remoteSendButton.disabled = !hasActiveSession || !hasControllerLease;
  dom.remoteMessageInput.disabled = !hasActiveSession || !hasControllerLease;
  dom.remoteMessageInput.placeholder = !hasActiveSession
    ? "Start a remote session first."
    : hasControllerLease
      ? "Message Codex remotely..."
      : "Another device has control. Take over to reply.";
}

export function renderThreads(threads) {
  const filterValue = dom.remoteThreadsCwdInput.value.trim();
  const activeThreadId = state.session?.active_thread_id || null;

  if (!state.remoteAuth) {
    dom.remoteThreadsCount.textContent = "Remote session history";
    dom.remoteThreadsList.innerHTML = `<p class="sidebar-empty">${
      state.relayDirectory?.length
        ? "Open a relay to view its session history."
        : "Pair a relay, then refresh remote history."
    }</p>`;
    return;
  }

  dom.remoteThreadsCount.textContent = `${threads.length} ${threads.length === 1 ? "session" : "sessions"}`;

  if (!threads.length) {
    dom.remoteThreadsList.innerHTML = filterValue
      ? `<p class="sidebar-empty">No remote sessions found for this workspace filter.</p>`
      : `<p class="sidebar-empty">No remote sessions found yet.</p>`;
    return;
  }

  dom.remoteThreadsList.innerHTML = threads
    .map((thread) => {
      const title = thread.name || thread.preview || shortId(thread.id);
      const activeClass = activeThreadId === thread.id ? " is-active" : "";

      return `
        <button class="conversation-item${activeClass}" type="button" data-thread-id="${escapeHtml(thread.id)}">
          <span class="conversation-title">${escapeHtml(title)}</span>
          <span class="conversation-preview">${escapeHtml(thread.preview || "No preview yet.")}</span>
          <span class="conversation-meta">${escapeHtml(formatTimestamp(thread.updated_at))}</span>
        </button>
      `;
    })
    .join("");

  dom.remoteThreadsList.querySelectorAll("[data-thread-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onResumeThread(button.dataset.threadId);
    });
  });
}

export function renderRelayDirectory() {
  const relays = state.relayDirectory || [];
  dom.remoteRelaysCount.textContent = `${relays.length} ${relays.length === 1 ? "relay" : "relays"}`;

  if (!relays.length) {
    dom.remoteRelaysList.innerHTML = `<p class="sidebar-empty">Pair a relay from your local machine to add it here.</p>`;
    return;
  }

  dom.remoteRelaysList.innerHTML = relays
    .map((relay) => {
      const title = relay.relayLabel || relay.relayId;
      const subtitle = relaySubtitle(relay);
      const activeClass = state.remoteAuth?.relayId === relay.relayId ? " is-active" : "";
      const actionLabel = relay.hasLocalProfile
        ? "Open relay"
        : relay.needsLocalRePairing
          ? "Re-pair relay"
          : "Pair again";
      return `
        <button class="conversation-item${activeClass}" type="button" data-relay-id="${escapeHtml(relay.relayId)}" ${relay.hasLocalProfile ? "" : "disabled"}>
          <span class="conversation-title">${escapeHtml(title)}</span>
          <span class="conversation-preview">${escapeHtml(subtitle)}</span>
          <span class="conversation-meta">${escapeHtml(relay.brokerRoomId || relay.relayId)} · ${escapeHtml(actionLabel)}</span>
        </button>
      `;
    })
    .join("");

  dom.remoteRelaysList.querySelectorAll("[data-relay-id]").forEach((button) => {
    button.addEventListener("click", () => {
      onSelectRelay(button.dataset.relayId);
    });
  });
}

export function renderDeviceMeta() {
  renderDeviceChrome();
  renderRelayDirectory();
}

export function renderEmptyState() {
  syncIdleSurfaceControls();

  if (!state.remoteAuth && !state.pairingTicket) {
    renderRelayHome();
    return;
  }

  if (state.remoteAuth && !state.remoteAuth.payloadSecret && !state.pairingTicket) {
    renderMissingCredentialsState();
    return;
  }

  renderTranscriptEmptyState();
}

export function setRemoteSessionPanelOpen(open) {
  if (!state.remoteAuth) {
    dom.remoteSessionPanel.hidden = true;
    dom.remoteSessionToggle.setAttribute("aria-expanded", "false");
    dom.remoteSessionToggle.textContent = "Select a relay first";
    return;
  }
  dom.remoteSessionPanel.hidden = !open;
  dom.remoteSessionToggle.setAttribute("aria-expanded", String(open));
  dom.remoteSessionToggle.textContent = open ? "Close Remote Session Setup" : "Start Remote Session";
}

export function updateStatusBadge() {
  updateChromeStatusBadge();
}

export function renderLog(message) {
  appendClientLog(message);
}

export function resetRemoteSurface() {
  renderThreads([]);
  resetRemoteSurfaceChrome();
}

export function isCurrentDeviceActiveController(session) {
  return isRemoteController(session);
}

export function canCurrentDeviceWrite(session) {
  return canRemoteDeviceWrite(session);
}

function syncRemoteModelSuggestions(models, selectedModel) {
  const currentValue =
    selectedModel
    || dom.remoteModelInput.value
    || models.find((model) => model.is_default)?.model
    || "gpt-5.4";
  const options = [...models];
  if (currentValue && !options.some((model) => model.model === currentValue)) {
    options.unshift({
      model: currentValue,
      display_name: currentValue,
    });
  }

  dom.remoteModelInput.innerHTML = options
    .map((model) => `<option value="${escapeHtml(model.model)}">${escapeHtml(model.display_name)}</option>`)
    .join("");
  dom.remoteModelInput.value = currentValue;
}

function renderRelayHome() {
  if (state.relayDirectory?.length) {
    dom.remoteTranscript.innerHTML = `
      <div class="relay-home">
        <section class="thread-empty relay-home-empty">
          <span class="thread-empty-badge">My relays</span>
          <h2>Choose a relay</h2>
          <p>This browser already has access to one or more relays. Open one below, or pair another from your local machine.</p>
        </section>
        <section class="relay-home-list">
          ${state.relayDirectory.map(renderRelayHomeCard).join("")}
        </section>
      </div>
    `;

    dom.remoteTranscript.querySelectorAll("[data-relay-home-id]").forEach((button) => {
      button.addEventListener("click", () => {
        onSelectRelay(button.dataset.relayHomeId);
      });
    });
    return;
  }

  dom.remoteTranscript.innerHTML = `
    <div class="thread-empty relay-home-empty">
      <span class="thread-empty-badge">Pairing</span>
      <h2>${state.clientAuth ? "No relays yet" : "Pair your first relay"}</h2>
      <p>${
        state.clientAuth
          ? "This browser has a client identity but no relay grants yet. Open a new QR code from a local relay to add one here."
          : "Open a pairing QR code from your local relay to add your first remote surface to this browser."
      }</p>
    </div>
  `;
}

function renderRelayHomeCard(relay) {
  const title = relay.relayLabel || relay.relayId;
  const subtitle = relay.hasLocalProfile
    ? relay.deviceLabel || relay.deviceId
    : relay.needsLocalRePairing
      ? "Local credentials are missing in this browser. Pair this relay again to restore remote access."
      : "This browser can see the grant, but it does not have local encrypted access for this relay yet.";
  const meta = relay.grantedAt
    ? `Granted ${formatTimestamp(relay.grantedAt)}`
    : relay.brokerRoomId || relay.relayId;
  const cta = relay.hasLocalProfile
    ? "Open relay"
    : relay.needsLocalRePairing
      ? "Re-pair in this browser"
      : "Pair again in this browser";

  return `
    <button class="relay-home-card" type="button" data-relay-home-id="${escapeHtml(relay.relayId)}" ${relay.hasLocalProfile ? "" : "disabled"}>
      <div class="relay-home-card-copy">
        <span class="relay-home-card-label">${escapeHtml(title)}</span>
        <strong class="relay-home-card-title">${escapeHtml(title)}</strong>
        <p class="relay-home-card-body">${escapeHtml(subtitle)}</p>
      </div>
      <div class="relay-home-card-meta">
        <span>${escapeHtml(meta)}</span>
        <span>${escapeHtml(cta)}</span>
      </div>
    </button>
  `;
}

function syncIdleSurfaceControls() {
  const hasRelay = Boolean(state.remoteAuth);
  const hasUsableRelay = Boolean(state.remoteAuth?.payloadSecret);
  dom.remoteSessionToggle.disabled = !hasUsableRelay;
  dom.remoteThreadsRefreshButton.disabled = !hasUsableRelay;
  dom.remoteThreadsCwdInput.disabled = !hasUsableRelay;
  dom.remoteStartSessionButton.disabled = !hasUsableRelay;

  if (!hasUsableRelay) {
    setRemoteSessionPanelOpen(false);
  }

  dom.remoteSendButton.disabled = true;
  dom.remoteMessageInput.disabled = true;
  dom.remoteMessageInput.placeholder = !hasRelay
    ? state.relayDirectory?.length
      ? "Open a relay before sending messages."
      : "Pair this browser before sending messages."
    : hasUsableRelay
      ? "Start or resume a remote session first."
      : "Local credentials are unavailable. Pair this relay again in this browser.";
  dom.remoteHomeButton.hidden = !hasRelay;
  dom.remoteHomeButton.disabled = !hasRelay;
}

function relaySubtitle(relay) {
  if (relay.hasLocalProfile) {
    return relay.deviceLabel || relay.deviceId;
  }

  if (relay.needsLocalRePairing) {
    return "Local credentials are missing in this browser. Pair this relay again to restore encrypted access.";
  }

  return "Grant exists, but this browser does not have local encrypted access yet.";
}

function renderMissingCredentialsState() {
  const relayLabel = state.remoteAuth?.relayLabel || state.remoteAuth?.deviceLabel || "This relay";
  dom.remoteTranscript.innerHTML = `
    <div class="thread-empty relay-home-empty">
      <span class="thread-empty-badge">Re-pair required</span>
      <h2>Local credentials missing</h2>
      <p>${escapeHtml(relayLabel)} is still known to this browser, but its local encrypted credentials are unavailable.</p>
      <p>Pair this relay again on this device to restore remote access.</p>
    </div>
  `;
}
