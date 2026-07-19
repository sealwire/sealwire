import React from "react";
import { SessionSettingsFields } from "./session-settings-fields.js";
import { INHERIT, forkIsLossy } from "./fork-fields.js";
import { providerLabel } from "./provider-labels.js";

const h = React.createElement;

const INHERIT_LABEL = "Inherit from source session";

// Untouched settings must reach the relay as null so it can resolve them from
// the SOURCE thread. Showing a concrete value here would be a lie — the relay
// would not use it — and sending one silently re-permissions the fork.
function withInheritOption(options) {
  return [{ value: INHERIT, label: INHERIT_LABEL }, ...(options || [])];
}

export function ForkSessionDialog({
  id = "fork-session-dialog",
  sourceThread = null,
  fields = {},
  onFieldChange = null,
  onFork = null,
  pending = false,
  error = "",
  forkCapabilities = [],
  providerOptions = [],
  models = [],
  modelsStatus = "ready",
  approvalOptions = [],
  effortOptions = [],
  onRequestClose = null,
}) {
  const sourceTitle = sourceThread?.name || sourceThread?.preview || sourceThread?.id || "thread";
  const cwdId = `${id}-cwd`;
  const sourceProvider = sourceThread?.provider || "";
  const targetProvider = fields.provider || sourceProvider;
  const lossy = forkIsLossy({
    sourceProvider,
    targetProvider,
    upToItemId: fields.upToItemId || "",
    forkPointIsTip: Boolean(fields.forkPointIsTip),
    capabilities: forkCapabilities,
  });
  const closeDialog = () => {
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  return h(
    "dialog",
    {
      className: "panel-modal panel-modal-wide",
      id,
      onClose: () => onRequestClose?.(),
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      },
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Fork session"),
      h("button", {
        className: "header-button close-modal-btn",
        onClick: closeDialog,
        type: "button",
      }, "x")
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h(
        "p",
        { className: "control-hint" },
        fields.upToItemId
          ? `Branching from a message in: ${sourceTitle}`
          : `Source: ${sourceTitle}`
      ),
      lossy
        ? h(
            "p",
            { className: "control-hint", "data-fork-mode": "replay" },
            sourceProvider && targetProvider && sourceProvider !== targetProvider
              ? `Handing off ${providerLabel(sourceProvider)} → ${providerLabel(targetProvider)} via transcript replay — provider-native state (tool results, cached context) will not carry over.`
              : "Branching mid-thread uses transcript replay — provider-native state will not carry over."
          )
        : h(
            "p",
            { className: "control-hint", "data-fork-mode": "native" },
            `Native ${providerLabel(targetProvider)} fork — full context is preserved.`
          ),
      h(
        "label",
        { className: "field field-full" },
        h("span", null, "Workspace"),
        h("input", {
          autoComplete: "off",
          id: cwdId,
          onChange: (event) => onFieldChange?.("cwd", event.target.value),
          placeholder: "/path/to/project or ~/project",
          type: "text",
          value: fields.cwd || "",
        })
      ),
      h(SessionSettingsFields, {
        fields,
        idPrefix: id,
        labels: {
          initialPrompt: "Fork Prompt",
          initialPromptPlaceholder: "Optional task for the forked agent.",
        },
        model: {
          approvalOptions: withInheritOption(approvalOptions),
          effortOptions: withInheritOption(effortOptions),
          models: [{ model: INHERIT, display_name: INHERIT_LABEL }, ...(models || [])],
          providerOptions,
        },
        onFieldChange,
      }),
      error
        ? h(
            "p",
            { className: "control-hint", "data-fork-error": "true", role: "alert" },
            error
          )
        : null,
      modelsStatus === "loading" || modelsStatus === "error"
        ? h(
            "p",
            {
              className: "control-hint",
              id: `${id}-models-hint`,
              "data-models-status": modelsStatus,
            },
            modelsStatus === "loading"
              ? "Loading models..."
              : "Could not load the model list."
          )
        : null
    ),
    h(
      "div",
      { className: "modal-actions" },
      h(
        "button",
        {
          className: "secondary-button",
          onClick: closeDialog,
          type: "button",
        },
        "Cancel"
      ),
      h(
        "button",
        {
          className: "start-session-button",
          disabled: pending || !sourceThread?.id || !fields.cwd?.trim(),
          onClick: () => onFork?.(),
          type: "button",
        },
        pending ? "Forking..." : "Fork Session"
      )
    )
  );
}
