// Clicks the real card: a static render cannot tell a report that opens from one that
// only carries aria-expanded.
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
const { ReviewerPanel } = await import("./reviewer-panel.js");

const h = React.createElement;

const goal = (status, outcome) => ({ objective: "ship it", status, outcome, turns: 3, max_turns: 20 });

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const panel = { container };
  panel.render = (g) =>
    act(async () => root.render(h(ReviewerPanel, { goal: g, reviewJobs: [], canRequest: false })));
  panel.report = () => container.querySelector(".reviewer-goal-report");
  panel.clickReport = () =>
    act(async () => {
      panel.report().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  panel.unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return panel;
}

test("a finished goal's report opens on click and closes again", async () => {
  const panel = await mount();
  await panel.render(goal("complete_claimed", "first report"));
  assert.equal(panel.report().getAttribute("aria-expanded"), "false");
  await panel.clickReport();
  assert.match(panel.report().className, /is-expanded/);
  assert.equal(panel.report().getAttribute("aria-expanded"), "true");
  await panel.clickReport();
  assert.doesNotMatch(panel.report().className, /is-expanded/);
  await panel.unmount();
});

// Found in review: opening one report left every later report open too.
test("a new report starts clamped, even after the last one was opened", async () => {
  const panel = await mount();
  await panel.render(goal("complete_claimed", "first report"));
  await panel.clickReport();
  await panel.render(goal("active", null));
  await panel.render(goal("complete_claimed", "second report"));
  assert.doesNotMatch(panel.report().className, /is-expanded/, "resumed then finished again");

  await panel.clickReport();
  await panel.render({ ...goal("complete_claimed", "another goal's report"), objective: "other" });
  assert.doesNotMatch(panel.report().className, /is-expanded/, "switched to another goal");
  await panel.unmount();
});
