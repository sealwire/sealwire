import React from "react";

import { t } from "./i18n.js";
const h = React.createElement;

export function PairingQrImage({ alt = t("Pairing QR code"), src = "" }) {
  if (!src) {
    return null;
  }

  return h("img", {
    alt,
    className: "pairing-qr-image",
    src,
  });
}

function EmptyPanelMessage({ children }) {
  return h("p", { className: "sidebar-empty" }, children);
}

export function PendingPairingRequestsList({
  formatTimestamp = (value) => String(value || ""),
  requests = [],
  shortId = (value) => String(value || ""),
  // pairing_id -> "approve" | "reject" for decisions currently in flight. The
  // decision takes seconds (broker round-trips); disabling the card's buttons
  // and showing progress prevents the double-tap that used to rotate + revoke
  // the freshly-issued device credentials.
  pendingDecisions = {},
}) {
  if (!requests.length) {
    return h(EmptyPanelMessage, null, t("No devices are waiting for local approval."));
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
            t("{id} · requested {time}", {
              id: shortId(request.device_id),
              time: formatTimestamp(request.requested_at),
            })
          ),
          h("p", { className: "paired-device-meta" }, t("Broker peer {id}", { id: shortId(request.broker_peer_id) })),
          h(
            "p",
            { className: "paired-device-meta" },
            request.fingerprint
              ? t("Fingerprint {fingerprint}", { fingerprint: request.fingerprint })
              : t("Fingerprint Unavailable")
          ),
          h(
            "p",
            { className: "paired-device-meta" },
            Array.isArray(request.path_scope) && request.path_scope.length
              ? t("Path scope: {paths}", { paths: request.path_scope.join(", ") })
              : t("Path scope: unrestricted (relay roots only)")
          )
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
              disabled: Boolean(pendingDecisions[request.pairing_id]),
            },
            pendingDecisions[request.pairing_id] === "approve" ? t("Approving…") : t("Approve")
          ),
          h(
            "button",
            {
              className: "approval-button approval-button-danger",
              "data-pairing-decision": "reject",
              "data-pairing-id": request.pairing_id,
              type: "button",
              disabled: Boolean(pendingDecisions[request.pairing_id]),
            },
            pendingDecisions[request.pairing_id] === "reject" ? t("Rejecting…") : t("Reject")
          )
        )
      )
    )
  );
}

function deviceLifecycleLabel(state) {
  switch (state) {
    case "pending":
      return t("Pending");
    case "approved":
      return t("Approved");
    case "rejected":
      return t("Rejected");
    case "revoked":
      return t("Revoked");
    default:
      return t("Unknown");
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
