import React from "react";
import { providerSettings } from "./provider-settings.js";

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

function lookupOptionLabel(options, value) {
  if (!Array.isArray(options)) return value || "";
  const hit = options.find((option) => option.value === value);
  return hit?.label || value || "";
}

export function SessionSettingsButton({
  session,
  busy = false,
  onUpdate = null,
  buttonId = "session-settings-button",
}) {
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    function onDocPointer(event) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("touchstart", onDocPointer, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("touchstart", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!session?.active_thread_id) {
    return null;
  }

  const provider = session.provider || "codex";
  const settings = providerSettings(provider);
  const idle = isSessionIdle(session);
  const disabled = !idle || busy;
  const hint = busy ? "Applying…" : sessionBusyReason(session);
  const approvalShort = lookupOptionLabel(
    settings.approvalOptions,
    session.approval_policy
  );

  function emit(next) {
    if (disabled || !onUpdate) return;
    onUpdate(next);
  }

  return h(
    "div",
    {
      ref: wrapperRef,
      className: "session-settings-control" + (open ? " is-open" : ""),
    },
    h(
      "button",
      {
        id: buttonId,
        type: "button",
        className: "session-settings-toggle",
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "dialog",
        "aria-label": "Session permissions",
        title: hint || "Adjust session permissions",
        onClick: () => setOpen((prev) => !prev),
      },
      h(
        "span",
        { className: "session-settings-toggle-icon", "aria-hidden": "true" },
        disabled ? "🔒" : "🔓"
      ),
      h(
        "span",
        { className: "session-settings-toggle-label" },
        approvalShort || "Permissions"
      )
    ),
    open
      ? h(
          "div",
          {
            className: "session-settings-popover",
            role: "dialog",
            "aria-label": "Session permissions",
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
            })
          ),
          hint ? h("p", { className: "session-settings-hint" }, hint) : null
        )
      : null
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
