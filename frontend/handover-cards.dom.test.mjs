// A handover card folds each section to a couple of lines; its heading opens it.
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
// jsdom lays nothing out: a folded value "overflows" when it holds more than a short line.
Object.defineProperty(dom.window.HTMLElement.prototype, "clientHeight", { get: () => 40 });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollHeight", {
  get() {
    return this.textContent.length > 40 ? 120 : 20;
  },
});

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent } = await import("./shared/transcript-react.js");

const h = React.createElement;
const summary = [
  "## Goal",
  "Selection Ask: select text in a reply, an Ask button appears, and clicking it quotes the selection.",
  "## Current state",
  "Done.",
].join("\n");
const handover = {
  id: "handover-1",
  source_thread_id: "src",
  source_provider: "claude_code",
  target_thread_id: "tgt",
  target_provider: "codex",
  note: "",
  instruction: "",
  status: "done",
  created_at: 1,
  updated_at: 1,
};
const entries = [
  { item_id: "u1", kind: "user_text", status: "completed", text: "prompt", injection: { kind: "handover_request", handover } },
  { item_id: "a1", kind: "agent_text", status: "completed", text: summary },
];

function section(container, title) {
  const row = [...container.querySelectorAll(".handover-section")].find((node) =>
    node.querySelector(".handover-section-label")?.textContent.includes(title)
  );
  return { toggle: row.querySelector("button.handover-section-label"), value: row.querySelector(".handover-section-value") };
}

test("a long section opens from its heading, and a short one has nothing to open", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries, options: { provider: "claude_code" } })));

  const goal = section(container, "Goal");
  assert.ok(goal.toggle, "the Goal heading is a button");
  // Booleans only: a failing assert on a jsdom node tries to print the whole window.
  assert.ok(!goal.toggle.querySelector("svg"), "the heading's own text is the target, no arrow");
  assert.equal(goal.toggle.getAttribute("aria-expanded"), "false");
  assert.ok(goal.value.classList.contains("is-clamped"));

  await act(async () => goal.toggle.click());

  assert.equal(goal.toggle.getAttribute("aria-expanded"), "true");
  assert.ok(!goal.value.classList.contains("is-clamped"), "opened in full");
  assert.ok(!section(container, "Current state").toggle, "it already fits");

  await act(async () => root.unmount());
});

test("pressing the text opens its section, and pressing it again folds it", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries, options: { provider: "claude_code" } })));

  const goal = section(container, "Goal");
  await act(async () => goal.value.click());

  assert.equal(goal.toggle.getAttribute("aria-expanded"), "true");
  assert.ok(!goal.value.classList.contains("is-clamped"));

  await act(async () => goal.value.click());

  assert.equal(goal.toggle.getAttribute("aria-expanded"), "false");
  assert.ok(goal.value.classList.contains("is-clamped"));

  await act(async () => root.unmount());
});
