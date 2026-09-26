// A virtualized transcript mounts the approval row only after a scroll has already
// been handled, and that mount need not resize anything. The bar has to notice the
// card appearing, or it sits over a card the reader can already see.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.MutationObserver = dom.window.MutationObserver;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ApprovalFloatBar } = await import("./shared/approval-float-bar.js");

const h = React.createElement;

function rect(top, bottom) {
  return () => ({ top, bottom, left: 0, right: 600, width: 600, height: bottom - top });
}

test("the bar hides once a late-mounted approval card is on screen", async () => {
  const scroller = document.createElement("div");
  scroller.className = "chat-thread";
  scroller.getBoundingClientRect = rect(0, 800);
  const content = document.createElement("div");
  content.className = "thread-content";
  const host = document.createElement("div");
  scroller.append(content, host);
  document.body.append(scroller);

  const root = createRoot(host);
  await act(async () => {
    root.render(h(ApprovalFloatBar, { approval: { request_id: "req-1", summary: "Bash", command: "ls" } }));
  });
  const bar = host.querySelector(".approval-float");
  assert.equal(bar.dataset.visible, "true", "no card mounted yet, so the bar stands in for it");

  const card = document.createElement("article");
  card.className = "chat-message chat-message-approval";
  card.dataset.approvalId = "req-1";
  card.getBoundingClientRect = rect(300, 500);
  await act(async () => {
    content.append(card);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  assert.equal(bar.dataset.visible, "false");
  await act(async () => root.unmount());
  scroller.remove();
});
