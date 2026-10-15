// Remote's Settings window: same frame as local, but this browser only sees its own pairing.
// Devices and Access are relay-side controls, so they stay on the local surface.

import React from "react";
import { ManagedDialog } from "../shared/managed-dialog.js";
import { t } from "../shared/i18n.js";
import { BuildLabel, SettingsFrame, SettingsPage, SettingsSection } from "../shared/settings-frame.js";
import { LogPage } from "../shared/settings-log.js";
import { PersonalizePage } from "../shared/settings-personalize.js";
import { ProvidersPage } from "../shared/settings-providers.js";
import { DeviceMetaPanel } from "./react-renderer.js";
import { ScanPairingButton } from "./scan-pairing-button.js";

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
      label: t("Providers"),
      meta: providers.length ? `${connected}/${providers.length}` : "",
      metaTone: connected < providers.length ? "alert" : "",
    },
    { key: "device", label: t("This device"), meta: device.statusLabel, metaTone: device.statusTone },
    { key: "personalize", label: t("Personalization") },
  ];
  const active = nav.some((item) => item.key === tab) ? tab : "providers";
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
        nav,
        onClose,
        onSelect: onSelectTab,
        tabIdPrefix: "remote-",
      },
      h(ProvidersPage, {
        active: active === "providers",
        footnote: t(
          "A session's agent is chosen when you start it and cannot change afterwards — fork the session to hand it to another agent."
        ),
        listId: "remote-provider-status-list",
        model: providers,
      }),
      h(DevicePage, { active: active === "device", device, loadBuildInfo }),
      h(PersonalizePage, { active: active === "personalize" }),
      // Never shown: e2e scripts read #remote-client-log when a run fails.
      h(LogPage, {
        active: false,
        entries: logEntries || [],
        footnote: "Newest first · the last 400 lines from this device and the relay.",
        listId: "remote-client-log",
      })
    )
  );
}

function DevicePage({ active, device, loadBuildInfo }) {
  const controls = device.chromeModel.pairingControls;
  return h(
    SettingsPage,
    { pageKey: "device", active, title: t("This device") },
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
              t("Forget this device")
            )
          )
        : null
    ),
    h(
      SettingsSection,
      { title: t("Pair with a relay") },
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
        h("label", { className: "settings-label", htmlFor: "pairing-input" }, t("Pairing link or code")),
        h("textarea", {
          className: "settings-input",
          id: "pairing-input",
          onChange: (event) => device.onPairingInputChange(event.target.value),
          placeholder: t("Paste the pairing link from the relay's Settings › Devices."),
          readOnly: controls.pairingInputReadOnly,
          rows: 3,
          value: device.pairingInputValue,
        }),
        h(ScanPairingButton, { onScanned: device.onBeginPairing }),
        h("label", { className: "settings-label", htmlFor: "device-label-input" }, t("Name this device")),
        h(
          "div",
          { className: "settings-inline-form" },
          h("input", {
            className: "settings-input",
            id: "device-label-input",
            onChange: (event) => device.onDeviceLabelChange(event.target.value),
            placeholder: t("iPhone, Pixel, Safari on iPad"),
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
    ),
    h(SettingsSection, { title: t("Version") }, h(BuildLabel, { loadBuildInfo }))
  );
}
