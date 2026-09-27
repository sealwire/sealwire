// The local Settings window. app.js owns the data and re-renders this on every snapshot.

import React from "react";
import { SettingsFooter, SettingsFrame } from "../shared/settings-frame.js";
import { LogPage } from "../shared/settings-log.js";
import { ProvidersPage } from "../shared/settings-providers.js";
import { splitDeviceRecords } from "../shared/settings-model.js";
import { AccessPage, DevicesPage } from "./settings-devices.js";

const h = React.createElement;

export const LOCAL_SETTINGS_TABS = ["providers", "devices", "access", "log"];

export function LocalSettings(props) {
  const { tab, onSelectTab, onClose, providers, devices, pairing, access, log, now } = props;
  const connected = providers.filter((row) => row.connected && row.signedIn !== false).length;
  const paired = splitDeviceRecords(devices.records).current.length;
  const nav = [
    {
      key: "providers",
      label: "Providers",
      meta: providers.length ? `${connected}/${providers.length}` : "",
      metaTone: connected < providers.length ? "alert" : "",
    },
    devices.pending.length
      ? { key: "devices", label: "Devices", meta: `${devices.pending.length} waiting`, metaTone: "alert" }
      : { key: "devices", label: "Devices", meta: paired ? String(paired) : "" },
    {
      key: "access",
      label: "Access",
      meta: access.roots.length
        ? `${access.roots.length} root${access.roots.length === 1 ? "" : "s"}`
        : "Any folder",
    },
  ];
  return h(
    SettingsFrame,
    {
      active: tab,
      closeId: "close-settings-modal",
      footer: h(SettingsFooter, {
        loadBuildInfo: props.loadBuildInfo,
        logActive: tab === "log",
        logButtonId: "settings-tab-log",
        onOpenLog: () => onSelectTab("log"),
      }),
      nav,
      onClose,
      onSelect: onSelectTab,
    },
    h(ProvidersPage, {
      active: tab === "providers",
      footnote: "Sealwire uses each CLI's own sign-in. Sign in or out from the CLI itself.",
      listId: "provider-status-list",
      model: providers,
    }),
    h(DevicesPage, {
      active: tab === "devices",
      devices,
      formatTimestamp: props.formatTimestamp,
      now,
      pairing,
      roots: access.roots,
      shortId: props.shortId,
    }),
    h(AccessPage, { active: tab === "access", access, records: devices.records }),
    h(LogPage, {
      active: tab === "log",
      entries: log.entries,
      footnote: "Newest first · the last 400 lines from this browser and the relay.",
      listId: "client-log",
      rootId: "client-log-root",
    })
  );
}
