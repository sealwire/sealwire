import React from "react";

import { t } from "./i18n.js";
import { getStoredTheme, setStoredTheme, THEME_CHANGED_EVENT } from "./theme.js";

const h = React.createElement;
export function ThemePicker({ onChange } = {}) {
  const [value, setValue] = React.useState(getStoredTheme);
  const options = [
    { value: "auto", label: t("Auto") },
    { value: "light", label: t("Light") },
    { value: "dark", label: t("Dark") },
  ];

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
      "aria-label": t("Color theme"),
    },
    ...options.map((opt) =>
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
