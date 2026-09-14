// The "/" host on the phone, rendered for real.
//
// Two things only a DOM can answer: that the host lands INSIDE the composer box
// (a banner above it reads as a separate thing, not as part of the field), and
// that the controller is handed the live textarea — the phone remounts this panel
// on a session switch, and a controller holding the old node goes silently dead.
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
const { ConversationComposer } = await import("../shared/composer.js");
const { attachComposerCommands } = await import("./composer-command-host.js");

const h = React.createElement;

function Harness({ onInput }) {
  const [input, setInput] = useState(null);
  onInput(input);
  return h(ConversationComposer, {
    attachmentArea: h("div", { className: "composer-command-host", id: "host" }),
    currentDraft: "",
    textareaRef: setInput,
  });
}

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let latestInput = null;
  act(() => {
    root.render(h(Harness, { onInput: (node) => { latestInput = node; } }));
  });
  return { container, root, input: () => latestInput };
}

test("the host sits inside the composer box, not above it", () => {
  const { container } = render();

  const host = container.querySelector(".composer-command-host");
  assert.ok(host, "the host renders");
  assert.ok(
    host.closest(".composer-inner"),
    "outside the box its pills read as a banner rather than as part of the field"
  );
  const textarea = container.querySelector("textarea");
  assert.ok(
    host.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    "the host precedes the textarea, so committed pills sit above what is being typed"
  );
});

test("the textarea reaches the caller as a node, not by id", () => {
  const { container, input } = render();

  assert.equal(
    input(),
    container.querySelector("textarea"),
    "an id lookup would find the wrong field once a second surface renders one"
  );
});

test("a remount hands over the new textarea, and the old controller is released", () => {
  const first = render();
  const firstInput = first.input();

  let released = 0;
  const attached = attachComposerCommands({
    input: firstInput,
    mount: first.container.querySelector(".composer-command-host"),
    buildOptions: () => ({}),
    createController: () => ({ submit: () => null, destroy: () => { released += 1; } }),
  });
  act(() => first.root.unmount());
  attached.release();

  const second = render();
  assert.equal(released, 1, "the controller must let go of the field that went away");
  assert.notEqual(
    second.input(),
    firstInput,
    "React builds a new textarea, which is why the node — not the id — is the dependency"
  );
  assert.ok(second.input(), "the new field is handed over");
});
