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

export function replaceSelectOptions(select, options = [], selectedValue = "") {
  if (!select) {
    return;
  }

  const current = [...select.options];
  const sameOptions =
    current.length === options.length
    && current.every(
      (option, index) =>
        option.value === options[index]?.value
        && option.textContent === options[index]?.label
    );
  if (!sameOptions) {
    const nodes = options.map((option) => {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      return node;
    });
    select.replaceChildren(...nodes);
  }
  if (select.value !== selectedValue) {
    select.value = selectedValue;
  }
}
