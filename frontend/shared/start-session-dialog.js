import React from "react";
import { SessionSettingsFields } from "./session-settings-fields.js";

const h = React.createElement;

export function StartSessionDialog({
  id,
  cwd,
  onCwdChange,
  fields,
  onFieldChange,
  onStart,
  startPending,
  workspaceSuggestions,
  providerOptions,
  models,
  modelsStatus = "ready",
  approvalOptions,
  effortOptions,
  workspaceInputId,
  suggestionsListId,
  startButtonId,
  settingsPrefix,
  hideWorkspace,
  directoryFormId,
  loadButtonId,
  onRequestClose,
  requireInitialPrompt = true,
}) {
  const cwdId = workspaceInputId || `${id}-cwd`;
  const suggestionsId = suggestionsListId || `${id}-suggestions`;
  const btnId = startButtonId || `${id}-start`;
  const isWorkspaceControlled = Boolean(onCwdChange);
  const hasWorkspace = hideWorkspace || (isWorkspaceControlled ? Boolean(cwd?.trim()) : true);
  const isClaudeCode = fields?.provider === "claude_code";
  const requiresInitialPrompt = requireInitialPrompt && isClaudeCode;
  const hasInitialPrompt = Boolean(fields?.initialPrompt?.trim());
  const startDisabled = startPending || !hasWorkspace || (requiresInitialPrompt && !hasInitialPrompt);
  const workspaceInputProps = {
    autoComplete: "off",
    id: cwdId,
    list: suggestionsId,
    placeholder: "/path/to/project or ~/project",
    type: "text",
  };
  if (isWorkspaceControlled) {
    workspaceInputProps.onChange = (e) => onCwdChange(e.target.value);
    workspaceInputProps.value = cwd || "";
  } else {
    workspaceInputProps.defaultValue = cwd || "";
  }
  const closeDialog = () => {
    onRequestClose?.();
    document.getElementById(id)?.close();
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
      h("h2", null, "New session"),
      h("button", {
        className: "header-button close-modal-btn",
        onClick: closeDialog,
        type: "button",
      }, "×")
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      hideWorkspace ? null : h(
        directoryFormId ? "form" : "div",
        directoryFormId
          ? { className: "workspace-form", id: directoryFormId }
          : { className: "workspace-form" },
        h("label", { className: "sidebar-label", htmlFor: cwdId }, "Workspace"),
        h(
          "div",
          { className: "workspace-picker" },
          h("input", workspaceInputProps),
          h(
            "datalist",
            { id: suggestionsId },
            ...(workspaceSuggestions || []).map((s) =>
              h("option", { key: s.cwd, label: s.label, value: s.cwd })
            )
          ),
          loadButtonId ? h("button", {
            className: "load-button",
            id: loadButtonId,
            type: "submit",
          }, "Load") : null
        )
      ),
      h(SessionSettingsFields, {
        fields: fields || {},
        idPrefix: settingsPrefix ?? id,
        labels: {},
        model: {
          approvalOptions: approvalOptions || [],
          effortOptions: effortOptions || [],
          models: models || [],
          providerOptions: providerOptions || [],
        },
        onFieldChange,
      }),
      modelsStatus === "loading" || modelsStatus === "error"
        ? h(
            "p",
            {
              className: "control-hint",
              id: `${id}-models-hint`,
              "data-models-status": modelsStatus,
            },
            modelsStatus === "loading"
              ? "Loading models…"
              : "Couldn’t load the model list — switch provider or reconnect to retry."
          )
        : null,
      requiresInitialPrompt
        ? h(
            "p",
            { className: "control-hint", id: `${id}-prompt-hint` },
            "Claude Code starts when you send the first prompt."
          )
        : null
    ),
    h(
      "div",
      { className: "modal-actions" },
      h(
        "button",
        {
          className: "start-session-button",
          disabled: startDisabled,
          id: btnId,
          onClick: () => {
            // Close the modal optimistically so the user immediately sees the
            // (possibly pending) session view, then let the caller fire the
            // actual session-start side effect.
            document.getElementById(id)?.close?.();
            onStart?.();
          },
          type: "button",
        },
        startPending ? "Starting..." : "Start Session"
      )
    )
  );
}
