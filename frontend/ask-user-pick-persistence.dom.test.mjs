// What the reader has clicked must outlive the card.
//
// A multi-question card only HIGHLIGHTS on click; the answer is sent later. So
// between the click and the send, anything that tears the card down — a stale
// snapshot that briefly drops the pending request, a virtualized row scrolling
// out — takes the picks with it, and the reader watches their choice get
// forgotten with no error and nothing to retry. This drives the real components
// through that exact sequence: pick, question disappears for a beat, question
// comes back.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.MouseEvent = dom.window.MouseEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TranscriptContent } = await import("./shared/transcript-react.js");

const h = React.createElement;

const TOOL_USE_ID = "askuser-1";
const ITEM_ID = `tool:${TOOL_USE_ID}`;
const REQUEST_ID = "req-ask-1";

// Two questions, so a click only records a pick — the quick path would submit
// on click and have nothing to remember.
function questions() {
  return [
    {
      question: "Which approach?",
      header: "Approach",
      multiSelect: false,
      options: [{ label: "Option A" }, { label: "Option B" }],
    },
    {
      question: "Which surface?",
      header: "Surface",
      multiSelect: false,
      options: [{ label: "Local" }, { label: "Remote" }],
    },
  ];
}

// Rebuilt per render the way a fetched snapshot is: fresh objects every time.
function pendingList() {
  return JSON.parse(
    JSON.stringify([
      {
        request_id: REQUEST_ID,
        tool_use_id: TOOL_USE_ID,
        thread_id: "thread-1",
        questions: questions(),
      },
    ])
  );
}

function entries() {
  return [
    { item_id: "msg-1", kind: "agent_text", text: "Working on it.", status: "completed" },
    {
      item_id: ITEM_ID,
      kind: "tool_call",
      status: "running",
      tool: {
        name: "AskUserQuestion",
        input_preview: JSON.stringify({ questions: questions() }),
      },
    },
  ];
}

function options(pending) {
  return {
    detailEntries: new Map(),
    expandedKeys: new Set(),
    loadingItemIds: new Set(),
    pendingAskUserQuestions: pending,
    onSubmitAskUserAnswers: () => {},
    askUserSubmittingRequestIds: new Set(),
    askUserErrors: new Map(),
  };
}

test("a pick survives the question card being torn down and rebuilt", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const paint = async (pending) => {
    await act(async () => {
      root.render(h(TranscriptContent, { entries: entries(), options: options(pending) }));
    });
  };
  const optionButtons = () => [...container.querySelectorAll(".ask-user-option-button")];

  await paint(pendingList());
  await act(async () => {
    optionButtons()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(
    optionButtons()[0].getAttribute("aria-pressed"),
    "true",
    "precondition: the click marks the option chosen"
  );

  // The beat where a stale snapshot says nothing is pending: the wizard is
  // replaced by the read-only card, so its state goes with it.
  await paint([]);
  assert.equal(
    container.querySelectorAll(".ask-user-option-button").length,
    0,
    "precondition: with no pending request the card has no live options"
  );

  // The next snapshot puts the question back, and the reader is still mid-answer.
  await paint(pendingList());
  assert.equal(
    optionButtons()[0].getAttribute("aria-pressed"),
    "true",
    "the option the reader picked must still be picked"
  );
  assert.equal(
    container.querySelector(".ask-user-wizard-next")?.disabled,
    false,
    "and Continue must still be live, so they can finish answering"
  );

  await act(async () => root.unmount());
  container.remove();
});
