import React from "react";

const h = React.createElement;

export function ConversationComposer({
  composerDisabled = false,
  currentDraft,
  currentEffortValue = "medium",
  effortId = "remote-message-effort",
  effortLabel = "Effort",
  messageId = "remote-message-input",
  messagePlaceholder = "",
  onDraftChange = null,
  onEffortChange = null,
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

  return h(
    "div",
    { className: "composer-inner" },
    h("textarea", textareaProps),
    h(
      "div",
      { className: "composer-actions" },
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
