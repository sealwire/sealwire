import React from "react";

import { buildModelPickerGroups, selectedModelChip } from "./model-picker-model.js";
import { providerLabel } from "./provider-labels.js";
import { selectReviewerCatalogState } from "./review-state.js";
import {
  PromptCard,
  SessionContextBar,
  SessionDialogShell,
  SettingPillRow,
  SubmitShortcutHint,
} from "./session-dialog-chrome.js";
import { SettingPill } from "./setting-pill.js";
import { ThreadWorkspaceField } from "./workspace-picker.js";

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
  // Per-provider catalog status (`{ [provider]: "loading"|"ready"|"error" }`) and the
  // active session's provider, so the dialog can tell "no models" apart from "still
  // loading"/"failed" — and `onEnsureProviderModels(provider)` lets the dialog ASK the
  // surface to fetch a cross-agent provider's catalog that the boot pre-fetch missed.
  providerModelsStatus = {},
  activeProvider = "",
  onEnsureProviderModels,
  // Parent thread's ResolvedWorkspace; reviews run against this tree.
  workspace = null,
  workspaceBusy = false,
  workspaceError = null,
  onPinWorkspace = null,
  // Local surface only: `POST /api/workspace/trust` has no broker action, so a paired
  // device gets the explanation and no control. See `trustPrompt` in workspace-picker.js.
  onTrustWorkspace = null,
  // Fired when the tree picker opens, so the per-tree change counts are measured only
  // while they are on screen — they cost the relay a `git status` per worktree.
  onOpenWorkspace = null,
  // …and when it closes, so the relay stops measuring trees nobody is looking at.
  onCloseWorkspace = null,
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
  // Round budget for the iterative review loop (1 = single review).
  const [maxRounds, setMaxRounds] = React.useState(1);
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

  // Drop a reuse that the current tree/provider list no longer offers, so submit never sends a refused id.
  const selectedReviewerThreadId =
    reviewerThreadId !== "clean"
    && !reusableForProvider.some((entry) => entry.reviewerThreadId === reviewerThreadId)
      ? "clean"
      : reviewerThreadId;
  // Say so when a prefill was dropped; a silent clean start hid the mismatch.
  const droppedReuse = selectedReviewerThreadId !== reviewerThreadId;
  const isReuse = selectedReviewerThreadId !== "clean";

  // The selectable models for the chosen reviewer provider, plus whether the
  // catalog still needs fetching and its load status. The cross-agent provider's
  // catalog does NOT ride the session snapshot, so if the boot pre-fetch missed
  // it the dialog has to ask the surface to load it (instead of silently showing
  // an empty picker — the reported bug).
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
    // Intentionally keyed on the provider + the derived need: it fires once when a
    // provider with no catalog is selected, and never loops (a fetch flips status
    // to "loading"/"error", both of which make needsLoad false).
  }, [reviewerProvider, catalog.needsLoad]);

  const close = () => {
    setError(null);
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  // Switching provider invalidates a reuse selection (it belonged to the prior provider),
  // so fall back to a clean reviewer — and, when we were reusing, briefly highlight the
  // reviewer-session field so the user sees the system moved them off that session.
  const selectProvider = (value) => {
    const wasReusing = providerSwitchClearsReuse(selectedReviewerThreadId);
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
          // Effective selection: a dropped prefill must not reach the relay.
          reviewerThreadId: selectedReviewerThreadId,
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

  const modelChip = selectedModelChip({
    providerModels: { [reviewerProvider]: providerModels },
    selectedModel: reviewerModel,
    selectedProvider: reviewerProvider,
  });
  const reviewerChip = !reviewerProvider
    ? "Choose a provider"
    : isReuse && !reviewerModel
      ? `${providerLabel(reviewerProvider)} · current`
      : modelChip.value;

  const sessionOptions = [
    { value: "clean", label: "New clean reviewer session", chip: "New reviewer" },
    ...reusableForProvider.map((entry) => ({
      value: entry.reviewerThreadId,
      label: `Reuse: ${entry.label}`,
    })),
  ];
  const session = sessionOptions.find((option) => option.value === selectedReviewerThreadId);
  const rounds = clampReviewRounds(maxRounds);
  const briefing = BRIEFING_OPTIONS.find((option) => option.value === recapSource);
  const catalogNote = catalogStatusNote({
    catalog,
    onEnsureProviderModels,
    reviewerProvider,
  });
  const markSelected = (options, current) =>
    options.map((option) => ({ ...option, selected: option.value === current }));

  return h(
    SessionDialogShell,
    {
      actions: [
        h(
          "button",
          { className: "session-dialog-cancel", key: "cancel", onClick: close, type: "button" },
          "Cancel"
        ),
        h(
          "button",
          {
            className: "session-dialog-submit",
            disabled: busy || !reviewerProvider,
            id: `${id}-submit`,
            key: "submit",
            onClick: submit,
            type: "button",
          },
          busy ? "Starting…" : "Start review",
          h(SubmitShortcutHint)
        ),
      ],
      footerHint: "Runs in its own session, posts findings here",
      id,
      onRequestClose: () => {
        setError(null);
        onRequestClose?.();
      },
      title: "Request review",
    },
    // Which tree is reviewed; a mid-session worktree move is otherwise invisible.
    workspace || onPinWorkspace
      ? h(SessionContextBar, {
          key: "context",
          workspace: h(ThreadWorkspaceField, {
            busy: busy || workspaceBusy,
            error: workspaceError,
            id: `${id}-workspace`,
            label: "Working tree to review",
            onClose: onCloseWorkspace,
            onOpen: onOpenWorkspace,
            onPin: onPinWorkspace,
            onTrustWorkspace,
            workspace,
          }),
        })
      : null,
    h(PromptCard, {
      hint: "Optional",
      id: `${id}-instructions`,
      key: "instructions",
      onChange: setInstructions,
      onSubmit: submit,
      placeholder: "e.g. focus on the storage refactor and its tests",
      value: instructions,
    }),
    h(
      SettingPillRow,
      { key: "pills" },
      h(SettingPill, {
        groups: reviewerModelGroups({
          activeProvider,
          isReuse,
          models,
          providerModelsStatus,
          providerOptions,
          reviewerModel,
          reviewerProvider,
        }),
        id: `${id}-model`,
        key: "model",
        label: "Reviewer",
        // The menu lists every provider, so fetch the catalogues it is about to show.
        onOpen: () => {
          for (const provider of providerValues(providerOptions)) {
            const state = selectReviewerCatalogState({
              reviewerProvider: provider,
              models,
              providerModelsStatus,
              session: { provider: activeProvider },
            });
            if (state.needsLoad) onEnsureProviderModels?.(provider);
          }
        },
        onSelect: (value, option) => {
          const provider = option.provider || reviewerProvider;
          if (provider !== reviewerProvider) selectProvider(provider);
          setReviewerModel(value);
          // A new model may not support the previously-picked effort.
          setReviewerEffort("");
        },
        tag: isReuse && !reviewerModel ? null : modelChip.tag,
        value: reviewerChip,
      }),
      h(SettingPill, {
        id: `${id}-effort`,
        key: "effort",
        label: "Effort",
        onSelect: setReviewerEffort,
        options: markSelected(
          [
            { value: "", label: isReuse ? "Keep current effort" : "Model default" },
            ...effortOptions.map((effort) => ({ value: effort, label: effort })),
          ],
          reviewerEffort
        ),
        value: reviewerEffort || (isReuse ? "current" : "default"),
      }),
      h(SettingPill, {
        className: sessionAutoSwitched ? "reviewer-session-autoswitched" : "",
        id: `${id}-reviewer-session`,
        key: "session",
        label: "Session",
        onSelect: selectReviewerSession,
        options: markSelected(sessionOptions, selectedReviewerThreadId),
        value: session?.chip || session?.label,
      }),
      h(SettingPill, {
        id: `${id}-recap-source`,
        key: "briefing",
        label: "Briefing",
        onSelect: setRecapSource,
        options: markSelected(BRIEFING_OPTIONS, recapSource),
        value: briefing?.chip || recapSource,
      }),
      h(SettingPill, {
        id: `${id}-max-rounds`,
        key: "rounds",
        label: "Rounds",
        onSelect: (value) => setMaxRounds(clampReviewRounds(value)),
        options: markSelected(ROUND_OPTIONS, String(rounds)),
        value: String(rounds),
      })
    ),
    catalogNote,
    droppedReuse
      ? h(
          "p",
          { className: "session-dialog-note", key: "dropped-reuse" },
          "That reviewer session can't review this working tree — a reviewer stays in the tree it was created in — so this review starts a clean one."
        )
      : null,
    isReuse
      ? h(
          "p",
          { className: "session-dialog-note", key: "reuse" },
          "Reusing this reviewer session — it keeps its earlier review context. Switching the provider starts a new reviewer instead."
        )
      : null,
    rounds > 1
      ? h(
          "p",
          { className: "session-dialog-note", key: "rounds" },
          "The reviewer and the author iterate until the reviewer approves or the rounds run out (then it's handed back to you). The author session must be able to edit without approval prompts."
        )
      : null,
    // A rejected request stays here (the modal no longer closes optimistically),
    // so the user sees the relay's reason instead of a silent no-op.
    error
      ? h("p", { className: "session-dialog-note is-error", key: "error", role: "alert" }, error)
      : null
  );
}

const BRIEFING_OPTIONS = [
  {
    value: "last_message",
    label: "Use the author's last message (faster)",
    chip: "Last message",
    subtitle: "The latest message plus the diff — no extra turn; recaps if there's none yet.",
  },
  {
    value: "recap",
    label: "Ask the author to recap the changes",
    chip: "Recap",
    subtitle: "The author summarizes its changes first — most context, but an extra turn.",
  },
];

const ROUND_OPTIONS = Array.from({ length: 10 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
  subtitle: index === 0 ? "A single review" : null,
}));

function providerValues(providerOptions) {
  return (providerOptions || []).map((option) =>
    typeof option === "string" ? option : option.value
  );
}

// Unlike a session's, a reviewer's model is optional, so every group leads with the
// "no override" row the old model select offered.
function reviewerModelGroups({
  activeProvider,
  isReuse,
  models,
  providerModelsStatus,
  providerOptions,
  reviewerModel,
  reviewerProvider,
}) {
  const providers = providerValues(providerOptions);
  const catalogs = Object.fromEntries(
    providers.map((provider) => [
      provider,
      selectReviewerCatalogState({
        reviewerProvider: provider,
        models,
        providerModelsStatus,
        session: { provider: activeProvider },
      }).models,
    ])
  );
  return buildModelPickerGroups({
    providerModels: catalogs,
    providers,
    selectedModel: reviewerModel,
    selectedProvider: reviewerProvider,
  }).map((group) => {
    const named = (providerOptions || []).find(
      (option) => typeof option !== "string" && option.value === group.provider
    );
    const current = group.provider === reviewerProvider;
    return {
      ...group,
      label: named?.label || group.label,
      options: [
        {
          label: isReuse && current ? "Keep current model" : "Provider default",
          provider: group.provider,
          selected: current && !reviewerModel,
          tag: null,
          value: "",
        },
        ...group.options.filter((option) => option.value !== ""),
      ],
    };
  });
}

// Only when a loader is wired to resolve it: otherwise the hint could never clear.
function catalogStatusNote({ catalog, onEnsureProviderModels, reviewerProvider }) {
  if (catalog.models.length || typeof onEnsureProviderModels !== "function") {
    return null;
  }
  if (catalog.modelsStatus === "error") {
    return h(
      "p",
      { className: "session-dialog-note", "data-models-status": "error", key: "models" },
      "Couldn't load the reviewer models — the review will use the provider default. ",
      h(
        "button",
        {
          className: "link-button",
          onClick: () => onEnsureProviderModels(reviewerProvider),
          type: "button",
        },
        "Retry"
      )
    );
  }
  if (catalog.modelsStatus === "loading") {
    return h(
      "p",
      { className: "session-dialog-note", "data-models-status": "loading", key: "models" },
      "Loading reviewer models…"
    );
  }
  return null;
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
  providerModelsStatus = {},
  activeProvider = "",
  onEnsureProviderModels,
  workspace = null,
  workspaceBusy = false,
  workspaceError = null,
  onPinWorkspace = null,
  onTrustWorkspace = null,
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
      providerModelsStatus,
      activeProvider,
      onEnsureProviderModels,
      workspace,
      workspaceBusy,
      workspaceError,
      onPinWorkspace,
      onTrustWorkspace,
      onSubmit,
    })
  );
}
