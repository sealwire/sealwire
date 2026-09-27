// The Settings window both surfaces share: section nav on the left, one page on the right.
// Pages stay mounted and toggle `hidden`, because e2e helpers read ids inside inactive pages.

import React from "react";
import { ThemePicker } from "./theme-picker.js";

const h = React.createElement;

/**
 * @param {{
 *   nav: {key:string,label:string,meta?:string,metaTone?:string}[],
 *   active: string,
 *   onSelect: (key:string) => void,
 *   onClose: () => void,
 *   closeId: string,
 *   tabIdPrefix?: string,
 *   footer?: React.ReactNode,
 *   children?: React.ReactNode,
 * }} props
 */
export function SettingsFrame({ nav, active, onSelect, onClose, closeId, tabIdPrefix = "", footer, children }) {
  return h(
    "div",
    { className: "settings-frame" },
    h(
      "nav",
      { className: "settings-nav", "aria-label": "Settings sections" },
      h("h2", { className: "settings-nav-title" }, "Settings"),
      h(
        "div",
        { className: "settings-nav-items", role: "tablist", "aria-orientation": "vertical" },
        ...nav.map((item) =>
          h(
            "button",
            {
              key: item.key,
              className: `settings-nav-item${item.key === active ? " is-active" : ""}`,
              id: `${tabIdPrefix}settings-tab-${item.key}`,
              type: "button",
              role: "tab",
              "aria-selected": item.key === active ? "true" : "false",
              "data-settings-tab": item.key,
              onClick: () => onSelect(item.key),
            },
            h("span", { className: "settings-nav-label" }, item.label),
            item.meta
              ? h(
                  "span",
                  {
                    className: `settings-nav-meta${item.metaTone ? ` is-${item.metaTone}` : ""}`,
                  },
                  item.meta
                )
              : null
          )
        )
      ),
      footer ? h("div", { className: "settings-nav-footer" }, footer) : null
    ),
    h(
      "div",
      { className: "settings-main" },
      h(
        "button",
        {
          "aria-label": "Close settings",
          className: "header-button close-modal-btn settings-close",
          id: closeId,
          onClick: onClose,
          type: "button",
        },
        "×"
      ),
      children
    )
  );
}

/**
 * @param {{
 *   pageKey: string,
 *   active: boolean,
 *   title: string,
 *   parent?: {label:string,onBack:() => void},
 *   actions?: React.ReactNode,
 *   children?: React.ReactNode,
 * }} props
 */
export function SettingsPage({ pageKey, active, title, parent, actions, children }) {
  return h(
    "section",
    {
      className: "settings-panel",
      "data-settings-panel": pageKey,
      hidden: !active,
      role: "tabpanel",
    },
    h(
      "header",
      { className: "settings-page-header" },
      h(
        "h3",
        { className: "settings-page-title" },
        parent
          ? h(
              React.Fragment,
              null,
              h(
                "button",
                { className: "settings-crumb", onClick: parent.onBack, type: "button" },
                parent.label
              ),
              h("span", { className: "settings-crumb-sep", "aria-hidden": "true" }, "/")
            )
          : null,
        h("span", null, title)
      ),
      actions ? h("div", { className: "settings-page-actions" }, actions) : null
    ),
    h("div", { className: "settings-page-body" }, children)
  );
}

export function SettingsSection({ title, meta, children, className = "" }) {
  return h(
    "div",
    { className: `settings-section${className ? ` ${className}` : ""}` },
    title
      ? h(
          "p",
          { className: "settings-section-title" },
          title,
          meta ? h("span", { className: "settings-section-meta" }, ` · ${meta}`) : null
        )
      : null,
    children
  );
}

export function SettingsHint({ children, id }) {
  return h("p", { className: "settings-hint", id }, children);
}

// Theme is one control, so it lives at the foot of the nav instead of owning a page.
// `loadBuildInfo` is injected: build-badge.js reads `import.meta.env` at load, which node tests lack.
export function SettingsFooter({ loadBuildInfo, onOpenLog, logActive = false, logButtonId }) {
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "settings-theme-row" },
      h("span", { className: "settings-theme-label" }, "Theme"),
      h(ThemePicker)
    ),
    h(
      "div",
      { className: "settings-build-row" },
      h(BuildLabel, { loadBuildInfo }),
      onOpenLog
        ? h(
            "button",
            {
              className: `settings-log-link${logActive ? " is-active" : ""}`,
              id: logButtonId,
              onClick: onOpenLog,
              type: "button",
            },
            "Log"
          )
        : null
    )
  );
}

function BuildLabel({ loadBuildInfo }) {
  const [info, setInfo] = React.useState(null);
  React.useEffect(() => {
    let live = true;
    Promise.resolve(loadBuildInfo?.()).then((next) => {
      if (live && next) {
        setInfo(next);
      }
    });
    return () => {
      live = false;
    };
  }, [loadBuildInfo]);
  return h(
    "span",
    { className: "settings-build-label", title: info?.title || "" },
    info?.label || ""
  );
}
