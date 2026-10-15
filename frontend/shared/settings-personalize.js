import React from "react";

import { t } from "./i18n.js";
import { LanguagePicker } from "./language-picker.js";
import { SettingsPage, SettingsSection } from "./settings-frame.js";
import { ThemePicker } from "./theme-picker.js";

const h = React.createElement;

export function PersonalizePage({ active }) {
  return h(
    SettingsPage,
    { pageKey: "personalize", active, title: t("Personalization") },
    h(SettingsSection, { title: t("Theme") }, h(ThemePicker)),
    h(SettingsSection, { title: t("Language") }, h(LanguagePicker))
  );
}
