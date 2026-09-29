// The brief line's Cancel carries what the surface needs to act, as drawn.
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
const { resolveTranscriptAction } = await import("./shared/transcript-interactions.js");

const h = React.createElement;
const ask = (extra) => ({
  id: "ask-1",
  asker_thread_id: "asker",
  asker_provider: "claude_code",
  peer_thread_id: "peer",
  peer_provider: "codex",
  task: "ask codex",
  title: "Where does the text come from?",
  instruction: "",
  status: "working",
  delivered: false,
  asked_at: 1,
  ...extra,
});
const request = (extra) => ({
  item_id: "req",
  kind: "user_text",
  status: "completed",
  text: "prompt",
  injection: { kind: "delegate_request", delegate: [ask(extra)] },
});

async function mount(entries) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(h(TranscriptContent, { entries, options: { provider: "claude_code" } })));
  return { container, unmount: () => act(async () => root.unmount()) };
}

test("Cancel on the brief line stops the asker's own turn", async () => {
  const { container, unmount } = await mount([
    request({ peer_thread_id: "" }),
  ]);
  const resolved = resolveTranscriptAction(container.querySelector('[data-delegate-action="cancel"]'));
  assert.equal(resolved.kind, "delegateAction");
  assert.equal(resolved.threadId, "asker");
  assert.equal(container.querySelectorAll("[data-delegate-action]").length, 1, "the only button a card has");
  await unmount();
});
