import {
  allowedRootsInput,
  allowedRootsList,
  allowedRootsSummary,
  pairedDevicesList,
  pairingExpiry,
  pairingLinkInput,
  pairingPanel,
  pairingQr,
  pendingPairingsList,
} from "./dom.js";
import { svgDataUrl } from "../svg.js";

let helpers = {
  escapeHtml(value) {
    return String(value);
  },
  formatTimestamp(value) {
    return String(value);
  },
  shortId(value) {
    return String(value);
  },
  workspaceBasename(value) {
    return String(value);
  },
};

export function configureSecurityRenderers(nextHelpers) {
  helpers = {
    ...helpers,
    ...nextHelpers,
  };
}

export function renderPairingPanel(pairing) {
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
  pairingExpiry.textContent = `Expires ${helpers.formatTimestamp(pairing.expires_at)}`;
}

export function renderAllowedRoots(roots, { draftDirty = false } = {}) {
  const configuredRoots = Array.isArray(roots) ? roots : [];

  if (!draftDirty && allowedRootsInput) {
    allowedRootsInput.value = configuredRoots.join("\n");
  }

  if (!configuredRoots.length) {
    allowedRootsSummary.textContent =
      "This relay is currently unrestricted. Any device can start or resume sessions in any workspace.";
    allowedRootsList.innerHTML = `<p class="sidebar-empty">No workspace restrictions are configured.</p>`;
    return;
  }

  allowedRootsSummary.textContent =
    configuredRoots.length === 1
      ? "Every device on this relay is limited to one root directory."
      : `Every device on this relay is limited to ${configuredRoots.length} root directories.`;

  allowedRootsList.innerHTML = configuredRoots
    .map((root) => {
      const name = helpers.workspaceBasename(root) || root;
      return `
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <div class="paired-device-heading">
              <strong>${helpers.escapeHtml(name)}</strong>
              <span class="device-state-badge device-state-approved">Allowed root</span>
            </div>
            <p class="paired-device-meta paired-device-id">${helpers.escapeHtml(root)}</p>
          </div>
        </article>
      `;
    })
    .join("");
}

export function renderDeviceRecords(records) {
  if (!records.length) {
    pairedDevicesList.innerHTML = `<p class="sidebar-empty">No remote devices have touched this relay yet.</p>`;
    return;
  }

  const activeRecords = records.filter((record) => record.lifecycle_state !== "revoked");
  const revokedRecords = records.filter((record) => record.lifecycle_state === "revoked");

  const renderCard = (record) => {
    const lastSeen = record.last_seen_at ? helpers.formatTimestamp(record.last_seen_at) : "Never";
    const lastPeer = record.last_peer_id ? helpers.shortId(record.last_peer_id) : "None";
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
            <strong>${helpers.escapeHtml(record.label)}</strong>
            <span class="device-state-badge ${deviceLifecycleBadgeClass(record.lifecycle_state)}">${helpers.escapeHtml(deviceLifecycleLabel(record.lifecycle_state))}</span>
          </div>
          <p class="paired-device-meta paired-device-id">${helpers.escapeHtml(record.device_id)}</p>
          <dl class="paired-device-fields">
            <div class="paired-device-field">
              <dt>Last Seen</dt>
              <dd>${helpers.escapeHtml(lastSeen)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>Last Peer</dt>
              <dd>${helpers.escapeHtml(lastPeer)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>Broker Ticket</dt>
              <dd>${helpers.escapeHtml(ticketExpiry)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>Fingerprint</dt>
              <dd class="paired-device-fingerprint">${helpers.escapeHtml(fingerprint)}</dd>
            </div>
            <div class="paired-device-field">
              <dt>State Updated</dt>
              <dd>${helpers.escapeHtml(helpers.formatTimestamp(record.state_changed_at))}</dd>
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
                  data-revoke-others-except-device-id="${helpers.escapeHtml(record.device_id)}"
                >
                  Keep Only This
                </button>
                <button
                  class="approval-button approval-button-danger"
                  type="button"
                  data-revoke-device-id="${helpers.escapeHtml(record.device_id)}"
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

export function renderPendingPairingRequests(requests) {
  if (!requests.length) {
    pendingPairingsList.innerHTML = `<p class="sidebar-empty">No devices are waiting for local approval.</p>`;
    return;
  }

  pendingPairingsList.innerHTML = requests
    .map((request) => {
      return `
        <article class="paired-device-card">
          <div class="paired-device-copy">
            <div class="paired-device-heading">
              <strong>${helpers.escapeHtml(request.label)}</strong>
              <span class="device-state-badge ${deviceLifecycleBadgeClass(request.lifecycle_state)}">${helpers.escapeHtml(deviceLifecycleLabel(request.lifecycle_state))}</span>
            </div>
            <p class="paired-device-meta">${helpers.escapeHtml(helpers.shortId(request.device_id))} · requested ${helpers.escapeHtml(helpers.formatTimestamp(request.requested_at))}</p>
            <p class="paired-device-meta">Broker peer ${helpers.escapeHtml(helpers.shortId(request.broker_peer_id))}</p>
            <p class="paired-device-meta">Fingerprint ${helpers.escapeHtml(request.fingerprint || "Unavailable")}</p>
          </div>
          <div class="paired-device-actions">
            <button
              class="approval-button approval-button-primary"
              type="button"
              data-pairing-id="${helpers.escapeHtml(request.pairing_id)}"
              data-pairing-decision="approve"
            >
              Approve
            </button>
            <button
              class="approval-button approval-button-danger"
              type="button"
              data-pairing-id="${helpers.escapeHtml(request.pairing_id)}"
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

  return helpers.formatTimestamp(expiresAt);
}
