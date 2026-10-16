import React from "react";

import { SettingsHint, SettingsPage } from "../../shared/settings-frame.js";
import { t } from "../../shared/i18n.js";
import { loadEditorAutosave, saveEditorAutosave } from "./editor-prefs.js";

const h = React.createElement;

export function EditorSettingsPage({ active }) {
  const [autosave, setAutosave] = React.useState(() => loadEditorAutosave());
  const toggle = () => {
    const next = !autosave;
    setAutosave(next);
    saveEditorAutosave(next);
  };
  return h(
    SettingsPage,
    { pageKey: "editor", active, title: t("Editor") },
    h(
      "ul",
      { className: "settings-list" },
      h(
        "li",
        { className: "settings-row" },
        h(
          "span",
          { className: "settings-row-copy" },
          h("span", { className: "settings-row-title" }, t("Save automatically")),
          h(
            "span",
            { className: "settings-row-sub" },
            autosave
              ? t("Saves about a second after you stop typing, and when you switch tabs or leave the editor.")
              : t("Files are saved only when you press ⌘S.")
          )
        ),
        h(
          "button",
          {
            className: "editor-switch is-settings",
            type: "button",
            role: "switch",
            "aria-checked": autosave,
            "aria-label": t("Save automatically"),
            onClick: toggle,
          },
          h("span", { className: "editor-switch-track", "aria-hidden": "true" })
        )
      )
    ),
    h(
      SettingsHint,
      null,
      t("Either way, a save never replaces a change an agent made to the file after you opened it.")
    )
  );
}
