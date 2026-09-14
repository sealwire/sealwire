import React from "react";

import { SEND_SVG } from "../svg.js";
import {
  createComposerKeydownHandler,
  defaultEnterSubmits,
  defaultRemapHomeEnd,
} from "./composer-keys.js";
import { providerMarkSlot } from "./provider-mark.js";

const h = React.createElement;

// Build the model picker's option list, guaranteeing the current model stays
// visible even when it isn't in the catalog — an empty/stale catalog, or an id
// the catalog only exposes via an alias (e.g. the "default" entry while the
// session reports the concrete "claude-opus-4-8"). The backend is responsible
// for keeping session.model matchable; this is the UI-side safety net so the
// selection is never unrepresented.
// Build the model-picker option list. Hidden models (Codex marks internal /
// deprecated entries hidden) are always dropped, but the current selection is
// kept representable: with `allowForeign` (the composer) the real current entry
// is re-surfaced even if it's hidden/stale; without it (the launch dialog) a
// value that isn't in THIS provider's catalog is snapped to the provider default
// instead of leaking a foreign id (e.g. gpt-5.5 under Claude). Returns the
// filtered `options` plus the possibly-snapped `value`.
export function buildModelSelectOptions(
  models = [],
  currentModelValue = "",
  { allowForeign = true, fallbackModels = [] } = {}
) {
  // A session snapshot can briefly carry no catalogue while the provider is
  // reconnecting or a viewed-thread refresh is being rebuilt. Both surfaces
  // already hold the same provider's fetched catalogue; use it for that gap so
  // the selected row keeps its real display name instead of flashing the raw
  // wire id ("ChatGPT" -> "chatgpt", "Auto" -> "default[]", Claude's
  // friendly alias -> "default"). A non-empty session catalogue remains
  // authoritative because it also carries the live effort/default metadata.
  const primaryModels = Array.isArray(models) ? models : [];
  const fallbackCatalog = Array.isArray(fallbackModels) ? fallbackModels : [];
  const catalog = primaryModels.length ? primaryModels : fallbackCatalog;
  const options = catalog.filter((model) => !model.hidden);
  let value = currentModelValue;
  if (value && !options.some((model) => model.model === value)) {
    // An empty primary catalogue still means "not authoritative", even when
    // the fallback contains other models. Preserve an unknown viewed-thread
    // selection until its own catalogue arrives; snapping it to the cached
    // provider default would change the model merely by opening the thread.
    if (allowForeign || primaryModels.length === 0 || options.length === 0) {
      const current = catalog.find((model) => model.model === value);
      options.unshift(current || { display_name: value, model: value });
    } else {
      value = options.find((model) => model.is_default)?.model || options[0]?.model || value;
    }
  }
  return { options, value };
}

export function buildModelOptions(models = [], currentModelValue = "") {
  return buildModelSelectOptions(models, currentModelValue, { allowForeign: true }).options;
}

export function ConversationComposer({
  actionsBeforeSend = null,
  attachmentArea = null,
  composerDisabled = false,
  currentDraft,
  currentModelValue,
  enterSubmits,
  errorId = null,
  errorMessage = "",
  messageId = "remote-message-input",
  messagePlaceholder = "",
  modelId = "remote-message-model",
  models = [],
  onDraftChange = null,
  onModelChange = null,
  // Paste belongs to the caller: it owns the files, the limits and the
  // conversion, and answers whether it took the clipboard. Returning nothing
  // lets an ordinary text paste through untouched.
  onPaste = null,
  onStop = null,
  remapHomeEnd,
  rows = 1,
  sendDisabled = false,
  sendButtonId = "remote-send-button",
  sendLabel = "Send",
  sendPending = false,
  textareaRef = null,
  stopButtonId = null,
  stopLabel = "Stop",
  stopPending = false,
  stopVisible = false,
}) {
  const inputDisabled = composerDisabled || sendPending;
  const submitDisabled = inputDisabled || sendDisabled;
  const stopDisabled = composerDisabled || stopPending;
  const textareaProps = {
    disabled: inputDisabled,
    id: messageId,
    placeholder: messagePlaceholder,
    // Handed the node itself, not looked up by id: a surface that unmounts and
    // remounts gets a NEW textarea, and anything holding the old one goes quietly
    // dead rather than erroring.
    ref: textareaRef || undefined,
    rows,
  };
  if (onPaste) {
    textareaProps.onPaste = onPaste;
  }

  // Desktop: Enter sends, Shift+Enter is a newline. Apple platforms: remap
  // Home/End to move the caret to the logical-line start/end (native macOS
  // moves it nowhere useful). Both policies resolve to the environment default
  // unless the surface passes an explicit prop. See composer-keys.js.
  const submitOnEnter = typeof enterSubmits === "boolean" ? enterSubmits : defaultEnterSubmits();
  const remapCaretKeys = typeof remapHomeEnd === "boolean" ? remapHomeEnd : defaultRemapHomeEnd();
  textareaProps.onKeyDown = createComposerKeydownHandler({
    enterSubmits: submitOnEnter,
    remapHomeEnd: remapCaretKeys,
  });
  const modelSelectProps = {
    id: modelId,
    className: "composer-model-chip",
    "aria-label": "Model",
  };
  const modelOptions = buildModelOptions(models, currentModelValue);
  // The vendor behind the *selected* model, which is what the chip's mark shows.
  // Undefined on the local surface, whose catalog arrives after render — it
  // fills the slot by id instead (see syncComposerModelMark in app.js).
  const selectedModelVendor =
    modelOptions.find((model) => model.model === currentModelValue)?.provider || "";

  if (currentDraft !== undefined) {
    textareaProps.value = currentDraft;
  }
  if (onDraftChange) {
    textareaProps.onChange = (event) => onDraftChange(event.target.value);
  }
  if (currentModelValue !== undefined) {
    modelSelectProps.value = currentModelValue;
  }
  if (onModelChange) {
    modelSelectProps.onChange = (event) => onModelChange(event.target.value);
  }

  // Why a send failed belongs HERE, not only in the client log: the log is a
  // collapsible panel, so a relay refusal ("thread not found: …", "that thread
  // is busy with a turn", a path-scope rejection) read as "Send does nothing".
  // Two ways in, because the surfaces drive this component differently: remote
  // re-renders with `errorMessage`, while the local shell renders once and
  // fills the node by id — so with `errorId` the region is always in the DOM,
  // empty and hidden until something goes wrong.
  const errorRegion =
    errorId || errorMessage
      ? h(
          "p",
          {
            className: "composer-error",
            id: errorId || undefined,
            role: "alert",
            hidden: !errorMessage,
          },
          errorMessage || null
        )
      : null;

  return h(
    "div",
    { className: "composer-inner" },
    errorRegion,
    attachmentArea,
    h("textarea", textareaProps),
    h(
      "div",
      { className: "composer-actions" },
      actionsBeforeSend,
      // The chip's leading slot carries the vendor's logo, so the option text
      // no longer prefixes it ("anthropic · Sonnet 4.6" beside an Anthropic
      // mark was both redundant and, under the chip's 18ch cap, the first thing
      // to be ellipsed away). The local surface never showed the prefix, so
      // dropping it also settles a long-standing local/remote disagreement.
      modelOptions.length
        ? h(
            "span",
            { className: "composer-model-picker" },
            providerMarkSlot(selectedModelVendor, {
              className: "composer-model-mark",
              id: `${modelId}-mark`,
            }),
            h(
              "select",
              modelSelectProps,
              ...modelOptions.map((model) =>
                h(
                  "option",
                  {
                    key: model.model,
                    value: model.model,
                    // Read back by the local surface's change handler, which has
                    // no React state to consult when refreshing the mark.
                    "data-provider": model.provider || undefined,
                  },
                  model.display_name || model.model
                )
              )
            )
          )
        : null,
      h(
        "button",
        {
          className: "send-button",
          disabled: submitDisabled,
          hidden: stopVisible,
          id: sendButtonId,
          type: "submit",
        },
        sendPending
          ? "Sending..."
          : [
              h("span", {
                key: "icon",
                className: "send-button-icon",
                "aria-hidden": "true",
                dangerouslySetInnerHTML: { __html: SEND_SVG },
              }),
              h("span", { key: "label", className: "send-button-label" }, sendLabel),
            ]
      ),
      stopButtonId || onStop
        ? h(
            "button",
            {
              className: "stop-button",
              disabled: stopDisabled,
              hidden: !stopVisible,
              id: stopButtonId || undefined,
              onClick: onStop ? () => onStop() : undefined,
              type: "button",
            },
            stopPending ? "Stopping..." : stopLabel
          )
        : null
    )
  );
}
