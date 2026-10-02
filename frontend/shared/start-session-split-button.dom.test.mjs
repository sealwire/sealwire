import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { StartSessionSplitButton } = await import("./start-session-split-button.js");

const h = React.createElement;

function openMenu(providerOptions) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      h(StartSessionSplitButton, {
        activeProvider: "codex",
        onStart: () => {},
        onStartWithProvider: () => {},
        providerOptions,
      })
    )
  );
  act(() => {
    host
      .querySelector(".start-session-split-toggle")
      .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  const options = [...host.querySelectorAll(".start-session-split-option")];
  return {
    options,
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("each agent in the menu carries its own logo next to its name", () => {
  const { options, cleanup } = openMenu([
    { label: "Codex", value: "codex" },
    { label: "Claude", value: "claude_code" },
    { label: "Cursor", value: "cursor" },
  ]);
  try {
    assert.equal(options.length, 3);
    for (const [option, provider, label] of [
      [options[0], "codex", "Codex"],
      [options[1], "claude_code", "Claude"],
      [options[2], "cursor", "Cursor"],
    ]) {
      const mark = option.querySelector(".start-session-split-mark");
      assert.ok(mark, `${provider}: no logo slot`);
      assert.equal(mark.dataset.provider, provider);
      assert.ok(mark.querySelector("svg"), `${provider}: logo slot is empty`);
      assert.equal(option.textContent, label, "the logo must not add text to the row");
    }
  } finally {
    cleanup();
  }
});

test("an agent with no shipped logo keeps an empty slot so names stay aligned", () => {
  const { options, cleanup } = openMenu([
    { label: "Codex", value: "codex" },
    { label: "Fake", value: "fake" },
  ]);
  try {
    const mark = options[1].querySelector(".start-session-split-mark");
    assert.ok(mark, "the slot must stay in the row even without a logo");
    assert.equal(mark.dataset.provider, undefined, "must not borrow another vendor's logo");
    assert.equal(mark.innerHTML, "");
  } finally {
    cleanup();
  }
});
