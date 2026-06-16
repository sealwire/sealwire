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
  reviewerEffort,
  instructions,
  reviewerThreadId,
  parentThreadId,
  maxRounds,
  recapSource,
} = {}) {
  const isReuse = Boolean(reviewerThreadId) && reviewerThreadId !== "clean";
  return {
    reviewerProvider,
    // The thread to review. The reviewer panel is scoped to the VIEWED thread, so a
    // re-review must target that thread — not whatever the relay's active thread is.
    // null lets the backend default to the active thread (the common, same-thread case).
    parentThreadId: parentThreadId || null,
    // Model + effort are honored for clean AND reused reviewers: an empty value
    // (null) means "use the reviewer's own / the provider default", a non-empty one
    // overrides it for this run. (A reused thread no longer silently ignores them.)
    reviewerModel: reviewerModel || null,
    reviewerEffort: reviewerEffort || null,
    instructions: (instructions || "").trim() || null,
    reviewerThreadId: isReuse ? reviewerThreadId : null,
    // 1 = single review (default); >1 enables the iterative reviewer↔author loop.
    // Clamped to 1..=10 (the backend re-clamps too).
    maxRounds: clampReviewRounds(maxRounds),
    // How to brief the reviewer: "last_message" (default — pass the author's last
    // message, no recap turn, saves tokens) or "recap" (drive a fresh recap turn).
    recapSource: recapSource === "recap" ? "recap" : "last_message",
  };
}

// Clamp the round budget to a sane integer in 1..=10 (default 1).
export function clampReviewRounds(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, n));
}

// Pure: switching the reviewer provider always falls back to a clean reviewer (the prior
// reuse selection belonged to the old provider). Returns whether a reused session was
// switched away from, so the caller can flash the reviewer-session field to signal it.
export function providerSwitchClearsReuse(reviewerThreadId) {
  return Boolean(reviewerThreadId) && reviewerThreadId !== "clean";
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
  // The thread this review targets (the thread the reviewer panel is showing). Sent as
  // parent_thread_id so the backend reviews THIS thread, not the relay's active thread.
  parentThreadId = null,
  // Pre-seed the form to reuse a specific reviewer (the per-card "Re-review" entry
  // point): the reuse dropdown lands on this thread and the provider is locked to it.
  initialReviewerThreadId = "clean",
  initialProvider = "",
  submitting: submittingProp = false,
  onSubmit,
  onRequestClose,
}) {
  const [reviewerProvider, setReviewerProvider] = React.useState(
    initialProvider || defaultProvider || ""
  );
  const [reviewerModel, setReviewerModel] = React.useState("");
  // Optional reasoning-effort override for the reviewer's turn(s). "" = default.
  const [reviewerEffort, setReviewerEffort] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  // "clean" for a new reviewer, or an existing reviewer thread id to reuse.
  const [reviewerThreadId, setReviewerThreadId] = React.useState(
    initialReviewerThreadId || "clean"
  );
  // How to brief the reviewer: "last_message" (default — pass the author's last
  // message, skipping the recap turn) or "recap" (drive a fresh recap turn).
  const [recapSource, setRecapSource] = React.useState("last_message");
  // Round budget for the iterative review loop (1 = single review). Kept as a RAW
  // string while editing so the field can be cleared / typed freely; it's clamped to
  // 1..=10 on blur and at submit (clampReviewRounds). Storing a clamped number here
  // made deleting the digit snap back to "1", so you could never type a new value.
  const [maxRounds, setMaxRounds] = React.useState("1");
  // In-flight + error state for the submit itself. Previously the modal closed
  // optimistically and any backend rejection (e.g. "another thread is running in
  // this workspace", provider unavailable, "a review is already running") only
  // surfaced in the buried activity log — so clicking "Start review" looked like
  // it did nothing. Now a rejected request keeps the modal open and shows why.
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  // Brief highlight on the reviewer-session field after changing the provider auto-resets a
  // reused session to "clean" — so the user notices the system moved them off that session.
  const [sessionAutoSwitched, setSessionAutoSwitched] = React.useState(false);
  const busy = submitting || submittingProp;

  React.useEffect(() => {
    if (!reviewerProvider && defaultProvider) {
      setReviewerProvider(defaultProvider);
    }
  }, [defaultProvider]);

  // Clear the auto-switch highlight after it has flashed once (the CSS animation is one-shot;
  // dropping the class lets it re-trigger on the next provider switch).
  React.useEffect(() => {
    if (!sessionAutoSwitched) {
      return undefined;
    }
    const timer = setTimeout(() => setSessionAutoSwitched(false), 1200);
    return () => clearTimeout(timer);
  }, [sessionAutoSwitched]);

  // Reusable reviewers offered for the currently-selected provider (an unknown
  // provider — null, after a restart — is always offered).
  const reusableForProvider = (reusableReviewers || []).filter(
    (entry) => entry?.provider == null || entry.provider === reviewerProvider
  );
  const isReuse = reviewerThreadId !== "clean";

  const providerModels = (models || []).filter(
    (model) =>
      (!model.provider || model.provider === reviewerProvider) && !model.hidden
  );

  const close = () => {
    setError(null);
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  // Switching provider invalidates a reuse selection (it belonged to the prior provider),
  // so fall back to a clean reviewer — and, when we were reusing, briefly highlight the
  // reviewer-session field so the user sees the system moved them off that session.
  const selectProvider = (value) => {
    const wasReusing = providerSwitchClearsReuse(reviewerThreadId);
    setReviewerProvider(value);
    setReviewerModel("");
    setReviewerEffort("");
    setReviewerThreadId("clean");
    if (wasReusing) {
      setSessionAutoSwitched(true);
    }
  };

  // Choosing an existing reviewer locks the provider to that thread's provider.
  // Model/effort default to "keep current" but can still be overridden below.
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
    setReviewerEffort("");
  };

  // Reasoning-effort options for the currently-selected model (fall back to the
  // common low/medium/high triple when the catalog doesn't enumerate them).
  const selectedModel = providerModels.find((model) => model.model === reviewerModel);
  const effortOptions =
    selectedModel?.supported_reasoning_efforts?.length
      ? selectedModel.supported_reasoning_efforts
      : ["low", "medium", "high"];

  const submit = async () => {
    if (!reviewerProvider || busy) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // The request helpers signal failure either by throwing (local lifecycle +
      // remote ops re-raise the relay's reason) or by resolving `false` (a guard
      // tripped before dispatch). Both keep the modal open with an explanation;
      // only a real success closes it.
      const result = await onSubmit?.(
        reviewSubmitPayload({
          reviewerProvider,
          reviewerModel,
          reviewerEffort,
          instructions,
          reviewerThreadId,
          parentThreadId,
          maxRounds,
          recapSource,
        })
      );
      if (result === false) {
        setError("Couldn't start the review — check the activity log for details.");
        return;
      }
      close();
    } catch (err) {
      setError(err?.message || "Couldn't start the review.");
    } finally {
      setSubmitting(false);
    }
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
          // Always changeable: switching the provider off a reused session falls back to a
          // clean reviewer of the new provider (highlighted on the reviewer-session field).
          onChange: (event) => selectProvider(event.target.value),
        },
        h("option", { value: "" }, "Select a provider…"),
        ...providerSelectOptions
      ),
      // Model + effort are selectable for clean AND reused reviewers. On reuse the
      // empty option keeps the reviewer thread's own model/effort; picking a value
      // overrides it for this run (the backend honors both).
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
                onChange: (event) => {
                  setReviewerModel(event.target.value);
                  // A new model may not support the previously-picked effort.
                  setReviewerEffort("");
                },
              },
              h("option", { value: "" }, isReuse ? "Keep current model" : "Provider default"),
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
        { className: "sidebar-label", htmlFor: `${id}-effort` },
        "Reasoning effort (optional)"
      ),
      h(
        "select",
        {
          id: `${id}-effort`,
          className: "control-input",
          value: reviewerEffort,
          onChange: (event) => setReviewerEffort(event.target.value),
        },
        h("option", { value: "" }, isReuse ? "Keep current effort" : "Model default"),
        ...effortOptions.map((effort) =>
          h("option", { key: effort, value: effort }, effort)
        )
      ),
      h(
        "label",
        { className: "sidebar-label", htmlFor: `${id}-reviewer-session` },
        "Reviewer session"
      ),
      h(
        "select",
        {
          id: `${id}-reviewer-session`,
          className: sessionAutoSwitched
            ? "control-input reviewer-session-autoswitched"
            : "control-input",
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
            "Reusing this reviewer thread — it keeps its earlier review context. Switching the provider starts a new reviewer instead."
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
        { className: "sidebar-label", htmlFor: `${id}-recap-source` },
        "Briefing"
      ),
      h(
        "select",
        {
          id: `${id}-recap-source`,
          className: "control-input",
          value: recapSource,
          onChange: (event) => setRecapSource(event.target.value),
        },
        h("option", { value: "last_message" }, "Use the author's last message (faster)"),
        h("option", { value: "recap" }, "Ask the author to recap the changes")
      ),
      h(
        "p",
        { className: "panel-modal-copy" },
        recapSource === "recap"
          ? "The author runs a turn to summarize its changes before the reviewer looks — most context, but costs an extra turn."
          : "The reviewer is briefed with the author's latest message (plus the diff) — no extra turn, saves tokens. Falls back to a recap if there's no message yet."
      ),
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
        // Keep the raw string while typing (so the field can be cleared); normalize
        // to a clamped integer on blur. Submit clamps again via reviewSubmitPayload.
        onChange: (event) => setMaxRounds(event.target.value),
        onBlur: () => setMaxRounds(String(clampReviewRounds(maxRounds))),
      }),
      clampReviewRounds(maxRounds) > 1
        ? h(
            "p",
            { className: "panel-modal-copy" },
            "The reviewer and the author iterate until the reviewer approves or the rounds run out (then it's handed back to you). The author thread must be able to edit without approval prompts."
          )
        : null,
      // A rejected request stays here (the modal no longer closes optimistically),
      // so the user sees the relay's reason instead of a silent no-op.
      error
        ? h("p", { className: "panel-modal-error", role: "alert" }, error)
        : null
    ),
    h(
      "div",
      { className: "modal-actions" },
      h(
        "button",
        {
          className: "start-session-button",
          disabled: busy || !reviewerProvider,
          onClick: submit,
          type: "button",
        },
        busy ? "Starting…" : "Start review"
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
  parentThreadId = null,
  initialReviewerThreadId = "clean",
  initialProvider = "",
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
      parentThreadId,
      initialReviewerThreadId,
      initialProvider,
      onSubmit,
    })
  );
}
