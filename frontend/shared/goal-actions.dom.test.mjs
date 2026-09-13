// Drives the real buttons rather than calling the factory: both were dead for a release
// because the panel rendered them and the handler behind them called a name that existed
// nowhere. (The app.js wiring itself is pinned by undefined-identifier-guard.test.mjs.)
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
const { createGoalActions } = await import("./goal-actions.js");

const h = React.createElement;

function goalCard(status) {
  return {
    objective: "Ship the mobile surface",
    status,
    turns: 3,
    max_turns: 20,
    outcome: status === "active" ? null : "Said it was done.",
  };
}

async function mountWithGoal(
  goal,
  { threadId = "t1", setGoal = () => {}, stopGoal = () => {}, log = () => {} } = {}
) {
  const actions = createGoalActions({ getThreadId: () => threadId, setGoal, stopGoal, log });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      h(ReviewerPanel, {
        goal,
        onStopGoal: actions.onStopGoal,
        onResumeGoal: actions.onResumeGoal,
        canRequest: false,
        onDeleteReview() {},
        onResolveReview() {},
      })
    );
  });
  const button = (label) =>
    [...container.querySelectorAll(".reviewer-goal .reviewer-card-button")].find(
      (el) => el.textContent === label
    );
  return {
    async click(label) {
      const el = button(label);
      assert.ok(el, `expected a "${label}" button on the goal card`);
      await act(async () => {
        el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

// Stop must reach the capability that STOPS: remote sends a different action for it, so
// an empty objective routed through `setGoal` would silently do nothing there.
test("Stop reaches the stop capability, never the write one", async () => {
  const stopped = [];
  const written = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: (threadId) => {
      stopped.push(threadId);
      return Promise.resolve({ text: "Goal cleared." });
    },
    setGoal: (...args) => {
      written.push(args);
      return Promise.resolve({ text: "" });
    },
  });
  await panel.click("Stop");
  assert.deepEqual(stopped, ["t1"]);
  assert.deepEqual(written, []);
  await panel.unmount();
});

test("a completion claim the user rejects resumes the same objective", async () => {
  const calls = [];
  const panel = await mountWithGoal(goalCard("complete_claimed"), {
    setGoal: (threadId, objective) => {
      calls.push([threadId, objective]);
      return Promise.resolve({ text: "Goal resumed." });
    },
  });
  await panel.click("Not done — keep going");
  assert.deepEqual(calls, [["t1", "Ship the mobile surface"]]);
  await panel.unmount();
});

test("the relay's answer is surfaced, and a transport failure does not escape", async () => {
  const lines = [];
  const panel = await mountWithGoal(goalCard("active"), {
    stopGoal: () => Promise.reject(new Error("socket hang up")),
    log: (line) => lines.push(line),
  });
  await panel.click("Stop");
  assert.match(lines.join("\n"), /socket hang up/);
  await panel.unmount();
});

test("with no thread in view the buttons write nothing", async () => {
  const calls = [];
  const panel = await mountWithGoal(goalCard("active"), {
    threadId: null,
    stopGoal: (...args) => {
      calls.push(args);
      return Promise.resolve({ text: "" });
    },
  });
  await panel.click("Stop");
  assert.deepEqual(calls, []);
  await panel.unmount();
});
