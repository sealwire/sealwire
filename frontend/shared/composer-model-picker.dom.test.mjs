import test from "node:test";
import assert from "node:assert/strict";
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
const { ConversationComposer } = await import("./composer.js");

// Shaped like a remote session's catalogue: every row names the relay provider.
const MODELS = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"].map((model) => ({
  display_name: model.toUpperCase(),
  model,
  provider: "codex",
}));

test("the composer's model menu searches one provider's models and reports the pick", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const picks = [];
  act(() => {
    root.render(
      React.createElement(ConversationComposer, {
        currentModelValue: "gpt-6-sol",
        messageId: "remote-message-input",
        modelId: "remote-message-model",
        models: MODELS,
        onModelChange: (value) => picks.push(value),
        sendButtonId: "remote-send-button",
      })
    );
  });
  const trigger = host.querySelector("#remote-message-model");
  act(() => trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

  const menu = host.querySelector(".model-picker-menu");
  assert.ok(menu.querySelector("input"), "a search box");
  assert.equal(host.querySelectorAll(".model-picker-provider").length, 0, "no provider to choose");
  assert.deepEqual(
    [...menu.querySelectorAll(".model-picker-heading")].map((node) => node.textContent),
    ["gpt-6.1", "gpt-6", "gpt-5.6"]
  );
  const luna = [...menu.querySelectorAll(".model-picker-option")].find((row) => row.dataset.value === "gpt-6-luna");
  act(() => luna.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(picks, ["gpt-6-luna"]);
  act(() => root.unmount());
  host.remove();
});
