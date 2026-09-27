// Settings > Devices (who is paired) and Settings > Access (which folders they may open).

import React from "react";
import { PairingQrImage, PendingPairingRequestsList } from "../shared/security-panels.js";
import { SettingsHint, SettingsPage, SettingsSection } from "../shared/settings-frame.js";
import {
  deviceStatusLine,
  expiresInLabel,
  pastDevicesLabel,
  pathScopeLabel,
  splitDeviceRecords,
  workspaceName,
} from "../shared/settings-model.js";
import { svgDataUrl } from "../svg.js";

const h = React.createElement;
const HISTORY_PREVIEW = 4;

export function DevicesPage({ active, devices, pairing, roots, formatTimestamp, shortId, now }) {
  if (pairing.open) {
    return h(
      SettingsPage,
      {
        pageKey: "devices",
        active,
        title: "Pair new device",
        parent: { label: "Devices", onBack: pairing.onCancel },
      },
      h(PairingBody, { pairing, roots, now })
    );
  }
  const { current, past } = splitDeviceRecords(devices.records);
  const approvedCount = current.filter((record) => record.lifecycle_state === "approved").length;
  return h(
    SettingsPage,
    {
      pageKey: "devices",
      active,
      title: "Devices",
      actions: h(
        "button",
        {
          className: "settings-button is-primary",
          disabled: pairing.busy,
          id: "start-pairing-button",
          onClick: () => pairing.onOpen([]),
          type: "button",
        },
        "Pair new device"
      ),
    },
    // Only drawn when someone is actually waiting; an empty "pending" box is noise.
    devices.pending.length
      ? h(
          SettingsSection,
          { title: "Waiting for approval", className: "settings-pending" },
          h(
            "div",
            {
              className: "paired-devices-list",
              id: "pending-pairings-list",
              onClick: (event) => {
                const button = event.target.closest("[data-pairing-id][data-pairing-decision]");
                if (button) {
                  devices.onDecide(button.dataset.pairingId, button.dataset.pairingDecision);
                }
              },
            },
            h(PendingPairingRequestsList, {
              formatTimestamp,
              pendingDecisions: devices.pendingDecisions,
              requests: devices.pending,
              shortId,
            })
          )
        )
      : null,
    h(
      SettingsSection,
      { title: "Paired", meta: String(current.length) },
      current.length
        ? h(
            "ul",
            { className: "settings-list", id: "paired-devices-list" },
            ...current.map((record) =>
              h(DeviceRow, {
                key: record.device_id,
                canRevokeOthers: approvedCount > 1,
                formatTimestamp,
                now,
                onRevoke: devices.onRevoke,
                onRevokeOthers: devices.onRevokeOthers,
                record,
              })
            )
          )
        : h(
            "p",
            { className: "settings-empty", id: "paired-devices-list" },
            "No devices paired yet. Pair your phone to use this relay away from your desk."
          )
    ),
    past.length
      ? h(DeviceHistory, { formatTimestamp, onClear: devices.onClearHistory, records: past })
      : null
  );
}

function DeviceRow({ record, canRevokeOthers, formatTimestamp, now, onRevoke, onRevokeOthers }) {
  const [open, setOpen] = React.useState(false);
  const approved = record.lifecycle_state === "approved";
  return h(
    "li",
    { className: `settings-row settings-device${open ? " is-open" : ""}`, "data-device-id": record.device_id },
    h(
      "button",
      {
        "aria-expanded": open ? "true" : "false",
        className: "settings-row-toggle",
        onClick: () => setOpen(!open),
        type: "button",
      },
      h(Chevron, { open }),
      h("span", { className: "settings-row-mark", "aria-hidden": "true" }, h(PhoneGlyph)),
      h(
        "span",
        { className: "settings-row-copy" },
        h("span", { className: "settings-row-title" }, record.label || "Unnamed device"),
        h("span", { className: "settings-row-sub settings-mono" }, record.device_id)
      ),
      h(
        "span",
        { className: `settings-row-status${approved ? "" : " is-alert"}` },
        deviceStatusLine(record, now)
      )
    ),
    open
      ? h(
          "div",
          { className: "settings-row-detail" },
          h(
            "dl",
            { className: "settings-fields" },
            field("Fingerprint", record.fingerprint || "Unavailable", true),
            field("Access", pathScopeLabel(record.path_scope)),
            field(
              "Broker ticket",
              approved
                ? record.broker_join_ticket_expires_at
                  ? `Expires ${formatTimestamp(record.broker_join_ticket_expires_at)}`
                  : "Until revoked"
                : "Not active"
            ),
            field("Paired", formatTimestamp(record.created_at))
          ),
          approved
            ? h(
                "div",
                { className: "settings-row-actions" },
                canRevokeOthers
                  ? h(
                      "button",
                      {
                        className: "settings-button",
                        "data-revoke-others-except-device-id": record.device_id,
                        onClick: () => onRevokeOthers(record.device_id),
                        type: "button",
                      },
                      "Revoke all others"
                    )
                  : null,
                h(
                  "button",
                  {
                    className: "settings-button is-danger",
                    "data-revoke-device-id": record.device_id,
                    onClick: () => onRevoke(record.device_id),
                    type: "button",
                  },
                  "Revoke"
                )
              )
            : null
        )
      : null
  );
}

function DeviceHistory({ records, formatTimestamp, onClear }) {
  const [open, setOpen] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const visible = showAll ? records : records.slice(0, HISTORY_PREVIEW);
  const hiddenCount = records.length - visible.length;
  return h(
    "div",
    { className: "settings-history" },
    h(
      "button",
      {
        "aria-expanded": open ? "true" : "false",
        className: "settings-history-toggle",
        onClick: () => setOpen(!open),
        type: "button",
      },
      h(Chevron, { open }),
      pastDevicesLabel(records)
    ),
    open
      ? h(
          "ul",
          { className: "settings-history-list" },
          ...visible.map((record) =>
            h(
              "li",
              { key: record.device_id, className: "settings-history-row" },
              h("span", { className: "settings-history-label" }, record.label || "Unnamed device"),
              h("span", { className: "settings-mono settings-history-id" }, record.device_id),
              h(
                "span",
                { className: "settings-history-when" },
                `${record.lifecycle_state === "rejected" ? "rejected" : "revoked"} ${formatTimestamp(record.state_changed_at)}`
              )
            )
          ),
          h(
            "li",
            { className: "settings-history-more" },
            hiddenCount > 0
              ? h(
                  "button",
                  { className: "settings-link", onClick: () => setShowAll(true), type: "button" },
                  `Show ${hiddenCount} more`
                )
              : null,
            hiddenCount > 0 ? h("span", { "aria-hidden": "true" }, " · ") : null,
            h(
              "button",
              {
                className: "settings-link",
                id: "clear-device-history-button",
                onClick: () => onClear(records.length),
                type: "button",
              },
              "Clear history"
            )
          )
        )
      : null
  );
}

function PairingBody({ pairing, roots, now }) {
  const ticket = pairing.ticket;
  const requested = pairing.requestedScope;
  const [mode, setMode] = React.useState(requested.length ? "folder" : "all");
  const [folder, setFolder] = React.useState(requested[0] || "");
  const [copied, setCopied] = React.useState(false);

  // With no code on show (it failed), the same scope again is a retry, not a repeat.
  const ask = (scope) => {
    if (!sameScope(scope, requested) || !ticket) {
      pairing.onRegenerate(scope);
    }
  };
  const applyFolder = () => {
    const path = folder.trim();
    if (path) {
      ask([path]);
    }
  };
  const chooseAll = () => {
    setMode("all");
    ask([]);
  };
  const chooseFolder = () => {
    setMode("folder");
    applyFolder();
  };
  // A phone scans what it sees: show a code only if it answers what the page says right
  // now, typed folder included. Compared as typed: the relay expands "~" in its answer.
  const typed = folder.trim();
  const wanted = mode === "all" ? [] : typed ? [typed] : null;
  const shown = ticket && !pairing.busy && wanted && sameScope(requested, wanted) ? ticket : null;
  const copy = async () => {
    if (await pairing.onCopy()) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const qr = shown
    ? h(PairingQrImage, { src: svgDataUrl(shown.pairing_qr_svg) })
    : h(
        "span",
        { className: "settings-qr-placeholder" },
        pairing.busy
          ? "Creating code…"
          : !wanted
            ? "Choose a folder, then press Use"
            : sameScope(requested, wanted)
              ? "No code"
              : "Press Use to make a code for this folder"
      );
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "settings-pairing", id: "pairing-panel" },
      h(
        "div",
        { className: "settings-pairing-code" },
        h("div", { "aria-live": "polite", className: "pairing-qr settings-qr", id: "pairing-qr" }, qr),
        h(
          "p",
          { className: "settings-pairing-status" },
          pairing.error
            ? h(
                React.Fragment,
                null,
                h("span", { className: "is-alert" }, pairing.error),
                " · ",
                h(
                  "button",
                  {
                    className: "settings-link",
                    disabled: pairing.busy,
                    onClick: () => pairing.onRegenerate(requested),
                    type: "button",
                  },
                  "try again"
                )
              )
            : shown && pairing.scanned
              ? "Scanned — approve the request to finish"
              : shown
                ? "Waiting for scan…"
                : ""
        ),
        shown
          ? h(
              "p",
              { className: "settings-hint", id: "pairing-expiry" },
              expiresInLabel(shown.expires_at, now),
              " · ",
              h(
                "button",
                {
                  className: "settings-link",
                  disabled: pairing.busy,
                  onClick: () => pairing.onRegenerate(requested),
                  type: "button",
                },
                "new code"
              )
            )
          : null
      ),
      h(
        "div",
        { className: "settings-pairing-side" },
        h(
          "ol",
          { className: "settings-steps" },
          h("li", null, "Open the camera on your phone and scan the code."),
          h("li", null, "Confirm the fingerprint matches on both screens, then approve.")
        ),
        h(
          "fieldset",
          { className: "settings-scope" },
          h("legend", { className: "settings-section-title" }, "This device can open"),
          h(
            "label",
            { className: "settings-choice" },
            h("input", {
              checked: mode === "all",
              name: "pairing-scope",
              onChange: chooseAll,
              type: "radio",
            }),
            h(
              "span",
              null,
              h("span", { className: "settings-choice-title" }, "All roots"),
              h(
                "span",
                { className: "settings-choice-sub" },
                roots.length ? roots.map(workspaceName).join(", ") : "Any folder on this relay"
              )
            )
          ),
          h(
            "label",
            { className: "settings-choice" },
            h("input", {
              checked: mode === "folder",
              name: "pairing-scope",
              onChange: chooseFolder,
              type: "radio",
            }),
            h("span", { className: "settings-choice-title" }, "One folder only")
          ),
          mode === "folder"
            ? h(
                "form",
                {
                  className: "settings-inline-form",
                  onSubmit: (event) => {
                    event.preventDefault();
                    applyFolder();
                  },
                },
                h("input", {
                  "aria-label": "Folder this device may open",
                  autoComplete: "off",
                  className: "settings-input",
                  id: "pairing-path-scope-input",
                  list: "workspace-suggestions",
                  onChange: (event) => setFolder(event.target.value),
                  placeholder: "~/projects/one-repo",
                  type: "text",
                  value: folder,
                }),
                h(
                  "button",
                  { className: "settings-button", disabled: pairing.busy || !folder.trim(), type: "submit" },
                  "Use"
                )
              )
            : null
        ),
        h(
          "div",
          { className: "settings-link-row" },
          h("p", { className: "settings-section-title" }, "Or send the link"),
          h(
            "div",
            { className: "settings-inline-form" },
            h("input", {
              "aria-label": "Pairing link",
              className: "settings-input settings-mono",
              id: "pairing-link-input",
              readOnly: true,
              type: "text",
              value: shown?.pairing_url || "",
            }),
            h(
              "button",
              {
                className: "settings-button",
                disabled: !shown,
                id: "copy-pairing-link-button",
                onClick: copy,
                type: "button",
              },
              copied ? "Copied" : "Copy"
            )
          )
        )
      )
    ),
    h(
      "div",
      { className: "settings-pairing-foot" },
      h(SettingsHint, null, "The code works once. Anyone with it can ask to pair — you still approve each request."),
      h("button", { className: "settings-button", onClick: pairing.onCancel, type: "button" }, "Cancel")
    )
  );
}

export function AccessPage({ active, access, records }) {
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const roots = access.roots;
  const approved = splitDeviceRecords(records).current.filter(
    (record) => record.lifecycle_state === "approved"
  );

  const submit = async (event) => {
    event.preventDefault();
    const path = draft.trim();
    if (!path) {
      return;
    }
    if (roots.includes(path)) {
      setDraft("");
      setAdding(false);
      return;
    }
    if (await access.onSave([...roots, path])) {
      setDraft("");
      setAdding(false);
    }
  };

  return h(
    SettingsPage,
    { pageKey: "access", active, title: "Access" },
    h(
      SettingsHint,
      { id: "allowed-roots-summary" },
      roots.length
        ? "Every paired device is limited to these folders. Remove them all to allow any folder."
        : "No limits: paired devices can open sessions in any folder. Add a folder to limit them."
    ),
    roots.length
      ? h(
          "ul",
          { className: "settings-list", id: "allowed-roots-list" },
          ...roots.map((root) =>
            h(
              "li",
              { key: root, className: "settings-row", "data-root": root },
              h("span", { className: "settings-row-mark", "aria-hidden": "true" }, h(FolderGlyph)),
              h(
                "span",
                { className: "settings-row-copy" },
                h("span", { className: "settings-row-title" }, workspaceName(root)),
                h("span", { className: "settings-row-sub settings-mono" }, root)
              ),
              h(
                "button",
                {
                  className: "settings-button is-quiet",
                  disabled: access.saving,
                  onClick: () => access.onSave(roots.filter((entry) => entry !== root)),
                  type: "button",
                },
                "Remove"
              )
            )
          )
        )
      : h("div", { id: "allowed-roots-list" }),
    adding
      ? h(
          "form",
          { className: "settings-inline-form settings-add-root", onSubmit: submit },
          h("input", {
            "aria-label": "Folder to allow",
            autoComplete: "off",
            autoFocus: true,
            className: "settings-input",
            disabled: access.saving,
            id: "allowed-root-input",
            list: "workspace-suggestions",
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                event.preventDefault();
                setAdding(false);
              }
            },
            placeholder: "~/projects",
            type: "text",
            value: draft,
          }),
          h(
            "button",
            {
              className: "settings-button is-primary",
              disabled: access.saving || !draft.trim(),
              id: "save-allowed-root-button",
              type: "submit",
            },
            access.saving ? "Saving…" : "Add"
          ),
          h(
            "button",
            { className: "settings-button is-quiet", onClick: () => setAdding(false), type: "button" },
            "Cancel"
          )
        )
      : h(
          "button",
          {
            className: "settings-add-button",
            disabled: access.saving,
            id: "add-allowed-root-button",
            onClick: () => setAdding(true),
            type: "button",
          },
          "+ Add folder"
        ),
    approved.length
      ? h(
          SettingsSection,
          { title: "Per device" },
          h(
            "ul",
            { className: "settings-list" },
            ...approved.map((record) =>
              h(
                "li",
                { key: record.device_id, className: "settings-row settings-row-compact" },
                h("span", { className: "settings-row-title" }, record.label || "Unnamed device"),
                h("span", { className: "settings-row-status" }, pathScopeLabel(record.path_scope))
              )
            )
          )
        )
      : null,
    h(SettingsHint, null, "Changes save immediately. A device's own limit is set when you pair it.")
  );
}

function sameScope(left, right) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function field(label, value, mono = false) {
  return h(
    "div",
    { className: "settings-field", key: label },
    h("dt", null, label),
    h("dd", mono ? { className: "settings-mono" } : null, value)
  );
}

function Chevron({ open }) {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      className: `settings-chevron${open ? " is-open" : ""}`,
      fill: "currentColor",
      height: 10,
      viewBox: "0 0 10 10",
      width: 10,
    },
    h("path", { d: "M3 1.5 7 5 3 8.5z" })
  );
}

function PhoneGlyph() {
  return h(
    "svg",
    {
      fill: "none",
      height: 16,
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeWidth: 1.6,
      viewBox: "0 0 24 24",
      width: 16,
    },
    h("rect", { height: 20, rx: 2.5, width: 12, x: 6, y: 2 }),
    h("path", { d: "M11 18h2" })
  );
}

function FolderGlyph() {
  return h(
    "svg",
    {
      fill: "none",
      height: 16,
      stroke: "currentColor",
      strokeLinejoin: "round",
      strokeWidth: 1.6,
      viewBox: "0 0 24 24",
      width: 16,
    },
    h("path", { d: "M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.5h8.8A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" })
  );
}
