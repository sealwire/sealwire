// Selecting part of a reply offers Ask and Copy right beside the selection, and that
// reply's whole-message toolbar stands down while the selection lasts.
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
const { SELECTION_COPY_WIDTH, SELECTION_TOOLBAR_WIDTH, TranscriptContent } = await import("./shared/transcript-react.js");

const h = React.createElement;
const ENTRIES = [
  { item_id: "u1", kind: "user_text", status: "completed", text: "a question from me" },
  { item_id: "a1", kind: "agent_text", status: "completed", text: "alpha beta gamma" },
  { item_id: "a2", kind: "agent_text", status: "completed", text: "delta epsilon" },
];

async function mount(options = { canAsk: true }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries: ENTRIES, options })));
  return { container, root };
}

function textNodeIn(container, id) {
  const walker = document.createTreeWalker(
    container.querySelector(`[data-transcript-entry-id="${id}"] .message-body, [data-transcript-entry-id="${id}"]`),
    dom.window.NodeFilter.SHOW_TEXT
  );
  return walker.nextNode();
}

async function select(startNode, startOffset, endNode, endOffset, pointerType = "mouse") {
  await act(async () => {
    const down = new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 });
    Object.defineProperty(down, "pointerType", { value: pointerType });
    startNode.parentElement.dispatchEvent(down);
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    selection.addRange(range);
    document.dispatchEvent(new dom.window.Event("selectionchange"));
    const up = new dom.window.MouseEvent("pointerup", { bubbles: true, button: 0 });
    Object.defineProperty(up, "pointerType", { value: pointerType });
    startNode.parentElement.dispatchEvent(up);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function clearSelection() {
  await act(async () => {
    window.getSelection().removeAllRanges();
    document.dispatchEvent(new dom.window.Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

test("a selection inside a reply offers Ask and Copy for exactly that text, and marks the reply", async () => {
  const { container, root } = await mount();
  const text = textNodeIn(container, "a1");
  await select(text, 6, text, 10);

  const button = container.querySelector(".selection-toolbar [data-ask-message]");
  assert.ok(button, "Ask appears beside the selection");
  assert.equal(button.getAttribute("data-ask-message"), "beta");
  assert.equal(
    container.querySelector(".selection-toolbar [data-copy-message]")?.getAttribute("data-copy-message"),
    "beta",
    "Copy takes the selection, not the whole reply"
  );
  assert.equal(
    container.querySelector('[data-transcript-entry-id="a1"]').getAttribute("data-selecting"),
    "true",
    "the reply knows it is being selected, so its toolbar stands down"
  );

  await clearSelection();
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), false);
  assert.equal(container.querySelector('[data-transcript-entry-id="a1"]').hasAttribute("data-selecting"), false);
  await act(async () => root.unmount());
});

test("no toolbar for a selection in your own message or across two replies", async () => {
  const own = await mount();
  const mine = textNodeIn(own.container, "u1");
  await select(mine, 0, mine, 5);
  assert.equal(Boolean(own.container.querySelector(".selection-toolbar")), false, "own message");

  const first = textNodeIn(own.container, "a1");
  const second = textNodeIn(own.container, "a2");
  await select(first, 6, second, 5);
  assert.equal(Boolean(own.container.querySelector(".selection-toolbar")), false, "across two replies");
  await clearSelection();
  await act(async () => own.root.unmount());

});

// A thread you can only read still lets you copy what you selected.
test("where Ask is off, the toolbar offers Copy alone", async () => {
  const { container, root } = await mount({});
  const reply = textNodeIn(container, "a1");
  await select(reply, 6, reply, 10);
  assert.equal(
    container.querySelector(".selection-toolbar [data-copy-message]")?.getAttribute("data-copy-message"),
    "beta"
  );
  assert.equal(Boolean(container.querySelector(".selection-toolbar [data-ask-message]")), false);
  await clearSelection();
  await act(async () => root.unmount());
});

// On a phone the system's own selection menu owns this gesture.
test("a selection made by touch leaves the reply alone", async () => {
  const { container, root } = await mount();
  const text = textNodeIn(container, "a1");
  await select(text, 6, text, 10, "touch");
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), false);
  assert.equal(container.querySelector('[data-transcript-entry-id="a1"]').hasAttribute("data-selecting"), false);
  await clearSelection();
  await act(async () => root.unmount());
});

// A virtualized list can unmount the selected reply; the browser drops the selection
// without a selectionchange, so a scroll has to notice.
test("Ask leaves when the selection vanishes quietly, as a scroll-unmount does", async () => {
  const { container, root } = await mount();
  const text = textNodeIn(container, "a1");
  await select(text, 6, text, 10);
  assert.ok(container.querySelector(".selection-toolbar"));

  const hush = (event) => event.stopImmediatePropagation();
  window.addEventListener("selectionchange", hush, true);
  await act(async () => {
    window.getSelection().removeAllRanges();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.ok(container.querySelector(".selection-toolbar"), "nothing announced the change yet");
  await act(async () => {
    document.dispatchEvent(new dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  window.removeEventListener("selectionchange", hush, true);
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), false, "the toolbar is gone");
  assert.equal(container.querySelector('[data-transcript-entry-id="a1"]').hasAttribute("data-selecting"), false);
  await act(async () => root.unmount());
});

// Once used, it is done: the selection goes and nothing brings the button back.
test("Ask is used once: the selection clears and the button stays gone", async () => {
  const { container, root } = await mount();
  const text = textNodeIn(container, "a1");
  await select(text, 6, text, 10);
  const button = container.querySelector(".selection-toolbar [data-ask-message]");
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      button.dispatchEvent(event);
    }
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(window.getSelection().toString(), "");
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), false, "the toolbar is gone");
  await act(async () => root.unmount());
});

// Copying is not the end of the selection: the check mark shows on a toolbar that stays.
test("Copy leaves the selection and the toolbar where they are", async () => {
  const { container, root } = await mount();
  const text = textNodeIn(container, "a1");
  await select(text, 6, text, 10);
  const button = container.querySelector(".selection-toolbar [data-copy-message]");
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new dom.window.MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      button.dispatchEvent(event);
    }
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(window.getSelection().toString(), "beta");
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), true, "the toolbar stays");
  await clearSelection();
  await act(async () => root.unmount());
});

// Another device can switch the thread under a selection; nothing scrolls, the list just changes.
test("the toolbar leaves when the list changes under a selection that is gone", async () => {
  const { container, root } = await mount();
  const text = textNodeIn(container, "a1");
  await select(text, 6, text, 10);
  const hush = (event) => event.stopImmediatePropagation();
  window.addEventListener("selectionchange", hush, true);
  const other = [
    { item_id: "u9", kind: "user_text", status: "completed", text: "another thread" },
    { item_id: "a9", kind: "agent_text", status: "completed", text: "its answer" },
  ];
  await act(async () => {
    window.getSelection().removeAllRanges();
    root.render(h(TranscriptContent, { entries: other, options: { canAsk: true } }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  window.removeEventListener("selectionchange", hush, true);
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), false, "the toolbar is gone");
  await act(async () => root.unmount());
});

// Esc puts the toolbar away for this selection; only a new one brings it back.
test("after Esc, a scroll does not bring the toolbar back, a new selection does", async () => {
  const { container, root } = await mount();
  const text = textNodeIn(container, "a1");
  await select(text, 6, text, 10);
  await act(async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), false, "Esc put it away");
  await act(async () => {
    document.dispatchEvent(new dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(Boolean(container.querySelector(".selection-toolbar")), false, "a scroll leaves it away");

  await select(text, 0, text, 5);
  assert.equal(
    container.querySelector(".selection-toolbar [data-ask-message]")?.getAttribute("data-ask-message"),
    "alpha"
  );
  await clearSelection();
  await act(async () => root.unmount());
});

// Near the right edge the toolbar gives way by its own width, which is narrower without Ask.
test("a Copy-only toolbar keeps to the selection's end near the right edge", async () => {
  const { container, root } = await mount({});
  container.querySelector(".thread-content").getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  const rects = dom.window.Range.prototype.getClientRects;
  dom.window.Range.prototype.getClientRects = () => [{ right: 480, bottom: 20 }];
  try {
    const text = textNodeIn(container, "a1");
    await select(text, 6, text, 10);
    const left = parseFloat(container.querySelector(".selection-toolbar").style.left);
    assert.equal(left, 500 - SELECTION_COPY_WIDTH);
  } finally {
    dom.window.Range.prototype.getClientRects = rects;
    await clearSelection();
    await act(async () => root.unmount());
  }
});

// A thread can become askable under a standing selection; the wider toolbar must re-place.
test("when Ask becomes available, the toolbar re-places for its new width", async () => {
  const { container, root } = await mount({});
  container.querySelector(".thread-content").getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300 });
  const rects = dom.window.Range.prototype.getClientRects;
  dom.window.Range.prototype.getClientRects = () => [{ right: 480, bottom: 20 }];
  try {
    const text = textNodeIn(container, "a1");
    await select(text, 6, text, 10);
    await act(async () => root.render(h(TranscriptContent, { entries: ENTRIES, options: { canAsk: true } })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    const toolbar = container.querySelector(".selection-toolbar");
    assert.equal(Boolean(toolbar.querySelector("[data-ask-message]")), true);
    assert.equal(parseFloat(toolbar.style.left), 500 - SELECTION_TOOLBAR_WIDTH);
  } finally {
    dom.window.Range.prototype.getClientRects = rects;
    await clearSelection();
    await act(async () => root.unmount());
  }
});
