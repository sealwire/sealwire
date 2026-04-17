import * as dom from "../dom.js";
import { escapeHtml, formatTimestamp } from "../utils.js";

export function renderRelayHome({ clientAuth, relayDirectory, onSelectRelay }) {
  if (relayDirectory?.length) {
    dom.remoteTranscript.innerHTML = `
      <div class="relay-home">
        <section class="thread-empty relay-home-empty">
          <span class="thread-empty-badge">My relays</span>
          <h2>Choose a relay</h2>
          <p>This browser already has access to one or more relays. Open one below, or pair another from your local machine.</p>
        </section>
        <section class="relay-home-list">
          ${relayDirectory.map(renderRelayHomeCard).join("")}
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
      <h2>${clientAuth ? "No relays yet" : "Pair your first relay"}</h2>
      <p>${
        clientAuth
          ? "This browser has a client identity but no relay grants yet. Open a new QR code from a local relay to add one here."
          : "Open a pairing QR code from your local relay to add your first remote surface to this browser."
      }</p>
    </div>
  `;
}

export function syncIdleSurfaceControls({ remoteAuth, relayDirectory, setRemoteSessionPanelOpen }) {
  const hasRelay = Boolean(remoteAuth);
  const hasUsableRelay = Boolean(remoteAuth?.payloadSecret);
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
    ? relayDirectory?.length
      ? "Open a relay before sending messages."
      : "Pair this browser before sending messages."
    : hasUsableRelay
      ? "Start or resume a remote session first."
      : "Local credentials are unavailable. Pair this relay again in this browser.";
  dom.remoteHomeButton.hidden = !hasRelay;
  dom.remoteHomeButton.disabled = !hasRelay;
}

export function relaySubtitle(relay) {
  if (relay.hasLocalProfile) {
    return relay.deviceLabel || relay.deviceId;
  }

  if (relay.needsLocalRePairing) {
    return "Local credentials are missing in this browser. Pair this relay again to restore encrypted access.";
  }

  return "Grant exists, but this browser does not have local encrypted access yet.";
}

export function renderMissingCredentialsState(remoteAuth) {
  const relayLabel = remoteAuth?.relayLabel || remoteAuth?.deviceLabel || "This relay";
  dom.remoteTranscript.innerHTML = `
    <div class="thread-empty relay-home-empty">
      <span class="thread-empty-badge">Re-pair required</span>
      <h2>Local credentials missing</h2>
      <p>${escapeHtml(relayLabel)} is still known to this browser, but its local encrypted credentials are unavailable.</p>
      <p>Pair this relay again on this device to restore remote access.</p>
    </div>
  `;
}

function renderRelayHomeCard(relay) {
  const relayId = relay.relayId || relay.brokerRoomId || relay.deviceId || "";
  const title =
    relay.relayLabel || relay.relayId || relay.brokerRoomId || relay.deviceLabel || relay.deviceId || "Unknown relay";
  const subtitle = relay.hasLocalProfile
    ? relay.deviceLabel || relay.deviceId
    : relay.needsLocalRePairing
      ? "Local credentials are missing in this browser. Pair this relay again to restore remote access."
      : "This browser can see the grant, but it does not have local encrypted access for this relay yet.";
  const meta = relay.grantedAt
    ? `Granted ${formatTimestamp(relay.grantedAt)}`
    : relay.brokerRoomId || relayId;
  const cta = relay.hasLocalProfile
    ? "Open relay"
    : relay.needsLocalRePairing
      ? "Re-pair in this browser"
      : "Pair again in this browser";

  return `
    <button class="relay-home-card" type="button" data-relay-home-id="${escapeHtml(relayId)}" ${relay.hasLocalProfile && relayId ? "" : "disabled"}>
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
