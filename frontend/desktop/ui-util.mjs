// Pure helpers for the desktop shell UI. Kept free of Tauri/CSS imports so they
// can be unit-tested under `node --test` with a lightweight document stub.

import { providerStatusMeta } from "../shared/provider-status.js";

export const DEFAULT_PORT = 8787;
export const LOG_VIEW_LIMIT = 400;

// F10: never let a bad form value become NaN (which serializes to JSON `null`
// and fails the Rust-side `u16` deserialization).
export function parsePort(value, fallback = DEFAULT_PORT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const port = Math.trunc(numeric);
  if (port < 1 || port > 65535) {
    return fallback;
  }
  return port;
}

// F7: append a single streamed log entry, dropping the oldest beyond `limit`,
// without mutating the caller's array.
export function pushLogEntry(logs, entry, limit = LOG_VIEW_LIMIT) {
  const next = Array.isArray(logs) ? logs.slice() : [];
  next.push(entry);
  if (next.length > limit) {
    next.splice(0, next.length - limit);
  }
  return next;
}

// Backend ready/exit transitions are delivered via a dedicated `relay-status`
// event; only that authoritative payload may move `relay` state. A streamed log
// line appends to the log list and leaves `relay` (and its buttons) untouched.
export function applyLogEntry(status, entry, limit = LOG_VIEW_LIMIT) {
  if (!status) {
    return status;
  }
  return { ...status, logs: pushLogEntry(status.logs, entry, limit) };
}

export function applyStatusUpdate(prevStatus, payload) {
  return payload || prevStatus;
}

export function openSurfaceDisabled(relay) {
  return !relay?.ready;
}

export function startDisabled(relay, saving) {
  return Boolean(saving) || Boolean(relay?.running);
}

export function stopDisabled(relay, saving) {
  return Boolean(saving) || !relay?.running;
}

// Maps one relay provider_status row to the shared status meta (label/dot),
// reusing the exact vocabulary the local/remote sidebars use so the launcher's
// Providers panel can never drift from them.
export function providerRowView(row) {
  const meta = providerStatusMeta(row?.status);
  return {
    provider: row?.provider || "",
    name: row?.displayName || row?.provider || "",
    status: row?.status || "starting",
    label: meta.label,
    dotClass: meta.dotClass,
    reason: row?.reason || "",
  };
}

const DRAFT_FIELD_IDS = ["workspace-dir", "preferred-port", "custom-broker-url"];

// F1: capture the user's in-progress (unsaved) form edits + focus so a re-render
// triggered by an async event (e.g. a streamed relay log) does not wipe them.
export function captureFormDraft(doc) {
  if (!doc) {
    return null;
  }
  const values = {};
  for (const id of DRAFT_FIELD_IDS) {
    const node = doc.querySelector(`#${id}`);
    if (node && typeof node.value === "string") {
      values[id] = node.value;
    }
  }

  const pressed = doc.querySelector("[data-broker-mode][aria-pressed='true']");
  const brokerMode = pressed?.dataset?.brokerMode || null;

  const brokerToggle = doc.querySelector("#broker-enabled");
  const brokerEnabled =
    brokerToggle && typeof brokerToggle.checked === "boolean"
      ? brokerToggle.checked
      : undefined;

  const active = doc.activeElement;
  const focusId = active && active.id ? active.id : null;
  const draft = { values, brokerMode, brokerEnabled, focusId };
  if (active && typeof active.selectionStart === "number") {
    draft.selectionStart = active.selectionStart;
    draft.selectionEnd = active.selectionEnd;
  }
  return draft;
}

export function restoreFormDraft(doc, draft) {
  if (!doc || !draft) {
    return;
  }

  for (const [id, value] of Object.entries(draft.values || {})) {
    const node = doc.querySelector(`#${id}`);
    if (node && typeof node.value === "string") {
      node.value = value;
    }
  }

  if (typeof draft.brokerEnabled === "boolean") {
    const toggle = doc.querySelector("#broker-enabled");
    if (toggle && "checked" in toggle) {
      toggle.checked = draft.brokerEnabled;
    }
  }

  if (draft.brokerMode) {
    for (const button of doc.querySelectorAll("[data-broker-mode]")) {
      const selected = button.dataset?.brokerMode === draft.brokerMode;
      button.setAttribute?.("aria-pressed", String(selected));
    }
    const customInput = doc.querySelector("#custom-broker-url");
    if (customInput) {
      customInput.disabled = draft.brokerMode !== "custom";
    }
  }

  if (draft.focusId) {
    const node = doc.querySelector(`#${draft.focusId}`);
    if (node && typeof node.focus === "function") {
      node.focus();
      if (
        typeof draft.selectionStart === "number" &&
        typeof node.setSelectionRange === "function"
      ) {
        try {
          node.setSelectionRange(draft.selectionStart, draft.selectionEnd);
        } catch {
          // Non-text inputs (e.g. number) can reject setSelectionRange; ignore.
        }
      }
    }
  }
}

// Broker status meta: "disabled" | "connecting" | "connected" | "offline".
// Follows the same tone/dotClass/label pattern as providers for visual consistency.
// Unknown or null status defaults to "disabled" (inactive), not "connecting" (active).
export function brokerStatusMeta(status) {
  const meta = {
    disabled: {
      label: "Not configured",
      tone: "offline",
      dotClass: "broker-dot-disabled",
    },
    connecting: {
      label: "Connecting…",
      tone: "active",
      dotClass: "broker-dot-connecting",
    },
    connected: {
      label: "Connected",
      tone: "ready",
      dotClass: "broker-dot-connected",
    },
    offline: {
      label: "Offline",
      tone: "alert",
      dotClass: "broker-dot-offline",
    },
  };
  return meta[status] || meta.disabled; // Default to inactive "disabled", not "connecting"
}
