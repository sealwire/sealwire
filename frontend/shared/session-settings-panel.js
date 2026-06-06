import React from "react";
import { providerSettings, sandboxOptions } from "./provider-settings.js";
import { buildReasoningEffortOptionsWithSelection } from "./reasoning-efforts.js";

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

function approvalTone(approvalOptions, value) {
  if (!Array.isArray(approvalOptions)) return "neutral";
  const hit = approvalOptions.find((option) => option.value === value);
  return hit?.tone || "neutral";
}

export function SessionSettingsButton({
  session,
  busy = false,
  onUpdate = null,
  onChangeEffort = null,
  composerEffort = "",
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
  const showSandbox = provider !== "claude_code";
  const currentApproval = session.approval_policy || "";
  const tone = approvalTone(settings.approvalOptions, currentApproval);
  const currentEffort = composerEffort || session.reasoning_effort || "";
  // Use the selection-preserving builder so the active effort never vanishes
  // from the control when the catalog is empty/stale (see the helper for why).
  const effortOptions = buildReasoningEffortOptionsWithSelection(
    session.available_models || [],
    session.model || "",
    provider,
    currentEffort
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
      "data-approval-tone": tone,
    },
    h(
      "button",
      {
        id: buttonId,
        type: "button",
        className: "session-settings-toggle",
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "dialog",
        "aria-label": "Session settings",
        title: hint || `Session settings — ${currentApproval || "permissions"}`,
        onClick: () => setOpen((prev) => !prev),
      },
      h(
        "span",
        { className: "session-settings-toggle-icon", "aria-hidden": "true" },
        disabled ? "🔒" : "⚙"
      )
    ),
    open
      ? h(
          "div",
          {
            className: "session-settings-popover",
            role: "dialog",
            "aria-label": "Session settings",
          },
          h(
            "div",
            { className: "session-settings-section" },
            h("h3", { className: "session-settings-section-title" },
              settings.approvalLabel || "Permission mode"),
            h(ApprovalCards, {
              options: settings.approvalOptions || [],
              value: currentApproval,
              disabled,
              onChange: (value) => emit({ approval_policy: value }),
            })
          ),
          effortOptions.length
            ? h(
                "div",
                { className: "session-settings-section" },
                h("h3", { className: "session-settings-section-title" },
                  settings.effortLabel || "Effort"),
                h(SegmentedControl, {
                  id: "session-settings-effort",
                  options: effortOptions,
                  value: currentEffort,
                  disabled,
                  onChange: (value) => onChangeEffort?.(value),
                })
              )
            : null,
          showSandbox
            ? h(
                "div",
                { className: "session-settings-section" },
                h("h3", { className: "session-settings-section-title" },
                  settings.sandboxLabel || "File access"),
                h(SegmentedControl, {
                  id: "session-settings-sandbox",
                  options: sandboxOptions(),
                  value: session.sandbox || "",
                  disabled,
                  onChange: (value) => emit({ sandbox: value }),
                })
              )
            : null,
          hint ? h("p", { className: "session-settings-hint" }, hint) : null
        )
      : null
  );
}

function ApprovalCards({ options = [], value, disabled, onChange }) {
  return h(
    "div",
    { className: "approval-cards", role: "radiogroup", "aria-label": "Permission mode" },
    ...options.map((option) => {
      const selected = option.value === value;
      return h(
        "button",
        {
          key: option.value,
          type: "button",
          role: "radio",
          "aria-checked": selected ? "true" : "false",
          className: "approval-card"
            + (selected ? " is-selected" : "")
            + (disabled ? " is-disabled" : ""),
          "data-tone": option.tone || "neutral",
          disabled,
          onClick: () => {
            if (disabled || selected) return;
            onChange?.(option.value);
          },
        },
        h("span", { className: "approval-card-label" }, option.label),
        option.description
          ? h("span", { className: "approval-card-description" }, option.description)
          : null
      );
    })
  );
}

export function SegmentedControl({ id, options = [], value, disabled, onChange }) {
  return h(
    "div",
    { id, className: "settings-segmented" + (disabled ? " is-disabled" : ""), role: "radiogroup" },
    ...options.map((option) => {
      const selected = option.value === value;
      return h(
        "button",
        {
          key: option.value,
          type: "button",
          role: "radio",
          "aria-checked": selected ? "true" : "false",
          className: "settings-segmented-option" + (selected ? " is-selected" : ""),
          disabled,
          onClick: () => {
            if (disabled || selected) return;
            onChange?.(option.value);
          },
        },
        option.label
      );
    })
  );
}
