import React from "react";

import { SEND_SVG } from "../svg.js";

const h = React.createElement;

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
  const modelOptions = [...models];

  if (currentDraft !== undefined) {
    textareaProps.value = currentDraft;
  }
  if (onDraftChange) {
    textareaProps.onChange = (event) => onDraftChange(event.target.value);
  }
  if (currentModelValue && !modelOptions.some((model) => model.model === currentModelValue)) {
    modelOptions.unshift({
      display_name: currentModelValue,
      model: currentModelValue,
    });
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
