import React from "react";

export {
  isReviewBlocked,
  isReviewInProgress,
  reviewChipTone,
  reviewStatusLabel,
} from "./review-state.js";

const h = React.createElement;

// Normalize the review request panel's draft into the `onSubmit` payload. Pure +
// exported so the reuse contract is unit-testable without driving React state:
// a reused thread carries its id and NEVER an explicit model (it keeps its own
// session model); a clean reviewer sends `reviewerThreadId: null`.
export function reviewSubmitPayload({
  reviewerProvider,
  reviewerModel,
  instructions,
  reviewerThreadId,
  maxRounds,
} = {}) {
  const isReuse = Boolean(reviewerThreadId) && reviewerThreadId !== "clean";
  return {
    reviewerProvider,
    reviewerModel: isReuse ? null : reviewerModel || null,
    instructions: (instructions || "").trim() || null,
    reviewerThreadId: isReuse ? reviewerThreadId : null,
    // 1 = single review (default); >1 enables the iterative reviewer↔author loop.
    // Clamped to 1..=10 (the backend re-clamps too).
    maxRounds: clampReviewRounds(maxRounds),
  };
}

// Clamp the round budget to a sane integer in 1..=10 (default 1).
export function clampReviewRounds(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, n));
}

// Self-contained modal for requesting a cross-agent review. Manages its own
// draft state; the caller supplies the reviewer provider/model choices, the list
// of reusable reviewer threads, and an
// `onSubmit({ reviewerProvider, reviewerModel, instructions, reviewerThreadId })`
// handler. `reviewerThreadId` is null for a clean reviewer, or the id of an
// existing reviewer thread to reuse (Phase 3).
export function ReviewPanel({
  id = "review-panel",
  providerOptions = [],
  models = [],
  defaultProvider = "",
  reusableReviewers = [],
  submitting = false,
  onSubmit,
  onRequestClose,
}) {
  const [reviewerProvider, setReviewerProvider] = React.useState(defaultProvider || "");
  const [reviewerModel, setReviewerModel] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  // "clean" for a new reviewer, or an existing reviewer thread id to reuse.
  const [reviewerThreadId, setReviewerThreadId] = React.useState("clean");
  // Round budget for the iterative review loop (1 = single review).
  const [maxRounds, setMaxRounds] = React.useState(1);

  React.useEffect(() => {
    if (!reviewerProvider && defaultProvider) {
      setReviewerProvider(defaultProvider);
    }
  }, [defaultProvider]);

  // Reusable reviewers offered for the currently-selected provider (an unknown
  // provider — null, after a restart — is always offered).
  const reusableForProvider = (reusableReviewers || []).filter(
    (entry) => entry?.provider == null || entry.provider === reviewerProvider
  );
  const isReuse = reviewerThreadId !== "clean";

  const providerModels = (models || []).filter(
    (model) => !model.provider || model.provider === reviewerProvider
  );

  const close = () => {
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  // Switching provider invalidates a reuse selection (it belonged to the prior
  // provider), so fall back to a clean reviewer.
  const selectProvider = (value) => {
    setReviewerProvider(value);
    setReviewerModel("");
    setReviewerThreadId("clean");
  };

  // Choosing an existing reviewer locks the provider to that thread's provider
  // (the reused thread keeps its own session + model).
  const selectReviewerSession = (value) => {
    setReviewerThreadId(value);
    if (value === "clean") {
      return;
    }
    const entry = reusableForProvider.find((item) => item.reviewerThreadId === value);
    if (entry?.provider) {
      setReviewerProvider(entry.provider);
    }
    setReviewerModel("");
  };

  const submit = () => {
    if (!reviewerProvider || submitting) {
      return;
    }
    onSubmit?.(
      reviewSubmitPayload({
        reviewerProvider,
        reviewerModel,
        instructions,
        reviewerThreadId,
        maxRounds,
      })
    );
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
          // Locked while reusing — the reviewer thread's provider is fixed.
          disabled: isReuse,
          onChange: (event) => selectProvider(event.target.value),
        },
        h("option", { value: "" }, "Select a provider…"),
        ...providerSelectOptions
      ),
      // Model selection is hidden while reusing: the existing thread keeps its own
      // session model.
      !isReuse && providerModels.length
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
          value: reviewerThreadId,
          onChange: (event) => selectReviewerSession(event.target.value),
        },
        h("option", { value: "clean" }, "New clean reviewer session"),
        ...reusableForProvider.map((entry) =>
          h(
            "option",
            { key: entry.reviewerThreadId, value: entry.reviewerThreadId },
            `Reuse: ${entry.label}`
          )
        )
      ),
      isReuse
        ? h(
            "p",
            { className: "panel-modal-copy" },
            "Provider and model are fixed by the existing reviewer thread. It keeps its earlier review context."
          )
        : null,
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
      }),
      h(
        "label",
        { className: "sidebar-label", htmlFor: `${id}-max-rounds` },
        "Maximum rounds"
      ),
      h("input", {
        id: `${id}-max-rounds`,
        type: "number",
        className: "control-input",
        min: 1,
        max: 10,
        value: maxRounds,
        onChange: (event) => setMaxRounds(clampReviewRounds(event.target.value)),
      }),
      maxRounds > 1
        ? h(
            "p",
            { className: "panel-modal-copy" },
            "The reviewer and the author iterate until the reviewer approves or the rounds run out (then it's handed back to you). The author thread must be able to edit without approval prompts."
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
  reusableReviewers = [],
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
      reusableReviewers,
      onSubmit,
    })
  );
}
