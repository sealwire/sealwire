// The chrome both launch dialogs share. They ask the same question and differ only
// in what they inherit; hand-built separately, they had already drifted.

import React from "react";

const h = React.createElement;

// Order: "where", then "what", then "how". The old dialogs led with Provider —
// the least-changed decision first.
export function SessionDialogShell({
  actions = null,
  // Outside the body: the body scrolls on phones, and this must stay in view.
  alert = null,
  badge = null,
  children,
  footerHint = null,
  id,
  onRequestClose = null,
  title,
}) {
  const dialogRef = React.useRef(null);

  React.useEffect(() => {
    const dialog = dialogRef.current;
    const view = dialog?.ownerDocument.defaultView;
    const viewport = view?.visualViewport;
    if (!viewport) return undefined;

    const update = () => {
      // Pinch zoom changes visible bounds without opening a keyboard.
      if (viewport.scale !== 1) {
        dialog.style.removeProperty("--session-dialog-keyboard-inset");
        dialog.style.removeProperty("--session-dialog-viewport-height");
        return;
      }
      // Some phone browsers resize only the visible viewport when the keyboard opens.
      // Move the sheet too, or its clipping bounds leave picker menus one row of space.
      const inset = Math.max(0, view.innerHeight - viewport.offsetTop - viewport.height);
      dialog.style.setProperty("--session-dialog-keyboard-inset", `${inset}px`);
      dialog.style.setProperty("--session-dialog-viewport-height", `${viewport.height}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    view.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      view.removeEventListener("resize", update);
    };
  }, []);

  const close = () => {
    onRequestClose?.();
    document.getElementById(id)?.close?.();
  };

  return h(
    "dialog",
    {
      className: "panel-modal session-dialog",
      id,
      ref: dialogRef,
      onClose: () => onRequestClose?.(),
      // Only the backdrop matches: every child renders inside the sections below.
      onClick: (event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      },
    },
    h(
      "div",
      { className: "session-dialog-header" },
      h(
        "div",
        { className: "session-dialog-title" },
        h("h2", null, title),
        badge
      ),
      h(
        "button",
        {
          "aria-label": "Close",
          className: "session-dialog-close",
          onClick: close,
          type: "button",
        },
        "×"
      )
    ),
    h("section", { className: "session-dialog-body" }, children),
    alert
      ? h("p", { className: "session-dialog-note is-error session-dialog-alert", role: "alert" }, alert)
      : null,
    h(
      "div",
      { className: "session-dialog-footer" },
      h("p", { className: "session-dialog-hint" }, footerHint),
      h("div", { className: "session-dialog-actions" }, actions)
    )
  );
}

// One row, because keeping them adjacent shows the project is NOT derived from
// the path — projects are deliberately not bound to a cwd.
export function SessionContextBar({ project = null, workspace = null }) {
  return h(
    "div",
    { className: "session-context-bar" },
    project,
    project && workspace
      ? h("span", { "aria-hidden": "true", className: "session-context-sep" }, "/")
      : null,
    workspace
  );
}

// The prompt, as the largest thing in the dialog. It is the only field most
// launches actually fill in, and the old layout buried it under four dropdowns.
export function PromptCard({
  accessory = null,
  attachControl = null,
  hint = null,
  id,
  onChange = null,
  onSubmit = null,
  placeholder = "",
  readOnly = false,
  value,
}) {
  return h(
    "div",
    { className: "session-prompt-card" },
    h("textarea", {
      className: "session-prompt-input",
      id,
      readOnly,
      onChange: (event) => onChange?.(event.target.value),
      // Plain Enter stays a newline: this is a task description, not a message.
      onKeyDown: (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onSubmit?.();
        }
      },
      placeholder,
      rows: 5,
      // Left undefined when the caller does not manage the value, which keeps
      // the textarea uncontrolled for hosts that read it at submit time.
      value: value ?? undefined,
    }),
    accessory,
    h(
      "div",
      { className: "session-prompt-foot" },
      attachControl || h("span"),
      hint ? h("span", { className: "session-prompt-hint" }, hint) : null
    )
  );
}

// Named so both dialogs wrap identically and mobile has one CSS hook.
export function SettingPillRow({ children }) {
  return h("div", { className: "session-setting-pills" }, children);
}

// Its own element so touch can hide it: there is no ⌘ to press there.
export function SubmitShortcutHint() {
  return h("span", { "aria-hidden": "true", className: "session-submit-shortcut" }, "⌘↵");
}
