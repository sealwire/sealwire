import React from "react";

import { getLanguageChoice, setLanguageChoice, t } from "./i18n.js";

const h = React.createElement;

// Switching reloads the page, because text rendered outside React keeps the old language.
export function LanguagePicker({ onChange = () => window.location.reload() } = {}) {
  const [value, setValue] = React.useState(getLanguageChoice);
  // Each language is named in itself, so someone who cannot read the current one finds theirs.
  const options = [
    { value: "auto", label: t("Auto") },
    { value: "en", label: "English" },
    { value: "zh-CN", label: "中文" },
  ];

  const handle = (next) => {
    if (next === value) return;
    setLanguageChoice(next);
    setValue(next);
    onChange(next);
  };

  return h(
    "div",
    { className: "theme-picker language-picker", role: "radiogroup", "aria-label": t("Interface language") },
    ...options.map((opt) =>
      h(
        "button",
        {
          key: opt.value,
          type: "button",
          role: "radio",
          "aria-checked": value === opt.value,
          className: "theme-picker-segment" + (value === opt.value ? " is-active" : ""),
          onClick: () => handle(opt.value),
        },
        opt.label
      )
    )
  );
}
