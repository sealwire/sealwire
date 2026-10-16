// Small pieces both the Editor screen and its History view draw with.

import React from "react";

const h = React.createElement;
const { useCallback, useSyncExternalStore } = React;

export function useStore(store, select = (state) => state) {
  return useSyncExternalStore(
    useCallback((listener) => store.subscribe(listener), [store]),
    () => select(store.getState()),
    () => select(store.getState())
  );
}

export function svg(markup, className) {
  return h("span", { className, "aria-hidden": "true", dangerouslySetInnerHTML: { __html: markup } });
}

export function baseName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "";
}

export function dirName(path) {
  const index = String(path || "").lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}
