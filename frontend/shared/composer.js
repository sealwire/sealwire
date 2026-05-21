import React from "react";

import { SEND_SVG } from "../svg.js";

const h = React.createElement;

export function ConversationComposer({
  actionsBeforeSend = null,
  composerDisabled = false,
  currentDraft,
  currentEffortValue,
  currentModelValue,
  effortOptions = null,
  effortId = "remote-message-effort",
  effortLabel = "Effort",
  messageId = "remote-message-input",
  messagePlaceholder = "",
  modelId = "remote-message-model",
  modelLabel = "Model",
  models = [],
  onDraftChange = null,
  onEffortChange = null,
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
  const selectProps = {
    id: effortId,
  };
  const modelSelectProps = {
    id: modelId,
  };
  const modelOptions = [...models];
  const reasoningEffortOptions = effortOptions?.length
    ? effortOptions
    : [
        { label: "medium", value: "medium" },
        { label: "low", value: "low" },
        { label: "high", value: "high" },
        { label: "xhigh", value: "xhigh" },
      ];

  if (currentDraft !== undefined) {
    textareaProps.value = currentDraft;
  }
  if (onDraftChange) {
    textareaProps.onChange = (event) => onDraftChange(event.target.value);
  }
  if (currentEffortValue !== undefined) {
    selectProps.value = currentEffortValue;
  }
  if (onEffortChange) {
    selectProps.onChange = (event) => onEffortChange(event.target.value);
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
      modelOptions.length
        ? h(
            "label",
            { className: "composer-select", htmlFor: modelId },
            h("span", null, modelLabel),
            h(
              "select",
              modelSelectProps,
              ...modelOptions.map((model) => {
                const tag = model.provider ? `${model.provider} · ` : "";
                return h("option", { key: model.model, value: model.model }, `${tag}${model.display_name || model.model}`);
              })
            )
          )
        : null,
      h(
        "label",
        { className: "composer-select", htmlFor: effortId },
        h("span", null, effortLabel),
        h(
          "select",
          selectProps,
          ...reasoningEffortOptions.map((option) =>
            h("option", { key: option.value, value: option.value }, option.label)
          )
        )
      ),
      actionsBeforeSend,
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
