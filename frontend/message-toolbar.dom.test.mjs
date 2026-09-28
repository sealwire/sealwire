// Touch has no hover, so a long press is the way to a reply's toolbar.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent } = await import("./shared/transcript-react.js");

const h = React.createElement;

function pointer(type, target, init) {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...init });
  Object.defineProperty(event, "pointerType", { value: init?.pointerType ?? "touch" });
  target.dispatchEvent(event);
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const entries = [
    { item_id: "u1", kind: "user_text", status: "completed", text: "go" },
    { item_id: "a1", kind: "agent_text", status: "completed", text: "Looking first." },
    { item_id: "a2", kind: "agent_text", status: "completed", text: "Done." },
  ];
  await act(async () => root.render(h(TranscriptContent, { entries, options: { canAsk: true } })));
  return { container, root, reply: container.querySelector('[data-transcript-entry-id="a1"]') };
}

test("a long press opens a reply's toolbar and a tap elsewhere closes it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, reply } = await mount();
  await act(async () => pointer("pointerdown", reply.querySelector(".message-body")));
  await act(async () => t.mock.timers.tick(500));
  assert.equal(reply.getAttribute("data-toolbar-open"), "true");

  await act(async () => pointer("pointerdown", document.body));
  assert.equal(reply.hasAttribute("data-toolbar-open"), false);
  await act(async () => root.unmount());
});

test("a press that moves is a scroll, not a long press; a mouse press is neither", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root, reply } = await mount();
  const body = reply.querySelector(".message-body");
  await act(async () => pointer("pointerdown", body));
  await act(async () => pointer("pointermove", body, { clientY: 60 }));
  await act(async () => t.mock.timers.tick(500));
  assert.equal(reply.hasAttribute("data-toolbar-open"), false);

  await act(async () => pointer("pointerdown", body, { pointerType: "mouse" }));
  await act(async () => t.mock.timers.tick(500));
  assert.equal(reply.hasAttribute("data-toolbar-open"), false);
  await act(async () => root.unmount());
});
