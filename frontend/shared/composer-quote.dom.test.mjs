// The quote Ask put on a thread shows above that thread's composer, and ✕ drops it.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ComposerQuoteStrip } = await import("./composer-quote.js");
const { getComposerWorkspaceStore, resetComposerWorkspaceStoreForTest } = await import(
  "./composer-workspace.js"
);

test("the strip shows its own thread's quote, follows the store, and ✕ clears it", async () => {
  resetComposerWorkspaceStoreForTest();
  const store = getComposerWorkspaceStore();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(ComposerQuoteStrip, { scope: "local::a" })));
  assert.equal(container.querySelector(".composer-quote"), null, "nothing quoted yet");

  await act(async () => {
    store.write("local::b", { quote: "another thread's" });
    store.write("local::a", { quote: "the grace window" });
  });
  assert.equal(container.querySelector(".composer-quote-text").textContent, "the grace window");

  await act(async () => {
    container.querySelector(".composer-quote-remove").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(container.querySelector(".composer-quote"), null);
  assert.equal(store.read("local::a").quote, "");
  assert.equal(store.read("local::b").quote, "another thread's");
  await act(async () => root.unmount());
});
