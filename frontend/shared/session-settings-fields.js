import React from "react";
import { sandboxOptions } from "./provider-settings.js";

const h = React.createElement;

export function SessionSettingsFields({
  fields = {},
  idPrefix = "remote",
  labels = {},
  model = {},
  onFieldChange = null,
}) {
  const {
    approvalOptions = [],
    effortOptions = [],
    models = [],
    providerOptions = [],
  } = model;

  return h(
    "div",
    { className: "settings-grid" },
    h(SelectField, {
      id: `${idPrefix}-provider-input`,
      label: "Provider",
      onChange: (value) => onFieldChange?.("provider", value),
      options: providerOptions,
      value: fields.provider,
    }),
    h(SelectField, {
      id: `${idPrefix}-model-input`,
      label: labels.model || "Model",
      onChange: (value) => onFieldChange?.("model", value),
      options: models.map((option) => ({
        label: option.display_name || option.model,
        value: option.model,
      })),
      value: fields.model,
    }),
    h(SelectField, {
      id: `${idPrefix}-approval-policy-input`,
      label: labels.approval || "Permission mode",
      onChange: (value) => onFieldChange?.("approvalPolicy", value),
      options: approvalOptions,
      value: fields.approvalPolicy,
    }),
    h(SelectField, {
      id: `${idPrefix}-sandbox-input`,
      label: labels.sandbox || "File access",
      onChange: (value) => onFieldChange?.("sandbox", value),
      options: sandboxOptions(),
      value: fields.sandbox,
    }),
    h(SelectField, {
      id: `${idPrefix}-start-effort`,
      label: labels.effort || "Effort",
      onChange: (value) => onFieldChange?.("effort", value),
      options: effortOptions,
      value: fields.effort,
    }),
    h(
      "label",
      { className: "field field-full" },
      h("span", null, "Initial Prompt"),
      h("textarea", {
        id: `${idPrefix}-start-prompt`,
        onChange: (event) => onFieldChange?.("initialPrompt", event.target.value),
        placeholder: "Optional first task.",
        rows: 4,
        value: fields.initialPrompt || "",
      })
    )
  );
}

function SelectField({ id, label, onChange, options = [], value }) {
  return h(
    "label",
    { className: "field" },
    h("span", null, label),
    h(
      "select",
      {
        id,
        onChange: (event) => onChange(event.target.value),
        value,
      },
      ...options.map((option) =>
        h("option", { key: option.value, value: option.value }, option.label)
      )
    )
  );
}
