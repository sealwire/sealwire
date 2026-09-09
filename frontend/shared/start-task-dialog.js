// The "New task" form.
//
// Five prose fields, and the shape of them is the product: a task is a written
// brief a team is measured against, not a prompt. `agreed_scope` and
// `quality_rules` are the merge-request gate's yardstick and are IMMUTABLE once
// the run starts — the team must not be able to edit what it is judged by — so
// this form is the only chance to set them.

import React from "react";
import { BUILTIN_TEAM_ID, listLibraryTeams } from "./teams-library-model.js";

const h = React.createElement;

// Mirrors `StartTeamInput`, which is deliberately FLAT: a client filling this in
// is filling in a form, not assembling a domain object.
export const TASK_FIELDS = Object.freeze([
  {
    key: "title",
    label: "Task",
    required: true,
    rows: 1,
    placeholder: "Add a streaming parser to the loader",
    hint: "One line. It names the branch, so keep it short.",
  },
  {
    key: "context",
    label: "Context",
    rows: 4,
    placeholder: "Where this lives, what already exists, anything the team cannot discover by reading the code.",
    hint: "The team lead gets this and nothing else to start with.",
  },
  {
    key: "acceptance_criteria",
    label: "Done means",
    rows: 3,
    placeholder: "Parses all three encodings. Existing loader tests still pass.",
    hint: "How you will know it worked.",
  },
  {
    key: "agreed_scope",
    label: "Scope",
    rows: 3,
    placeholder: "The parser only. Do not touch the loader's public API.",
    hint: "Immutable once the task starts — the review gate measures against this.",
  },
  {
    key: "quality_rules",
    label: "Rules",
    rows: 3,
    placeholder: "No unwrap in library code. Every new branch gets a test.",
    hint: "Also immutable, and also part of what the reviewer checks.",
  },
]);

export function startTaskDisabled(fields, pending) {
  return Boolean(pending) || !String(fields?.title || "").trim();
}

function Field({ field, value, onChange, idPrefix }) {
  const id = `${idPrefix}-${field.key}`;
  return h(
    "div",
    { className: "start-task-field" },
    h(
      "label",
      { className: "sidebar-label", htmlFor: id },
      field.label,
      field.required ? h("span", { className: "start-task-required" }, "required") : null
    ),
    h("textarea", {
      id,
      rows: field.rows,
      value: value || "",
      placeholder: field.placeholder,
      onChange: (event) => onChange?.(field.key, event.target.value),
    }),
    field.hint ? h("p", { className: "start-task-hint" }, field.hint) : null
  );
}

function TeamSelector({ teams, value, onChange, idPrefix }) {
  const selected = value || BUILTIN_TEAM_ID;
  return h(
    "fieldset",
    { className: "start-task-field start-task-team-field" },
    h("legend", { className: "sidebar-label" }, "Team"),
    h(
      "div",
      { className: "start-task-team-options" },
      ...(teams || listLibraryTeams()).map((team) => {
        const optionId = `${idPrefix}-team-${team.id}`;
        return h(
          "label",
          {
            key: team.id,
            className: [
              "start-task-team-option",
              selected === team.id ? "is-selected" : "",
            ].filter(Boolean).join(" "),
            htmlFor: optionId,
          },
          h("input", {
            id: optionId,
            type: "radio",
            name: `${idPrefix}-team`,
            value: team.id,
            checked: selected === team.id,
            onChange: (event) => onChange?.("team_id", event.target.value),
          }),
          h(
            "span",
            { className: "start-task-team-copy" },
            h("span", { className: "start-task-team-name" }, team.name),
            h(
              "span",
              { className: "start-task-team-meta" },
              `${team.roleCount ?? team.roles?.length ?? 0} roles`
            )
          )
        );
      })
    )
  );
}

export function StartTaskDialog({
  id = "start-task-dialog",
  fields = {},
  onFieldChange,
  onStart,
  onRequestClose,
  pending = false,
  error = null,
  workspaceSuggestions = [],
  defaultCwd = "",
  teams = listLibraryTeams(),
}) {
  const closeDialog = () => {
    onRequestClose?.();
    if (typeof document !== "undefined") {
      document.getElementById(id)?.close();
    }
  };

  return h(
    "dialog",
    {
      className: "panel-modal panel-modal-wide start-task-dialog",
      id,
      onClose: () => onRequestClose?.(),
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      },
    },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, "New task"),
      h(
        "button",
        { className: "header-button close-modal-btn", onClick: closeDialog, type: "button" },
        "×"
      )
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h(
        "p",
        { className: "start-task-intro" },
        "Pick a team structure for this task. The task still runs in a fresh git worktree on its own branch, so nothing touches your working tree."
      ),
      h(TeamSelector, {
        teams,
        value: fields.team_id,
        onChange: onFieldChange,
        idPrefix: id,
      }),
      ...TASK_FIELDS.map((field) =>
        h(Field, {
          key: field.key,
          field,
          value: fields[field.key],
          onChange: onFieldChange,
          idPrefix: id,
        })
      ),
      h(
        "div",
        { className: "start-task-field" },
        h("label", { className: "sidebar-label", htmlFor: `${id}-cwd` }, "Workspace"),
        h("input", {
          id: `${id}-cwd`,
          type: "text",
          autoComplete: "off",
          list: `${id}-suggestions`,
          value: fields.cwd ?? "",
          placeholder: defaultCwd || "/path/to/project",
          onChange: (event) => onFieldChange?.("cwd", event.target.value),
        }),
        h(
          "datalist",
          { id: `${id}-suggestions` },
          ...(workspaceSuggestions || []).map((suggestion) =>
            h("option", {
              key: suggestion.cwd,
              label: suggestion.label,
              value: suggestion.cwd,
            })
          )
        ),
        h(
          "p",
          { className: "start-task-hint" },
          "Any directory in the repository to fork from. Blank uses the relay's current workspace."
        )
      ),
      h(
        "div",
        { className: "start-task-field" },
        h("label", { className: "sidebar-label", htmlFor: `${id}-branch` }, "Fork from"),
        h("input", {
          id: `${id}-branch`,
          type: "text",
          autoComplete: "off",
          value: fields.target_branch ?? "",
          placeholder: "the workspace's current branch",
          onChange: (event) => onFieldChange?.("target_branch", event.target.value),
        }),
        h(
          "p",
          { className: "start-task-hint" },
          "The task's changes are reviewed against this branch's merge base."
        )
      ),
      error ? h("p", { className: "start-task-error" }, String(error)) : null
    ),
    h(
      "div",
      { className: "modal-actions" },
      h(
        "button",
        { className: "header-button", type: "button", onClick: closeDialog },
        "Cancel"
      ),
      h(
        "button",
        {
          className: "start-session-button",
          type: "button",
          disabled: startTaskDisabled(fields, pending),
          // Deliberately NOT closing optimistically the way the session dialog
          // does: provisioning a worktree can fail (dirty tree, branch exists),
          // and the error has to land on the form that produced it.
          onClick: () => onStart?.(),
        },
        pending ? "Starting…" : "Start task"
      )
    )
  );
}
