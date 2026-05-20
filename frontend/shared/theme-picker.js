import React from "react";

import { getStoredTheme, setStoredTheme } from "./theme.js";

const h = React.createElement;
const OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemePicker({ onChange } = {}) {
  const [value, setValue] = React.useState(getStoredTheme);

  const handle = (next) => {
    if (next === value) return;
    setStoredTheme(next);
    setValue(next);
    onChange?.(next);
  };

  return h(
    "div",
    {
      className: "theme-picker",
      role: "radiogroup",
      "aria-label": "Color theme",
    },
    ...OPTIONS.map((opt) =>
      h(
        "button",
        {
          key: opt.value,
          type: "button",
          role: "radio",
          "aria-checked": value === opt.value,
          className:
            "theme-picker-segment" + (value === opt.value ? " is-active" : ""),
          onClick: () => handle(opt.value),
        },
        opt.label
      )
    )
  );
}

export function ThemePickerRow() {
  return h(
    "div",
    { className: "overflow-menu-row" },
    h("span", { className: "overflow-menu-row-label" }, "Theme"),
    h(ThemePicker)
  );
}
