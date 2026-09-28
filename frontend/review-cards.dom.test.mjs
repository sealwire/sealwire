// A review card folds like a handover card: two lines a finding, three findings a card.
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
const LONG = "The set_goal gate is only checked when the goal is created, so a goal outlives the tools that allowed it.";
const finding = (text) => ({ severity: "medium", text, location: null });
const fixed = [LONG, "short one", "second short", "third short", "fourth short"].map(finding);
const review = {
  id: "review-1",
  round: 2,
  max_rounds: 3,
  parent_thread_id: "parent",
  parent_provider: "claude_code",
  reviewer_thread_id: "rev",
  reviewer_provider: "codex",
  status: "complete",
  rounds: [
    { round: 1, reviewer_thread_id: "rev", verdict: "needs_changes", findings: [], findings_total: 6, fixed: [], fixed_total: 0, started_at: 1, finished_at: 2 },
    { round: 2, reviewer_thread_id: "rev", verdict: "approve", findings: [], findings_total: 0, fixed, fixed_total: 6, started_at: 3, finished_at: 4 },
  ],
};
const entries = [
  { item_id: "u1", kind: "user_text", status: "completed", text: "prompt", injection: { kind: "review_approved", review } },
];

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries, options: { provider: "claude_code" } })));
  return { container, root };
}

const texts = (container) =>
  [...container.querySelectorAll(".review-finding-text")].map((node) => node.textContent);

test("a long finding opens when pressed, and a short one has nothing to open", async () => {
  const { container, root } = await mount();
  const [long, short] = container.querySelectorAll(".review-finding-text");
  // Booleans only: a failing assert on a jsdom node tries to print the whole window.
  assert.ok(long.classList.contains("is-clamped"));
  assert.ok(long.classList.contains("is-togglable"));
  assert.ok(!short.classList.contains("is-togglable"), "it already fits");

  await act(async () => long.click());
  assert.ok(!long.classList.contains("is-clamped"), "opened in full");

  await act(async () => long.click());
  assert.ok(long.classList.contains("is-clamped"));
  await act(async () => root.unmount());
});

test("a folded finding opens from the keyboard too, and a short one is not a stop on the way", async () => {
  const { container, root } = await mount();
  const [long, short] = container.querySelectorAll(".review-finding-text");
  assert.equal(long.getAttribute("tabindex"), "0");
  assert.equal(long.getAttribute("role"), "button");
  assert.equal(long.getAttribute("aria-expanded"), "false");
  assert.equal(short.getAttribute("tabindex"), null, "nothing to open");

  const press = (key) =>
    long.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await act(async () => press("Enter"));
  assert.ok(!long.classList.contains("is-clamped"), "Enter opens it");
  assert.equal(long.getAttribute("aria-expanded"), "true");
  await act(async () => press(" "));
  assert.ok(long.classList.contains("is-clamped"), "Space folds it again");
  await act(async () => root.unmount());
});

test("Show all findings lists the rest, and says what only the reviewer's thread holds", async () => {
  const { container, root } = await mount();
  assert.equal(texts(container).length, 3);
  assert.ok(!container.textContent.includes("more in the reviewer"));

  const more = [...container.querySelectorAll("button")].find((node) => node.textContent === "Show all findings");
  await act(async () => more.click());

  assert.equal(texts(container).length, 5);
  assert.ok(container.textContent.includes("1 more in the reviewer's thread"));
  assert.equal(more.getAttribute("aria-expanded"), "true");
  await act(async () => root.unmount());
});
