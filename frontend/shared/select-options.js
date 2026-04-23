import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const h = React.createElement;
const rootsBySelect = new WeakMap();

export function renderSelectOptions(select, options = [], selectedValue = "") {
  if (!select) {
    return;
  }

  let root = rootsBySelect.get(select);
  if (!root) {
    root = createRoot(select);
    rootsBySelect.set(select, root);
  }

  flushSync(() => {
    root.render(
      h(
        React.Fragment,
        null,
        ...options.map((option) =>
          h(
            "option",
            {
              key: option.value,
              value: option.value,
            },
            option.label
          )
        )
      )
    );
  });

  select.value = selectedValue;
}
