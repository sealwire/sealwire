import React from "react";

export {
  isReviewBlocked,
  isReviewInProgress,
  reviewChipTone,
  reviewStatusLabel,
} from "./review-state.js";

const h = React.createElement;

// Self-contained modal for requesting a cross-agent review. Manages its own
// draft state; the caller supplies the reviewer provider/model choices and an
// `onSubmit({ reviewerProvider, reviewerModel, instructions })` handler.
export function ReviewPanel({
  id = "review-panel",
  providerOptions = [],
  models = [],
  defaultProvider = "",
  submitting = false,
  onSubmit,
  onRequestClose,
}) {
  const [reviewerProvider, setReviewerProvider] = React.useState(defaultProvider || "");
  const [reviewerModel, setReviewerModel] = React.useState("");
  const [instructions, setInstructions] = React.useState("");

  React.useEffect(() => {
    if (!reviewerProvider && defaultProvider) {
      setReviewerProvider(defaultProvider);
    }
  }, [defaultProvider]);

  const providerModels = (models || []).filter(
    (model) => !model.provider || model.provider === reviewerProvider
  );

  const close = () => {
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  const submit = () => {
    if (!reviewerProvider || submitting) {
      return;
    }
    onSubmit?.({
      reviewerProvider,
      reviewerModel: reviewerModel || null,
      instructions: instructions.trim() || null,
    });
    close();
  };

  const providerSelectOptions = (providerOptions || []).map((option) => {
    const value = typeof option === "string" ? option : option.value;
    const label = typeof option === "string" ? option : option.label || option.value;
    return h("option", { key: value, value }, label);
  });

  return h(
    "dialog",
    {
      className: "panel-modal",
      id,
      onClose: () => onRequestClose?.(),
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      },
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Request review"),
      h(
        "button",
        { className: "header-button close-modal-btn", onClick: close, type: "button" },
        "×"
      )
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h(
        "p",
        { className: "panel-modal-copy" },
        "Ask another agent to review the current changes. The reviewer runs in its own thread and posts its findings back into this conversation."
      ),
      h("label", { className: "sidebar-label", htmlFor: `${id}-provider` }, "Reviewer provider"),
      h(
        "select",
        {
          id: `${id}-provider`,
          className: "control-input",
          value: reviewerProvider,
          onChange: (event) => {
            setReviewerProvider(event.target.value);
            setReviewerModel("");
          },
        },
        h("option", { value: "" }, "Select a provider…"),
        ...providerSelectOptions
      ),
      providerModels.length
        ? h(
            React.Fragment,
            null,
            h(
              "label",
              { className: "sidebar-label", htmlFor: `${id}-model` },
              "Reviewer model (optional)"
            ),
            h(
              "select",
              {
                id: `${id}-model`,
                className: "control-input",
                value: reviewerModel,
                onChange: (event) => setReviewerModel(event.target.value),
              },
              h("option", { value: "" }, "Provider default"),
              ...providerModels.map((model) =>
                h(
                  "option",
                  { key: model.model, value: model.model },
                  model.display_name || model.model
                )
              )
            )
          )
        : null,
      h(
        "label",
        { className: "sidebar-label", htmlFor: `${id}-reviewer-session` },
        "Reviewer session"
      ),
      h(
        "select",
        {
          id: `${id}-reviewer-session`,
          className: "control-input",
          value: "clean",
          disabled: true,
          title: "Reusing an existing reviewer thread is coming later.",
        },
        h("option", { value: "clean" }, "New clean reviewer session")
      ),
      h(
        "label",
        { className: "sidebar-label", htmlFor: `${id}-instructions` },
        "Instructions (optional)"
      ),
      h("textarea", {
        id: `${id}-instructions`,
        className: "control-input",
        rows: 3,
        placeholder: "e.g. focus on the storage refactor and its tests",
        value: instructions,
        onChange: (event) => setInstructions(event.target.value),
      })
    ),
    h(
      "div",
      { className: "modal-actions" },
      h(
        "button",
        {
          className: "start-session-button",
          disabled: submitting || !reviewerProvider,
          onClick: submit,
          type: "button",
        },
        submitting ? "Starting…" : "Start review"
      )
    )
  );
}

// A small "Review" button plus the (initially closed) ReviewPanel dialog,
// rendered together so a single mount carries both. The button opens the modal.
export function ReviewLauncher({
  panelId = "review-panel",
  providerOptions = [],
  models = [],
  defaultProvider = "",
  disabled = false,
  label = "Review",
  title = "Ask another agent to review the current changes",
  onSubmit,
}) {
  return h(
    React.Fragment,
    null,
    h(
      "button",
      {
        type: "button",
        className: "header-button review-launch-button",
        disabled,
        title,
        onClick: () => document.getElementById(panelId)?.showModal?.(),
      },
      label
    ),
    h(ReviewPanel, {
      id: panelId,
      providerOptions,
      models,
      defaultProvider,
      onSubmit,
    })
  );
}
