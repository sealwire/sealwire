import React from "react";

import { SEND_SVG } from "../svg.js";

const h = React.createElement;

// Build the model picker's option list, guaranteeing the current model stays
// visible even when it isn't in the catalog — an empty/stale catalog, or an id
// the catalog only exposes via an alias (e.g. the "default" entry while the
// session reports the concrete "claude-opus-4-8"). The backend is responsible
// for keeping session.model matchable; this is the UI-side safety net so the
// selection is never unrepresented.
// Build the model-picker option list. Hidden models (Codex marks internal /
// deprecated entries hidden) are always dropped, but the current selection is
// kept representable: with `allowForeign` (the composer) the real current entry
// is re-surfaced even if it's hidden/stale; without it (the launch dialog) a
// value that isn't in THIS provider's catalog is snapped to the provider default
// instead of leaking a foreign id (e.g. gpt-5.5 under Claude). Returns the
// filtered `options` plus the possibly-snapped `value`.
export function buildModelSelectOptions(
  models = [],
  currentModelValue = "",
  { allowForeign = true } = {}
) {
  const options = (models || []).filter((model) => !model.hidden);
  let value = currentModelValue;
  if (value && !options.some((model) => model.model === value)) {
    if (allowForeign || options.length === 0) {
      const current = (models || []).find((model) => model.model === value);
      options.unshift(current || { display_name: value, model: value });
    } else {
      value = options.find((model) => model.is_default)?.model || options[0]?.model || value;
    }
  }
  return { options, value };
}

export function buildModelOptions(models = [], currentModelValue = "") {
  return buildModelSelectOptions(models, currentModelValue, { allowForeign: true }).options;
}

export function ConversationComposer({
  actionsBeforeSend = null,
  composerDisabled = false,
  currentDraft,
  currentModelValue,
  messageId = "remote-message-input",
  messagePlaceholder = "",
  modelId = "remote-message-model",
  models = [],
  onDraftChange = null,
  onModelChange = null,
  onStop = null,
  sendDisabled = false,
  sendButtonId = "remote-send-button",
  sendLabel = "Send",
  sendPending = false,
  stopButtonId = null,
  stopLabel = "Stop",
  stopPending = false,
  stopVisible = false,
}) {
  const inputDisabled = composerDisabled || sendPending;
  const submitDisabled = inputDisabled || sendDisabled;
  const stopDisabled = composerDisabled || stopPending;
  const textareaProps = {
    disabled: inputDisabled,
    id: messageId,
    placeholder: messagePlaceholder,
    rows: 1,
  };
  const modelSelectProps = {
    id: modelId,
    className: "composer-model-chip",
    "aria-label": "Model",
  };
  const modelOptions = buildModelOptions(models, currentModelValue);

  if (currentDraft !== undefined) {
    textareaProps.value = currentDraft;
  }
  if (onDraftChange) {
    textareaProps.onChange = (event) => onDraftChange(event.target.value);
  }
  if (currentModelValue !== undefined) {
    modelSelectProps.value = currentModelValue;
  }
  if (onModelChange) {
    modelSelectProps.onChange = (event) => onModelChange(event.target.value);
  }

  return h(
    "div",
    { className: "composer-inner" },
    h("textarea", textareaProps),
    h(
      "div",
      { className: "composer-actions" },
      actionsBeforeSend,
      modelOptions.length
        ? h(
            "select",
            modelSelectProps,
            ...modelOptions.map((model) => {
              const tag = model.provider ? `${model.provider} · ` : "";
              return h("option", { key: model.model, value: model.model }, `${tag}${model.display_name || model.model}`);
            })
          )
        : null,
      h(
        "button",
        {
          className: "send-button",
          disabled: submitDisabled,
          hidden: stopVisible,
          id: sendButtonId,
          type: "submit",
        },
        sendPending
          ? "Sending..."
          : [
              h("span", {
                key: "icon",
                className: "send-button-icon",
                "aria-hidden": "true",
                dangerouslySetInnerHTML: { __html: SEND_SVG },
              }),
              h("span", { key: "label", className: "send-button-label" }, sendLabel),
            ]
      ),
      stopButtonId || onStop
        ? h(
            "button",
            {
              className: "stop-button",
              disabled: stopDisabled,
              hidden: !stopVisible,
              id: stopButtonId || undefined,
              onClick: onStop ? () => onStop() : undefined,
              type: "button",
            },
            stopPending ? "Stopping..." : stopLabel
          )
        : null
    )
  );
}
