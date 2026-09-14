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
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConversationComposer } = await import("./composer.js");
const { setNativeValue } = await import("./set-native-value.js");

const h = React.createElement;

function mountControlledComposer(initial) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const seen = { draft: initial, node: null };
  function App() {
    const [draft, setDraft] = useState(initial);
    seen.draft = draft;
    return h(ConversationComposer, {
      currentDraft: draft,
      onDraftChange: setDraft,
      textareaRef: (node) => {
        seen.node = node;
      },
    });
  }
  act(() => root.render(h(App)));
  return seen;
}

test("a programmatic write reaches a CONTROLLED composer's state", () => {
  // Assigning `node.value` runs React's own setter, which updates the tracker the
  // input event is checked against — so the event reads as no change and the next
  // render puts the old text back; the command the user just picked reappears.
  const seen = mountControlledComposer("/goal ship it");

  act(() => {
    setNativeValue(seen.node, "");
    seen.node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  assert.equal(seen.draft, "", "the surface's own state must follow the field");
  assert.equal(seen.node.value, "", "and the field must not be re-filled on re-render");
});

test("the written text is what lands, not just an emptying", () => {
  const seen = mountControlledComposer("/delegate codex look at it");

  act(() => {
    setNativeValue(seen.node, "look at it");
    seen.node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  assert.equal(seen.draft, "look at it");
});

test("a missing node is not an error", () => {
  // The controller can be released between a keystroke and its rewrite.
  assert.doesNotThrow(() => setNativeValue(null, "x"));
});
