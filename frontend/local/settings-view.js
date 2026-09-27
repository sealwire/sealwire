// The local Settings window. app.js owns the data and re-renders this on every snapshot.

import React from "react";
import { SettingsFooter, SettingsFrame, SettingsPage } from "../shared/settings-frame.js";
import { ProvidersPage } from "../shared/settings-providers.js";
import {
  LOG_FILTERS,
  collapseLogRepeats,
  filterLogRows,
  logRepeatLabel,
  splitDeviceRecords,
} from "../shared/settings-model.js";
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
    h(LogPage, { active: tab === "log", log })
  );
}

// Not in the nav: the log is for bug reports, so it hangs off the footer link.
// Always mounted because e2e scripts read #client-log text while Settings is closed.
function LogPage({ active, log }) {
  const [filter, setFilter] = React.useState("all");
  const [copied, setCopied] = React.useState(false);
  const rows = filterLogRows(collapseLogRepeats(log.entries), filter);
  const copy = async () => {
    if (await log.onCopy()) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return h(
    SettingsPage,
    {
      pageKey: "log",
      active,
      title: "Log",
      actions: h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "theme-picker settings-filter", role: "radiogroup", "aria-label": "Show" },
          ...LOG_FILTERS.map((entry) =>
            h(
              "button",
              {
                key: entry.key,
                "aria-checked": filter === entry.key ? "true" : "false",
                className: `theme-picker-segment${filter === entry.key ? " is-active" : ""}`,
                "data-log-filter": entry.key,
                onClick: () => setFilter(entry.key),
                role: "radio",
                type: "button",
              },
              entry.label
            )
          )
        ),
        h("button", { className: "settings-button", onClick: copy, type: "button" }, copied ? "Copied" : "Copy")
      ),
    },
    h(
      "div",
      { id: "client-log-root" },
      rows.length
        ? h(
            "ol",
            { className: "settings-log", id: "client-log" },
            ...rows.map((row, index) =>
              h(
                "li",
                { key: `${row.at}:${index}`, className: `settings-log-row is-${row.level}` },
                h("span", { className: "settings-log-time settings-mono" }, formatClock(row.at)),
                h("span", { className: "settings-log-dot", "aria-hidden": "true" }),
                h("span", { className: "settings-log-text" }, row.text),
                row.count > 1 ? h("span", { className: "settings-log-repeat" }, logRepeatLabel(row)) : null
              )
            )
          )
        : h(
            "p",
            { className: "settings-empty", id: "client-log" },
            filter === "all" ? "Nothing logged yet." : "Nothing matches this filter."
          )
    ),
    h("p", { className: "settings-hint" }, "Newest first · the last 400 lines from this browser and the relay.")
  );
}

function formatClock(ms) {
  return ms ? new Date(ms).toLocaleTimeString() : "";
}

export function logEntriesAsText(entries) {
  return (entries || []).map((entry) => `${formatClock(entry.at)}  ${entry.text}`).join("\n");
}
