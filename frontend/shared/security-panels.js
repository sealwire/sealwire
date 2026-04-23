import React from "react";

const h = React.createElement;

export function PairingQrImage({ alt = "Pairing QR code", src = "" }) {
  if (!src) {
    return null;
  }

  return h("img", {
    alt,
    className: "pairing-qr-image",
    src,
  });
}

export function EmptyPanelMessage({ children }) {
  return h("p", { className: "sidebar-empty" }, children);
}

export function AllowedRootsList({
  roots = [],
  workspaceBasename = (value) => String(value || ""),
}) {
  if (!roots.length) {
    return h(EmptyPanelMessage, null, "No workspace restrictions are configured.");
  }

  return h(
    React.Fragment,
    null,
    ...roots.map((root) => {
      const name = workspaceBasename(root) || root;
      return h(
        "article",
        { className: "paired-device-card", key: root },
        h(
          "div",
          { className: "paired-device-copy" },
          h(
            "div",
            { className: "paired-device-heading" },
            h("strong", null, name),
            h("span", { className: "device-state-badge device-state-approved" }, "Allowed root")
          ),
          h("p", { className: "paired-device-meta paired-device-id" }, root)
        )
      );
    })
  );
}

export function DeviceRecordsList({
  formatTimestamp = (value) => String(value || ""),
  records = [],
  shortId = (value) => String(value || ""),
}) {
  if (!records.length) {
    return h(EmptyPanelMessage, null, "No remote devices have touched this relay yet.");
  }

  const activeRecords = records.filter((record) => record.lifecycle_state !== "revoked");
  const revokedRecords = records.filter((record) => record.lifecycle_state === "revoked");

  return h(
    React.Fragment,
    null,
    activeRecords.length
      ? activeRecords.map((record) =>
          h(DeviceRecordCard, {
            formatTimestamp,
            key: record.device_id,
            record,
            shortId,
          })
        )
      : !revokedRecords.length
        ? h(EmptyPanelMessage, null, "No active devices.")
        : null,
    revokedRecords.length
      ? h(
          "details",
          { className: "revoked-drawer" },
          h(
            "summary",
            null,
            `${revokedRecords.length} Revoked Device${revokedRecords.length === 1 ? "" : "s"}`
          ),
          h(
            "div",
            { className: "revoked-devices-nested" },
            ...revokedRecords.map((record) =>
              h(DeviceRecordCard, {
                formatTimestamp,
                key: record.device_id,
                record,
                shortId,
              })
            )
          )
        )
      : null
  );
}

function DeviceRecordCard({ formatTimestamp, record, shortId }) {
  const lastSeen = record.last_seen_at ? formatTimestamp(record.last_seen_at) : "Never";
  const lastPeer = record.last_peer_id ? shortId(record.last_peer_id) : "None";
  const fingerprint = record.fingerprint || "Unavailable";
  const canManage = record.lifecycle_state === "approved";
  const ticketExpiry = formatBrokerJoinTicketExpiry(
    record.lifecycle_state,
    record.broker_join_ticket_expires_at,
    formatTimestamp
  );

  return h(
    "article",
    { className: "paired-device-card" },
    h(
      "div",
      { className: "paired-device-copy" },
      h(
        "div",
        { className: "paired-device-heading" },
        h("strong", null, record.label),
        h(
          "span",
          { className: `device-state-badge ${deviceLifecycleBadgeClass(record.lifecycle_state)}` },
          deviceLifecycleLabel(record.lifecycle_state)
        )
      ),
      h("p", { className: "paired-device-meta paired-device-id" }, record.device_id),
      h(
        "dl",
        { className: "paired-device-fields" },
        hDeviceField("Last Seen", lastSeen),
        hDeviceField("Last Peer", lastPeer),
        hDeviceField("Broker Ticket", ticketExpiry),
        hDeviceField("Fingerprint", fingerprint, "paired-device-fingerprint"),
        hDeviceField("State Updated", formatTimestamp(record.state_changed_at))
      )
    ),
    canManage
      ? h(
          "div",
          { className: "paired-device-actions" },
          h(
            "button",
            {
              className: "approval-button",
              "data-revoke-others-except-device-id": record.device_id,
              type: "button",
            },
            "Keep Only This"
          ),
          h(
            "button",
            {
              className: "approval-button approval-button-danger",
              "data-revoke-device-id": record.device_id,
              type: "button",
            },
            "Revoke"
          )
        )
      : null
  );
}

export function PendingPairingRequestsList({
  formatTimestamp = (value) => String(value || ""),
  requests = [],
  shortId = (value) => String(value || ""),
}) {
  if (!requests.length) {
    return h(EmptyPanelMessage, null, "No devices are waiting for local approval.");
  }

  return h(
    React.Fragment,
    null,
    ...requests.map((request) =>
      h(
        "article",
        { className: "paired-device-card", key: request.pairing_id },
        h(
          "div",
          { className: "paired-device-copy" },
          h(
            "div",
            { className: "paired-device-heading" },
            h("strong", null, request.label),
            h(
              "span",
              { className: `device-state-badge ${deviceLifecycleBadgeClass(request.lifecycle_state)}` },
              deviceLifecycleLabel(request.lifecycle_state)
            )
          ),
          h(
            "p",
            { className: "paired-device-meta" },
            `${shortId(request.device_id)} · requested ${formatTimestamp(request.requested_at)}`
          ),
          h("p", { className: "paired-device-meta" }, `Broker peer ${shortId(request.broker_peer_id)}`),
          h("p", { className: "paired-device-meta" }, `Fingerprint ${request.fingerprint || "Unavailable"}`)
        ),
        h(
          "div",
          { className: "paired-device-actions" },
          h(
            "button",
            {
              className: "approval-button approval-button-primary",
              "data-pairing-decision": "approve",
              "data-pairing-id": request.pairing_id,
              type: "button",
            },
            "Approve"
          ),
          h(
            "button",
            {
              className: "approval-button approval-button-danger",
              "data-pairing-decision": "reject",
              "data-pairing-id": request.pairing_id,
              type: "button",
            },
            "Reject"
          )
        )
      )
    )
  );
}

function hDeviceField(label, value, valueClassName = "") {
  return h(
    "div",
    { className: "paired-device-field" },
    h("dt", null, label),
    h("dd", valueClassName ? { className: valueClassName } : null, value)
  );
}

export function deviceLifecycleLabel(state) {
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

export function deviceLifecycleBadgeClass(state) {
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

function formatBrokerJoinTicketExpiry(state, expiresAt, formatTimestamp) {
  if (state !== "approved") {
    return "Not active";
  }

  if (!expiresAt) {
    return "Until revoked";
  }

  return formatTimestamp(expiresAt);
}
