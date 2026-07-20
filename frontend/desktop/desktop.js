import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  applyLogEntry,
  applyStatusUpdate,
  captureFormDraft,
  openSurfaceDisabled,
  parsePort,
  restoreFormDraft,
  startDisabled,
  stopDisabled,
  LOG_VIEW_LIMIT,
} from "./ui-util.mjs";
import "./desktop.css";

const root = document.querySelector("#desktop-root");
const state = {
  status: null,
  error: "",
  saving: false,
};

window.addEventListener("DOMContentLoaded", () => {
  refreshStatus();
  listen("desktop://relay-log", (event) => onRelayLog(event?.payload));
  listen("desktop://relay-status", (event) => onRelayStatus(event?.payload));
});

// F1/F7: a streamed relay log must not rebuild the whole shell (which would wipe
// unsaved form edits and focus, and cost a full IPC round-trip per line). Append
// the delivered entry and repaint only the log panel — relay state is untouched.
function onRelayLog(entry) {
  if (!entry || !state.status) {
    refreshStatus();
    return;
  }
  state.status = applyLogEntry(state.status, entry, LOG_VIEW_LIMIT);
  updateLogPanel(state.status.logs);
}

// Backend-driven transitions (relay became ready, or exited/crashed) arrive here,
// not via a log line — so the shell must adopt the authoritative status and
// re-render (which re-derives the Open/Start/Stop buttons). Form edits + focus
// survive via captureFormDraft/restoreFormDraft in render().
function onRelayStatus(status) {
  if (!status) {
    refreshStatus();
    return;
  }
  state.status = applyStatusUpdate(state.status, status);
  state.error = "";
  render();
}

function updateLogPanel(logs) {
  const panel = root.querySelector(".log-panel");
  if (!panel) {
    render();
    return;
  }
  panel.replaceChildren(...renderLogRows(logs || []));
}

async function refreshStatus() {
  try {
    state.status = await invoke("desktop_status");
    state.error = "";
  } catch (error) {
    state.error = formatError(error);
  }
  render();
}

function render() {
  const status = state.status;
  const config = status?.config || defaultConfig();
  const relay = status?.relay || { running: false };
  const logs = status?.logs || [];

  // F1: preserve any unsaved edits + focus across the wipe-and-rebuild.
  const draft = captureFormDraft(document);
  root.innerHTML = "";
  const shell = el("div", { className: "desktop-shell" }, [
    renderHeader(relay),
    el("div", { className: "desktop-main" }, [
      renderControls(config, relay),
      renderSurfacePane(relay, logs),
    ]),
  ]);
  root.append(shell);

  bindControls(config);
  restoreFormDraft(document, draft);
}

function renderHeader(relay) {
  return el("header", { className: "desktop-header" }, [
    el("div", { className: "desktop-brand" }, [
      el("img", { className: "desktop-logo", alt: "", src: "/sealwire_logo.png" }),
      el("div", { className: "desktop-title" }, [
        el("strong", {}, ["Sealwire Desktop"]),
        el("span", {}, [relay.running ? relay.workspaceDir || "" : "Relay stopped"]),
      ]),
    ]),
    el("div", {
      className: "status-pill",
      "data-running": String(Boolean(relay.ready)),
      "data-starting": String(Boolean(relay.running && !relay.ready)),
    }, [
      el("span", { className: "status-dot" }),
      relayPillLabel(relay),
    ]),
  ]);
}

function relayPillLabel(relay) {
  if (!relay.running) {
    return "Stopped";
  }
  return relay.ready ? `Running on ${relay.port}` : `Starting on ${relay.port}`;
}

function surfaceCopy(relay) {
  if (!relay.running) {
    return "Start the relay first";
  }
  if (!relay.ready) {
    return "Waiting for the relay to come up…";
  }
  return relay.brokerLabel || "Local relay";
}

function renderControls(config, relay) {
  return el("aside", { className: "control-pane" }, [
    state.error ? el("div", { className: "error-banner" }, [state.error]) : null,
    el("section", { className: "section" }, [
      el("div", { className: "section-title" }, ["Workspace"]),
      el("div", { className: "field" }, [
        el("label", { htmlFor: "workspace-dir" }, ["Path"]),
        el("div", { className: "input-row" }, [
          el("input", {
            className: "desktop-input",
            id: "workspace-dir",
            spellcheck: "false",
            value: config.workspaceDir || "",
          }),
          el("button", {
            className: "desktop-button secondary",
            id: "browse-workspace",
            type: "button",
          }, ["Browse"]),
        ]),
      ]),
      el("div", { className: "field" }, [
        el("label", { htmlFor: "preferred-port" }, ["Preferred port"]),
        el("input", {
          className: "desktop-input",
          id: "preferred-port",
          inputmode: "numeric",
          min: "1",
          max: "65535",
          type: "number",
          value: String(config.preferredPort || 8787),
        }),
      ]),
    ]),
    el("section", { className: "section" }, [
      el("div", { className: "section-title" }, ["Broker"]),
      el("div", { className: "segmented", role: "group", "aria-label": "Broker mode" }, [
        brokerButton("localOnly", "Local", config.brokerMode),
        brokerButton("hosted", "Hosted", config.brokerMode),
        brokerButton("custom", "Custom", config.brokerMode),
      ]),
      el("div", { className: "field" }, [
        el("label", { htmlFor: "custom-broker-url" }, ["Custom broker URL"]),
        el("input", {
          className: "desktop-input",
          disabled: config.brokerMode !== "custom",
          id: "custom-broker-url",
          placeholder: "wss://broker.example.com",
          spellcheck: "false",
          value: config.customBrokerUrl || "",
        }),
      ]),
    ]),
    el("section", { className: "section" }, [
      el("div", { className: "button-row" }, [
        el("button", {
          className: "desktop-button",
          disabled: state.saving,
          id: "restart-relay",
          type: "button",
        }, [state.saving ? "Restarting" : "Save & Restart"]),
        el("button", {
          className: "desktop-button secondary",
          disabled: startDisabled(relay, state.saving),
          id: "start-relay",
          type: "button",
        }, ["Start"]),
        el("button", {
          className: "desktop-button danger",
          disabled: stopDisabled(relay, state.saving),
          id: "stop-relay",
          type: "button",
        }, ["Stop"]),
      ]),
    ]),
    renderUrls(relay),
  ].filter(Boolean));
}

function renderSurfacePane(relay, logs) {
  return el("section", { className: "surface-pane" }, [
    el("div", { className: "surface-actions" }, [
      el("div", {}, [
        el("h1", {}, ["Surfaces"]),
        el("p", { className: "surface-copy" }, [
          surfaceCopy(relay),
        ]),
      ]),
      el("div", { className: "button-row" }, [
        el("button", {
          className: "desktop-button",
          disabled: openSurfaceDisabled(relay),
          id: "open-local",
          type: "button",
        }, ["Open Local"]),
        el("button", {
          className: "desktop-button secondary",
          disabled: openSurfaceDisabled(relay),
          id: "open-remote",
          type: "button",
        }, ["Open Remote"]),
      ]),
    ]),
    renderLogs(logs),
  ]);
}

function renderUrls(relay) {
  return el("section", { className: "section" }, [
    el("div", { className: "section-title" }, ["URLs"]),
    el("div", { className: "url-list" }, [
      urlRow("Local", relay.localUrl),
      urlRow("Remote", relay.remoteUrl),
      urlRow("Broker", relay.brokerUrl || "local only"),
    ]),
  ]);
}

function renderLogs(logs) {
  return el("div", { className: "log-panel" }, renderLogRows(logs));
}

function renderLogRows(logs) {
  if (!logs.length) {
    return [el("div", { className: "log-empty" }, ["No relay logs yet."])];
  }
  return logs.slice(-160).map((line) =>
    el("div", { className: "log-line" }, [
      el("span", {}, [formatTime(line.timestampMs)]),
      el("span", { className: "stream" }, [line.stream]),
      el("span", {}, [line.message]),
    ])
  );
}

function bindControls(config) {
  document.querySelector("#browse-workspace")?.addEventListener("click", async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: document.querySelector("#workspace-dir")?.value || config.workspaceDir,
    });
    if (typeof selected === "string") {
      document.querySelector("#workspace-dir").value = selected;
    }
  });

  for (const button of document.querySelectorAll("[data-broker-mode]")) {
    button.addEventListener("click", () => {
      for (const item of document.querySelectorAll("[data-broker-mode]")) {
        item.setAttribute("aria-pressed", String(item === button));
      }
      const input = document.querySelector("#custom-broker-url");
      if (input) {
        input.disabled = button.dataset.brokerMode !== "custom";
      }
    });
  }

  document.querySelector("#restart-relay")?.addEventListener("click", () => restartRelay());
  document.querySelector("#start-relay")?.addEventListener("click", () => startRelay());
  document.querySelector("#stop-relay")?.addEventListener("click", () => stopRelay());
  document.querySelector("#open-local")?.addEventListener("click", () => openSurface("local"));
  document.querySelector("#open-remote")?.addEventListener("click", () => openSurface("remote"));
}

async function restartRelay() {
  await withSaving(async () => {
    state.status = await invoke("desktop_restart", { input: readConfigForm() });
  });
}

async function startRelay() {
  await withSaving(async () => {
    state.status = await invoke("desktop_restart", { input: readConfigForm() });
  });
}

async function stopRelay() {
  await withSaving(async () => {
    state.status = await invoke("desktop_stop_relay");
  });
}

async function openSurface(surface) {
  try {
    await invoke("desktop_open_surface", { surface });
  } catch (error) {
    state.error = formatError(error);
    render();
  }
}

async function withSaving(action) {
  state.saving = true;
  state.error = "";
  render();
  try {
    await action();
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.saving = false;
    render();
  }
}

function readConfigForm() {
  const selected = document.querySelector("[data-broker-mode][aria-pressed='true']");
  return {
    workspaceDir: document.querySelector("#workspace-dir")?.value || "",
    preferredPort: parsePort(document.querySelector("#preferred-port")?.value),
    brokerMode: selected?.dataset.brokerMode || "localOnly",
    customBrokerUrl: document.querySelector("#custom-broker-url")?.value || "",
  };
}

function brokerButton(mode, label, activeMode) {
  return el("button", {
    "aria-pressed": String(mode === activeMode),
    className: "segment-button",
    "data-broker-mode": mode,
    type: "button",
  }, [label]);
}

function urlRow(label, value) {
  return el("div", { className: "url-row" }, [
    el("span", {}, [label]),
    el("code", {}, [value || "not running"]),
  ]);
}

function defaultConfig() {
  return {
    workspaceDir: "",
    preferredPort: 8787,
    brokerMode: "localOnly",
    customBrokerUrl: "",
  };
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === "className") {
      node.className = value;
    } else if (key === "htmlFor") {
      node.htmlFor = value;
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) {
      continue;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function formatError(error) {
  if (typeof error === "string") {
    return error;
  }
  if (error?.message) {
    return error.message;
  }
  return String(error);
}

function formatTime(timestampMs) {
  const date = new Date(timestampMs);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
