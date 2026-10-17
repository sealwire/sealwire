import React from "react";

import { t } from "./i18n.js";
import { ModelPicker } from "./model-picker.js";
import { ProjectPicker } from "./project-picker.js";
import { SettingPill } from "./setting-pill.js";
import { WorkspacePicker } from "./workspace-picker.js";
import { abbreviateHomePath } from "./workspace-chip-model.js";
import { launchModelPickerProps } from "./model-picker-model.js";
import {
  PromptCard,
  SessionContextBar,
  SessionDialogShell,
  SettingPillRow,
  SubmitShortcutHint,
} from "./session-dialog-chrome.js";

const h = React.createElement;

// Fully controlled: every value arrives in `fields` and leaves through
// `onFieldChange`. `start-session-payload.test.mjs` pins the resulting request.
export function StartSessionDialog({
  approvalOptions = [],
  effortOptions = [],
  fields = {},
  gitContext = null,
  id,
  initialPromptAttachmentsId = null,
  attachControl = null,
  modelsStatus = "ready",
  nativeTerminalProviders = [],
  onCreateProject = null,
  onFieldChange = null,
  onOpenModelPicker = null,
  // Its own callback, not two onFieldChange calls: provider, model and effort must
  // move together, and the second of two sequential calls reads a stale render.
  onSelectModel = null,
  onRequestClose = null,
  // Resolves `{ ok, error }`. Only `ok` closes the dialog; anything else shows why.
  onStart = null,
  projects = [],
  providerModels = {},
  providers = [],
  // Claude consumes its first prompt at thread creation, so an empty prompt
  // would start a session that cannot be talked to until it is re-prompted.
  requireInitialPrompt = true,
  startPending = false,
  threadProjectId = {},
  threads = [],
  workspaceSuggestions = [],
}) {
  const cwd = fields.cwd || "";
  const provider = fields.provider || "";
  const isClaudeCode = provider === "claude_code";
  const claudeTerminal = isClaudeCode && fields.presentation === "terminal";
  const requiresInitialPrompt = requireInitialPrompt && isClaudeCode && !claudeTerminal;
  const invalidTerminalPermissions = claudeTerminal && (fields.approvalPolicy !== "bypass" || !["workspace-write", "danger-full-access"].includes(fields.sandbox));
  const hasInitialPrompt = Boolean(fields.initialPrompt?.trim());
  const startDisabled =
    startPending || invalidTerminalPermissions || !cwd.trim() || (requiresInitialPrompt && !hasInitialPrompt);

  const [startError, setStartError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  // The request is already built, so an edit now would not be what gets started.
  const locked = startPending || submitting;
  // Bumped on every close, so a result for an earlier opening cannot land on this one.
  const openingRef = React.useRef(0);
  // A ref, not startPending: the host only flips that on a later render.
  const inFlightRef = React.useRef(false);

  const requestClose = () => {
    openingRef.current += 1;
    setStartError("");
    onRequestClose?.();
  };
  const changeField = (field, value) => {
    if (locked || inFlightRef.current) {
      return;
    }
    setStartError("");
    onFieldChange?.(field, value);
  };

  const submit = async () => {
    if (startDisabled || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    const opening = openingRef.current;
    setStartError("");
    setSubmitting(true);
    let result;
    try {
      result = await onStart?.();
    } catch (error) {
      result = { ok: false, error: error?.message };
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
    if (openingRef.current !== opening) {
      return;
    }
    if (result?.ok) {
      document.getElementById(id)?.close?.();
      return;
    }
    setStartError(result?.error || t("Couldn't start the session."));
  };

  const selectedApproval = approvalOptions.find((option) => option.value === fields.approvalPolicy);
  const selectedEffort = effortOptions.find((option) => option.value === fields.effort);

  return h(
    SessionDialogShell,
    {
      actions: [
        h(
          "button",
          {
            className: "session-dialog-cancel",
            key: "cancel",
            onClick: () => {
              requestClose();
              document.getElementById(id)?.close?.();
            },
            type: "button",
          },
          t("Cancel")
        ),
        h(
          "button",
          {
            className: "session-dialog-submit",
            disabled: startDisabled || locked,
            id: `${id}-start`,
            key: "start",
            onClick: submit,
            type: "button",
          },
          locked ? t("Starting…") : t("Start session"),
          h(SubmitShortcutHint)
        ),
      ],
      alert: startError || null,
      // Sessions do NOT get a worktree — only Task-team runs provision one — so
      // this must not promise isolation the session does not have.
      footerHint: cwd ? t("Runs in {path}", { path: abbreviateHomePath(cwd) }) : t("Choose a directory to run in"),
      id,
      onRequestClose: requestClose,
      title: t("New session"),
    },
    h(SessionContextBar, {
      key: "context",
      project: h(ProjectPicker, {
        activeProjectId: fields.projectId || null,
        disabled: locked,
        onCreateProject,
        onSelectProject: (projectId) => changeField("projectId", projectId),
        projects,
        threadProjectId,
        threads,
      }),
      workspace: h(WorkspacePicker, {
        disabled: locked,
        gitContext,
        inputId: `${id}-cwd`,
        onChange: (next) => changeField("cwd", next),
        suggestions: workspaceSuggestions,
        value: cwd,
      }),
    }),
    h(PromptCard, {
      // `hidden` is the host's to set: React owning it re-hid pasted attachments
      // on the next keystroke.
      accessory: initialPromptAttachmentsId
        ? h("div", {
            "aria-live": "polite",
            className: "composer-attachments start-session-attachments",
            id: initialPromptAttachmentsId,
          })
        : null,
      attachControl,
      hint: claudeTerminal
        ? t("Claude terminal requires Full access (YOLO). Shell commands run directly.")
        : requiresInitialPrompt
        ? t("Claude Code starts when you send the first prompt")
        : t("Leave empty to start idle"),
      id: `${id}-start-prompt`,
      key: "prompt",
      onChange: (next) => changeField("initialPrompt", next),
      onSubmit: submit,
      placeholder: initialPromptAttachmentsId
        ? t("What should it work on? Paste an image to attach it.")
        : t("What should it work on?"),
      readOnly: locked,
      value: fields.initialPrompt ?? "",
    }),
    h(
      SettingPillRow,
      { key: "pills" },
      h(ModelPicker, {
        ...launchModelPickerProps({
          offerProviderDefault: true,
          nativeTerminalProviders,
          presentation: fields.presentation,
          providerModels,
          providers,
          selectedModel: fields.model || "",
          selectedProvider: provider,
        }),
        id: `${id}-model`,
        key: "model",
        onOpen: onOpenModelPicker,
        disabled: locked,
        onSelect: (value, option) => {
          if (locked || inFlightRef.current) {
            return;
          }
          setStartError("");
          onSelectModel?.({ model: value, provider: option.provider || provider, presentation: option.presentation });
        },
      }),
      h(SettingPill, {
        disabled: locked,
        id: `${id}-effort`,
        key: "effort",
        label: t("Effort"),
        onSelect: (value) => changeField("effort", value),
        options: effortOptions.map((option) => ({
          ...option,
          selected: option.value === fields.effort,
        })),
        value: selectedEffort?.label || fields.effort || t("default"),
      }),
      h(SettingPill, {
        disabled: locked,
        id: `${id}-approval`,
        key: "approval",
        label: t("Permissions"),
        onSelect: (value) => changeField("approvalPolicy", value),
        options: approvalOptions.map((option) => ({
          ...option,
          selected: option.value === fields.approvalPolicy,
        })),
        tag: selectedApproval?.tag || null,
        value: selectedApproval?.label || fields.approvalPolicy || t("default"),
      })
    ),
    modelsStatus === "loading" || modelsStatus === "error"
      ? h(
          "p",
          {
            className: "session-dialog-note",
            "data-models-status": modelsStatus,
            id: `${id}-models-hint`,
            key: "models-hint",
          },
          modelsStatus === "loading"
            ? t("Loading models…")
            : t("Couldn’t load the model list — switch provider or reconnect to retry.")
        )
      : null
  );
}
