// A group of one closes from its tool's own row too; the focused row goes, so focus
// has to land on the group line that stays, not fall out of the page.
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
const ENTRIES = [
  { item_id: "a1", kind: "agent_text", status: "completed", text: "Checking." },
  {
    item_id: "c1",
    kind: "tool_call",
    status: "completed",
    tool: { item_type: "toolCall", name: "Bash", title: "Bash", detail: "Run tests", command: "npm test" },
  },
  { item_id: "a2", kind: "agent_text", status: "completed", text: "Done." },
];

test("closing a group of one from its tool's row leaves focus on the group line", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (keys) => root.render(h(TranscriptContent, { entries: ENTRIES, options: { expandedKeys: new Set(keys) } }));
  await act(async () => render(["entry:c1"]));

  container.querySelector('[data-transcript-entry-id="c1"] button.tool-run-row').focus();
  await act(async () => render([]));

  const focused = document.activeElement;
  assert.ok(
    focused === container.querySelector(".work-group-chip"),
    `focus is on ${focused?.tagName}.${focused?.className || ""}`
  );
  await act(async () => root.unmount());
});
