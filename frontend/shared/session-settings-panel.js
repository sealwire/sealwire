import React from "react";
import { providerSettings, sandboxOptions } from "./provider-settings.js";

const h = React.createElement;

export function isSessionIdle(session) {
  if (!session) return false;
  if (session.active_turn_id) return false;
  if (
    Array.isArray(session.pending_approvals)
    && session.pending_approvals.length > 0
  ) {
    return false;
  }
  const status = String(session.current_status || "").toLowerCase();
  return !status || status === "idle";
}

export function sessionBusyReason(session) {
  if (!session) return null;
  if (session.active_turn_id) {
    return "Settings unlock when the agent is idle.";
  }
  if (
    Array.isArray(session.pending_approvals)
    && session.pending_approvals.length > 0
  ) {
    return "Settings locked while an approval is pending.";
  }
  const status = String(session.current_status || "").toLowerCase();
  if (status && status !== "idle") {
    return `Settings locked while status is ${status}.`;
  }
  return null;
}

export function SessionSettingsPanel({
  session,
  busy = false,
  onUpdate = null,
}) {
  if (!session?.active_thread_id) {
    return null;
  }

  const provider = session.provider || "codex";
  const settings = providerSettings(provider);
  const idle = isSessionIdle(session);
  const disabled = !idle || busy;
  const hint = busy ? "Applying…" : sessionBusyReason(session);
  const showSandbox = provider !== "claude_code";

  function emit(next) {
    if (disabled || !onUpdate) return;
    onUpdate(next);
  }

  return h(
    "section",
    {
      "aria-label": "Session settings",
      className: "session-settings-panel" + (disabled ? " is-disabled" : ""),
    },
    h(
      "div",
      { className: "session-settings-fields" },
      h(InlineSelect, {
        id: "session-settings-approval",
        label: settings.approvalLabel || "Permission mode",
        options: settings.approvalOptions || [],
        value: session.approval_policy || "",
        disabled,
        onChange: (value) => emit({ approval_policy: value }),
      }),
      showSandbox
        ? h(InlineSelect, {
            id: "session-settings-sandbox",
            label: settings.sandboxLabel || "File access",
            options: sandboxOptions(),
            value: session.sandbox || "",
            disabled,
            onChange: (value) => emit({ sandbox: value }),
          })
        : null
    ),
    hint ? h("p", { className: "session-settings-hint" }, hint) : null
  );
}

function InlineSelect({ id, label, options = [], value, disabled, onChange }) {
  return h(
    "label",
    { className: "session-settings-field", htmlFor: id },
    h("span", { className: "session-settings-label" }, label),
    h(
      "select",
      {
        id,
        className: "session-settings-select",
        disabled,
        onChange: (event) => onChange?.(event.target.value),
        value,
      },
      ...(options.length
        ? options.map((option) =>
            h(
              "option",
              { key: option.value, value: option.value },
              option.label
            )
          )
        : [h("option", { key: "_blank", value: "" }, value || "—")])
    )
  );
}
