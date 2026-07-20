import React from "react";
import { SessionSettingsFields } from "./session-settings-fields.js";
import {
  INHERIT,
  forkFieldsAreSubmittable,
  forkInheritableFields,
  forkIsLossy,
  normalizeForkFields,
} from "./fork-fields.js";
import { providerLabel } from "./provider-labels.js";

const h = React.createElement;

const INHERIT_LABEL = "Inherit from source session";

// A thread's preview can be its entire first message — a replay-fork handoff
// blob or a reviewer prompt runs to tens of thousands of characters. Rendering
// that whole string in the "Source:" line overflowed the dialog before the
// fork was even created. Collapse to the first line and cap the length.
const MAX_SOURCE_LABEL_CHARS = 80;
function forkSourceLabel(sourceThread) {
  const raw = sourceThread?.name || sourceThread?.preview || sourceThread?.id || "thread";
  const firstLine = String(raw).split("\n", 1)[0].trim() || "thread";
  return firstLine.length > MAX_SOURCE_LABEL_CHARS
    ? `${firstLine.slice(0, MAX_SOURCE_LABEL_CHARS - 1)}…`
    : firstLine;
}

// Untouched settings must reach the relay as null so it can resolve them from
// the SOURCE thread. Showing a concrete value here would be a lie — the relay
// would not use it — and sending one silently re-permissions the fork.
//
// But the option is only offered for fields the relay actually inherits: after
// a provider change it ignores the source model and effort (see
// forkInheritableFields), so offering "inherit" there would promise something
// that never happens.
function withInheritOption(options, inheritable) {
  const rest = options || [];
  return inheritable ? [{ value: INHERIT, label: INHERIT_LABEL }, ...rest] : rest;
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
  const sourceTitle = forkSourceLabel(sourceThread);
  const cwdId = `${id}-cwd`;
  const sourceProvider = sourceThread?.provider || "";
  const targetProvider = fields.provider || sourceProvider;
  const inheritable = forkInheritableFields({ sourceProvider, targetProvider });
  // Normalize at render time so a catalog that arrives asynchronously seeds the
  // field too — a provider switch made before the models load would otherwise
  // leave the select holding a value it never offers.
  const shownFields = normalizeForkFields(fields, { sourceProvider, models });
  const submittable = forkFieldsAreSubmittable(shownFields, { sourceProvider });
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
        fields: shownFields,
        idPrefix: id,
        labels: {
          initialPrompt: "Fork Prompt",
          initialPromptPlaceholder: "Optional task for the forked agent.",
        },
        model: {
          approvalOptions: withInheritOption(approvalOptions, inheritable.has("approvalPolicy")),
          effortOptions: withInheritOption(effortOptions, inheritable.has("effort")),
          models: inheritable.has("model")
            ? [{ model: INHERIT, display_name: INHERIT_LABEL }, ...(models || [])]
            : models || [],
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
          disabled:
            pending || !sourceThread?.id || !shownFields.cwd?.trim() || !submittable,
          onClick: () => onFork?.(shownFields),
          type: "button",
        },
        pending ? "Forking..." : "Fork Session"
      )
    )
  );
}
