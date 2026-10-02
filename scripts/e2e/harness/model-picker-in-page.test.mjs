// The in-page helpers run against the real picker in jsdom, with no act(): React then
// commits after a click returns, as it does in a browser, so a helper that reads
// straight after clicking sees the previous panel.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;

const React = (await import("react")).default;
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { ModelPicker } = await import("../../../frontend/shared/model-picker.js");
const { buildModelPickerGroups } = await import("../../../frontend/shared/model-picker-model.js");
const { readModelPickerOptionsInPage, showProviderModelsInPage } = await import(
  "./start-session-dialog.mjs"
);

const PROVIDER_MODELS = {
  claude_code: [{ display_name: "Opus", is_default: true, model: "opus" }],
  codex: [
    { display_name: "GPT-6", is_default: true, model: "gpt-6" },
    { display_name: "GPT-5.6", model: "gpt-5.6" },
    { display_name: "GPT-5.5", model: "gpt-5.5" },
  ],
};

function mountOpen() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      React.createElement(ModelPicker, {
        groups: buildModelPickerGroups({
          providerModels: PROVIDER_MODELS,
          providers: ["codex", "claude_code"],
          selectedModel: "gpt-6",
          selectedProvider: "codex",
        }),
        id: "picker",
        provider: "codex",
        value: "GPT-6",
      })
    )
  );
  flushSync(() => host.querySelector("#picker").click());
  return () => {
    flushSync(() => root.unmount());
    host.remove();
  };
}

test("reading the menu visits every provider, older models included", async () => {
  const cleanup = mountOpen();
  try {
    assert.deepEqual(await readModelPickerOptionsInPage(), [
      { provider: "codex", value: "gpt-6" },
      { provider: "codex", value: "gpt-5.6" },
      { provider: "codex", value: "gpt-5.5" },
      { provider: "claude_code", value: "opus" },
    ]);
  } finally {
    cleanup();
  }
});

test("showing a provider leaves its models, older ones too, on screen to click", async () => {
  const cleanup = mountOpen();
  try {
    await showProviderModelsInPage("claude_code");
    assert.deepEqual(
      [...document.querySelectorAll(".model-picker-layer .model-picker-option")].map(
        (node) => node.dataset.value
      ),
      ["opus"]
    );
  } finally {
    cleanup();
  }
});
