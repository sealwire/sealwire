import React, { useSyncExternalStore } from "react";

import { getComposerWorkspaceStore } from "./composer-workspace.js";

const h = React.createElement;

/// What Ask put above this thread's composer (design 20c-2); it goes out with the next message.
export function ComposerQuoteStrip({ scope }) {
  const store = getComposerWorkspaceStore();
  const quote = useSyncExternalStore(
    store.subscribe,
    () => store.read(scope).quote,
    () => store.read(scope).quote
  );
  if (!quote) {
    return null;
  }
  return h(
    "div",
    { className: "composer-quote" },
    h("span", { className: "composer-quote-bar", "aria-hidden": "true" }),
    h("span", { className: "composer-quote-text", title: quote }, quote),
    h(
      "button",
      {
        type: "button",
        className: "composer-quote-remove",
        "aria-label": "Remove quote",
        onClick: () => store.write(scope, { quote: "" }),
      },
      "✕"
    )
  );
}
