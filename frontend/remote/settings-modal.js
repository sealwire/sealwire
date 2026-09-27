// Remote's Settings window: same frame as local, but this browser only sees its own pairing.
// Devices and Access are relay-side controls, so they stay on the local surface.

import React from "react";
import { ManagedDialog } from "../shared/managed-dialog.js";
import { SettingsFooter, SettingsFrame, SettingsPage, SettingsSection } from "../shared/settings-frame.js";
import { LogPage } from "../shared/settings-log.js";
import { ProvidersPage } from "../shared/settings-providers.js";
import { DeviceMetaPanel } from "./react-renderer.js";

const h = React.createElement;

export function RemoteSettingsModal({
  open,
  tab,
  onSelectTab,
  onClose,
  providerModel,
  device,
  loadBuildInfo,
  onRecheckSignedOut,
  logEntries,
}) {
  const providers = providerModel || [];
  // Read at the moment Settings opens, so re-renders while open never re-ask.
  const latest = React.useRef(null);
  latest.current = { signedOut: providers.some((row) => row.signedIn === false), onRecheckSignedOut };
  React.useEffect(() => {
    if (open && latest.current.signedOut) {
      latest.current.onRecheckSignedOut?.();
    }
  }, [open]);
  const connected = providers.filter((row) => row.connected && row.signedIn !== false).length;
  const nav = [
    {
      key: "providers",
      label: "Providers",
      meta: providers.length ? `${connected}/${providers.length}` : "",
      metaTone: connected < providers.length ? "alert" : "",
    },
    { key: "device", label: "This device", meta: device.statusLabel, metaTone: device.statusTone },
  ];
  const active = tab === "log" || nav.some((item) => item.key === tab) ? tab : "providers";
  return h(
    ManagedDialog,
    {
      className: "settings-modal panel-modal",
      id: "remote-settings-modal",
      open,
      onRequestClose: onClose,
    },
    h(
      SettingsFrame,
      {
        active,
        closeId: "close-remote-settings-modal",
        footer: h(SettingsFooter, {
          loadBuildInfo,
          logActive: active === "log",
          logButtonId: "remote-settings-tab-log",
          onOpenLog: () => onSelectTab("log"),
        }),
        nav,
        onClose,
        onSelect: onSelectTab,
        tabIdPrefix: "remote-",
      },
      h(ProvidersPage, {
        active: active === "providers",
        footnote:
          "A session's agent is chosen when you start it and cannot change afterwards — fork the session to hand it to another agent.",
        listId: "remote-provider-status-list",
        model: providers,
      }),
      h(DevicePage, { active: active === "device", device }),
      h(LogPage, {
        active: active === "log",
        entries: logEntries || [],
        footnote: "Newest first · the last 400 lines from this device and the relay.",
        listId: "remote-client-log",
      })
    )
  );
}

function DevicePage({ active, device }) {
  const controls = device.chromeModel.pairingControls;
  return h(
    SettingsPage,
    { pageKey: "device", active, title: "This device" },
    h(
      SettingsSection,
      null,
      h("div", { className: "paired-devices-list", id: "device-meta" }, h(DeviceMetaPanel, { model: device.chromeModel.deviceMeta })),
      device.paired
        ? h(
            "div",
            { className: "settings-row-actions" },
            h(
              "button",
              {
                className: "settings-button is-danger",
                id: "forget-device-button",
                onClick: device.onForget,
                type: "button",
              },
              "Forget this device"
            )
          )
        : null
    ),
    h(
      SettingsSection,
      { title: "Pair with a relay" },
      h(
        "form",
        {
          className: "settings-form",
          id: "pairing-form",
          onSubmit: (event) => {
            event.preventDefault();
            device.onBeginPairing(device.pairingInputValue);
          },
        },
        h("label", { className: "settings-label", htmlFor: "pairing-input" }, "Pairing link or code"),
        h("textarea", {
          className: "settings-input",
          id: "pairing-input",
          onChange: (event) => device.onPairingInputChange(event.target.value),
          placeholder: "Paste the pairing link from the relay's Settings › Devices.",
          readOnly: controls.pairingInputReadOnly,
          rows: 3,
          value: device.pairingInputValue,
        }),
        h("label", { className: "settings-label", htmlFor: "device-label-input" }, "Name this device"),
        h(
          "div",
          { className: "settings-inline-form" },
          h("input", {
            className: "settings-input",
            id: "device-label-input",
            onChange: (event) => device.onDeviceLabelChange(event.target.value),
            placeholder: "iPhone, Pixel, Safari on iPad",
            type: "text",
            value: device.deviceLabel,
          }),
          h(
            "button",
            {
              className: "settings-button is-primary",
              disabled: controls.connectDisabled,
              id: "connect-button",
              type: "submit",
            },
            controls.connectLabel
          )
        )
      )
    )
  );
}
