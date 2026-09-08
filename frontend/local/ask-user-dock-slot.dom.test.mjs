// Where the live question card is mounted is the whole point of docking it, so
// this asserts the placement rather than the markup: outside the scroller (so
// scrolling and virtualization cannot reach it) and directly above the composer
// (so the thing blocking the turn is next to where you would reply).
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalShell } = await import("./react-shell.js");
const {
  publishLocalAskUserDockContent,
  resetLocalAskUserDockSlotForTest,
} = await import("./ask-user-dock-slot.js");

const h = React.createElement;

test("the docked question mounts outside the transcript scroller, above the composer", async () => {
  resetLocalAskUserDockSlotForTest();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(LocalShell));
  });

  await act(async () => {
    publishLocalAskUserDockContent(
      h("div", { className: "ask-user-dock", id: "test-dock-card" }, "pick one")
    );
  });

  const card = container.querySelector("#test-dock-card");
  assert.ok(card, "the shell must have a place to mount the live question");

  const scroller = container.querySelector("#transcript");
  assert.ok(scroller, "precondition: the transcript scroller exists");
  assert.equal(
    scroller.contains(card),
    false,
    "inside the scroller it would still be virtualized away and rebuilt"
  );

  const composer = container.querySelector("#message-form");
  assert.ok(composer, "precondition: the composer exists");
  assert.ok(
    card.compareDocumentPosition(composer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    "the question must sit above the composer, not below it"
  );

  await act(async () => {
    publishLocalAskUserDockContent(null);
  });
  assert.equal(
    container.querySelector("#test-dock-card"),
    null,
    "and it goes away when nothing is pending"
  );

  await act(async () => root.unmount());
  container.remove();
});
