import React from "react";

import { getStoredTheme, setStoredTheme, THEME_CHANGED_EVENT } from "./theme.js";

const h = React.createElement;
const OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemePicker({ onChange } = {}) {
  const [value, setValue] = React.useState(getStoredTheme);

  // The desktop app's menu bar can change the theme while this picker is mounted.
  React.useEffect(() => {
    const sync = () => setValue(getStoredTheme());
    window.addEventListener(THEME_CHANGED_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, sync);
  }, []);

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
