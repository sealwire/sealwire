import React from "react";

const h = React.createElement;

export function ConversationComposer({
  composerDisabled = false,
  currentDraft,
  currentEffortValue = "medium",
  currentModelValue,
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
  sendButtonId = "remote-send-button",
  sendLabel = "Send",
  sendPending = false,
}) {
  const submitDisabled = composerDisabled || sendPending;
  const textareaProps = {
    disabled: submitDisabled,
    id: messageId,
    placeholder: messagePlaceholder,
    rows: 3,
  };
  const selectProps = {
    id: effortId,
  };
  const modelSelectProps = {
    id: modelId,
  };
  const modelOptions = [...models];

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
              ...modelOptions.map((model) =>
                h("option", { key: model.model, value: model.model }, model.display_name || model.model)
              )
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
          h("option", { value: "medium" }, "medium"),
          h("option", { value: "low" }, "low"),
          h("option", { value: "high" }, "high")
        )
      ),
      h(
        "button",
        {
          className: "send-button",
          disabled: submitDisabled,
          id: sendButtonId,
          type: "submit",
        },
        sendPending ? "Sending..." : sendLabel
      )
    )
  );
}
