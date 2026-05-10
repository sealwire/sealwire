import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const h = React.createElement;
const rootsBySelect = new WeakMap();
const renderStateBySelect = new WeakMap();

export function renderSelectOptions(select, options = [], selectedValue = "") {
  if (!select) {
    return;
  }

  const nextState = {
    optionsKey: JSON.stringify(
      options.map((option) => ({
        label: option.label,
        value: option.value,
      }))
    ),
    selectedValue,
  };
  const previousState = renderStateBySelect.get(select);
  if (
    previousState?.optionsKey === nextState.optionsKey
    && previousState?.selectedValue === nextState.selectedValue
  ) {
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
  renderStateBySelect.set(select, nextState);
}
