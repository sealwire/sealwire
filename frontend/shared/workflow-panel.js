import React from "react";

import { providerMarkSlot } from "./provider-mark.js";
import { clampReviewRounds } from "./review-panel.js";
import { selectReviewerCatalogState } from "./review-state.js";
import {
  workflowChipTone,
  workflowStatusLabel,
  workflowStepLabel,
} from "./workflow-state.js";

const h = React.createElement;

export function workflowSubmitPayload({
  taskPrompt,
  reviewerProvider,
  reviewerModel,
  reviewerInstructions,
  maxRounds,
  parentThreadId,
} = {}) {
  return {
    taskPrompt: (taskPrompt || "").trim(),
    reviewerProvider,
    reviewerModel: reviewerModel || null,
    reviewerInstructions: (reviewerInstructions || "").trim() || null,
    maxRounds: clampReviewRounds(maxRounds || 2),
    // The thread the panel is showing — Code Flow authors on THIS thread, mirroring
    // how Request review targets the viewed thread. Falls through to the active
    // thread server-side when null.
    parentThreadId: parentThreadId || null,
  };
}

export function CodeFlowPanel({
  id = "code-flow-panel",
  providerOptions = [],
  models = [],
  defaultProvider = "",
  providerModelsStatus = {},
  activeProvider = "",
  parentThreadId = null,
  onEnsureProviderModels,
  submitting: submittingProp = false,
  onSubmit,
  onRequestClose,
}) {
  const [taskPrompt, setTaskPrompt] = React.useState("");
  const [reviewerProvider, setReviewerProvider] = React.useState(defaultProvider || "");
  const [reviewerModel, setReviewerModel] = React.useState("");
  const [reviewerInstructions, setReviewerInstructions] = React.useState("");
  const [maxRounds, setMaxRounds] = React.useState("2");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  const busy = submitting || submittingProp;

  React.useEffect(() => {
    if (!reviewerProvider && defaultProvider) {
      setReviewerProvider(defaultProvider);
    }
  }, [defaultProvider]);

  const catalog = selectReviewerCatalogState({
    reviewerProvider,
    models,
    providerModelsStatus,
    session: { provider: activeProvider },
  });
  const providerModels = catalog.models;

  React.useEffect(() => {
    if (catalog.needsLoad && typeof onEnsureProviderModels === "function") {
      onEnsureProviderModels(reviewerProvider);
    }
  }, [reviewerProvider, catalog.needsLoad]);

  const close = () => {
    setError(null);
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  const submit = async () => {
    if (!taskPrompt.trim() || !reviewerProvider || busy) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await onSubmit?.(
        workflowSubmitPayload({
          taskPrompt,
          reviewerProvider,
          reviewerModel,
          reviewerInstructions,
          maxRounds,
          parentThreadId,
        })
      );
      if (result === false) {
        setError("Couldn't start Code Flow — check the activity log for details.");
        return;
      }
      close();
      setTaskPrompt("");
      setReviewerInstructions("");
      setReviewerModel("");
      setMaxRounds("2");
    } catch (err) {
      setError(err?.message || "Couldn't start Code Flow.");
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
        if (event.target === event.currentTarget) close();
      },
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "Run Code Flow"),
      h(
        "button",
        { className: "header-button close-modal-btn", onClick: close, type: "button" },
        "×"
      )
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h("label", { className: "sidebar-label", htmlFor: `${id}-task` }, "Task"),
      h("textarea", {
        id: `${id}-task`,
        className: "control-input",
        rows: 5,
        placeholder: "Implement the change, update tests, and keep the diff focused.",
        value: taskPrompt,
        onChange: (event) => setTaskPrompt(event.target.value),
      }),
      h("label", { className: "sidebar-label", htmlFor: `${id}-provider` }, "Reviewer provider"),
      h(
        "div",
        { className: "select-with-mark" },
        providerMarkSlot(reviewerProvider, { className: "select-mark" }),
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
        )
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
        : typeof onEnsureProviderModels !== "function"
          ? null
          : catalog.modelsStatus === "error"
            ? h(
                "p",
                { className: "panel-modal-copy" },
                "Couldn't load reviewer models. ",
                h(
                  "button",
                  {
                    type: "button",
                    className: "link-button",
                    onClick: () => onEnsureProviderModels?.(reviewerProvider),
                  },
                  "Retry"
                )
              )
            : catalog.modelsStatus === "loading"
              ? h("p", { className: "panel-modal-copy" }, "Loading reviewer models…")
              : null,
      h(
        "label",
        { className: "sidebar-label", htmlFor: `${id}-reviewer-instructions` },
        "Reviewer instructions (optional)"
      ),
      h("textarea", {
        id: `${id}-reviewer-instructions`,
        className: "control-input",
        rows: 3,
        placeholder: "e.g. focus on regressions, tests, and scope creep",
        value: reviewerInstructions,
        onChange: (event) => setReviewerInstructions(event.target.value),
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
        onChange: (event) => setMaxRounds(event.target.value),
        onBlur: () => setMaxRounds(String(clampReviewRounds(maxRounds || 2))),
      }),
      error ? h("p", { className: "panel-modal-error", role: "alert" }, error) : null
    ),
    h(
      "div",
      { className: "modal-actions" },
      h(
        "button",
        {
          className: "start-session-button",
          disabled: busy || !taskPrompt.trim() || !reviewerProvider,
          onClick: submit,
          type: "button",
        },
        busy ? "Starting…" : "Start Code Flow"
      )
    )
  );
}

export function CodeFlowLauncher({
  panelId = "code-flow-panel",
  providerOptions = [],
  models = [],
  defaultProvider = "",
  providerModelsStatus = {},
  activeProvider = "",
  parentThreadId = null,
  onEnsureProviderModels,
  disabled = false,
  label = "Run code flow",
  title = "Run author, reviewer, and revise steps",
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
    h(CodeFlowPanel, {
      id: panelId,
      providerOptions,
      models,
      defaultProvider,
      providerModelsStatus,
      activeProvider,
      parentThreadId,
      onEnsureProviderModels,
      onSubmit,
    })
  );
}

export function WorkflowRunCard({ run, onResolveWorkflow }) {
  const [resolvePending, setResolvePending] = React.useState(false);
  React.useEffect(() => {
    if (run?.status !== "blocked") {
      setResolvePending(false);
    }
  }, [run?.id, run?.status]);
  const tone = workflowChipTone(run?.status);
  const stepLabel = workflowStepLabel(run?.current_step);
  const findings = Array.isArray(run?.last_verdict?.findings)
    ? run.last_verdict.findings.filter(Boolean)
    : [];
  const blocked = run?.status === "blocked";
  const resolving = run?.status === "resolving";
  const resolveDisabled = resolvePending || resolving;
  const showResolveAction = (blocked || resolving) && typeof onResolveWorkflow === "function";
  const handleResolve = () => {
    if (!blocked || resolveDisabled) return;
    setResolvePending(true);
    Promise.resolve(onResolveWorkflow(run.id))
      .catch(() => {})
      .finally(() => setResolvePending(false));
  };
  // A code-flow run is WORK IN FLIGHT; a reviewer job is a RESULT. They used to render as
  // the same card in the same list, so "still running" and "finished and
  // approved" were the same object at a glance. This is deliberately a compact ROW rather
  // than a card: it carries no verdict to headline, and sizing it like one implied it did.
  const metaParts = ["code flow"];
  if (stepLabel) metaParts.push(stepLabel.toLowerCase());
  // `round` is all the wire carries — WorkflowRunView has no max_rounds, so there is no
  // "1/2" to show without inventing a denominator.
  if (run?.round) metaParts.push(`round ${run.round}`);
  return h(
    "article",
    { className: `workflow-run workflow-run-${tone}` },
    h(
      "div",
      { className: "workflow-run-lead" },
      h("span", { "aria-hidden": "true", className: "workflow-run-mark" }),
      h(
        "div",
        { className: "workflow-run-text" },
        h("p", { className: "workflow-run-title" }, workflowStatusLabel(run?.status)),
        h("p", { className: "workflow-run-meta" }, metaParts.join(" · "))
      ),
      showResolveAction
        ? h(
            "button",
            {
              type: "button",
              className: "header-button review-resolve-button workflow-run-stop",
              disabled: resolveDisabled,
              title:
                "The workflow is blocked while owned turns are stopped. Stop them to unlock the workspace.",
              onClick: handleResolve,
            },
            // Kept explicit rather than shortened to "Stop": this button ONLY appears for
            // a blocked/resolving run, where the workspace is locked and unlocking it is
            // the actual reason to press it. The tooltip should not be the only place
            // that says so.
            resolveDisabled ? "Stopping workflow…" : "Stop workflow & unlock"
          )
        : null
    ),
    run?.last_verdict
      ? h(
          "p",
          { className: "workflow-run-verdict" },
          run.last_verdict.approved ? "Approved" : "Needs changes"
        )
      : null,
    findings.length
      ? h("div", { className: "workflow-run-findings" }, findings.join("\n\n"))
      : null,
    run?.error ? h("p", { className: "reviewer-card-error" }, run.error) : null
  );
}
