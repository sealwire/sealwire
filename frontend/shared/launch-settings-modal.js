import React from "react";
import { SessionSettingsFields } from "./session-settings-fields.js";

const h = React.createElement;

export function LaunchSettingsModal({ id, model, onFieldChange, title }) {
  if (!model) return null;

  return h(
    "dialog",
    { className: "panel-modal", id },
    h(
      "div",
      { className: "modal-header" },
      h("h2", null, title || "Launch settings"),
      h("button", {
        className: "header-button close-modal-btn",
        onClick: () => document.getElementById(id)?.close(),
        type: "button",
      }, "×")
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h(
        "p",
        { className: "panel-modal-copy" },
        "Most people can leave these alone. Change them only if you need a different startup behavior."
      ),
      h(SessionSettingsFields, {
        fields: model.fields,
        idPrefix: id.replace("modal", ""),
        labels: model.labels || {},
        model: {
          approvalOptions: model.approvalOptions || [],
          effortOptions: model.effortOptions || [],
          models: model.models || [],
          providerOptions: model.providerOptions || [],
        },
        onFieldChange,
      })
    )
  );
}
