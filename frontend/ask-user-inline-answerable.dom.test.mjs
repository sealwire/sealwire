// The question you are being asked must be answerable where it is shown, and it
// must stay on screen without a scroller of its own.
//
// Docking it above the composer bought "never unmounted" by giving the card a
// second scroll region that ate up to 55vh of the column — so the transcript
// behind it could no longer be scrolled back through. These two drive the
// properties that replace it: the live card renders in the transcript, and the
// virtualizer cannot unmount it out from under a half-finished answer.
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

const TOOL_USE_ID = "askuser-inline-1";
const ITEM_ID = `tool:${TOOL_USE_ID}`;
const REQUEST_ID = "req-inline-1";

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

const askEntry = () => ({
  item_id: ITEM_ID,
  kind: "tool_call",
  status: "running",
  tool: {
    name: "AskUserQuestion",
    input_preview: JSON.stringify({ questions: questions() }),
  },
});

function options(extra = {}) {
  return {
    detailEntries: new Map(),
    expandedKeys: new Set(),
    loadingItemIds: new Set(),
    pendingAskUserQuestions: pendingList(),
    onSubmitAskUserAnswers: () => {},
    askUserSubmittingRequestIds: new Set(),
    askUserErrors: new Map(),
    ...extra,
  };
}

async function paint(root, entries, opts) {
  await act(async () => {
    root.render(h(TranscriptContent, { entries, options: opts }));
  });
}

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return { container, root: createRoot(container) };
}

// Every surface used to pass askUserDocked, which downgraded the in-place card
// to a record with no options — a live question the reader could read and not
// answer, with the real one in a scroller of its own outside the transcript.
test("the transcript never renders a live question the reader cannot answer", async () => {
  const { container, root } = mount();

  await paint(
    root,
    [
      { item_id: "msg-1", kind: "agent_text", text: "Working on it.", status: "completed" },
      askEntry(),
    ],
    options({ askUserDocked: true })
  );

  assert.ok(
    container.querySelector(".chat-message-ask-user"),
    "precondition: the pending question is in the transcript at all"
  );
  // The wizard shows one question at a time, so this is the first question's two.
  assert.deepEqual(
    [...container.querySelectorAll(".ask-user-option-button")].map((b) => b.textContent),
    ["Option A", "Option B"],
    "the options must be tappable in the transcript itself"
  );

  await act(async () => root.unmount());
  container.remove();
});

// A pending question is answerable even when its tool call is not in the
// transcript at all.
//
// The relay drops transcript entries from the HEAD under snapshot pressure
// (`split_off` / `remove(0)` in protocol.rs) and a switched-to thread hydrates its
// history in pages, so "there is a pending request" and "its row is loaded" are
// separate facts. Keyed only off the row, the turn parks on a question the reader
// is never shown and cannot answer.
test("a pending question with no transcript row of its own is still answerable", async () => {
  const { container, root } = mount();

  await paint(
    root,
    [{ item_id: "msg-1", kind: "agent_text", text: "Working on it.", status: "completed" }],
    options()
  );

  assert.deepEqual(
    [...container.querySelectorAll(".ask-user-option-button")].map((b) => b.textContent),
    ["Option A", "Option B"],
    "the question the turn is parked on must be answerable with or without its row"
  );

  // And when the row arrives, the reader must not end up with two live copies of
  // the same question competing for the tap.
  await paint(
    root,
    [
      { item_id: "msg-1", kind: "agent_text", text: "Working on it.", status: "completed" },
      askEntry(),
    ],
    options()
  );
  assert.equal(
    container.querySelectorAll(".chat-message-ask-user-interactive").length,
    1,
    "the arriving row replaces the standalone card rather than doubling it"
  );

  await act(async () => root.unmount());
  container.remove();
});

// Two questions can be parked at once, and the relay stamps arrival order so
// same-second cards keep the order they were asked in. Rendering the ones with a
// row first and the ones without after throws that away: mid-hydration the older
// question sorts below the newer one, and then jumps as its row arrives — under a
// reader who is part-way through answering it.
function twoPendingRequests() {
  const q = (label) => [
    {
      question: `Question ${label}?`,
      header: label,
      multiSelect: false,
      options: [{ label: `${label}-A` }, { label: `${label}-B` }],
    },
    // A second question keeps this off the one-tap quick path, so a click records
    // a pick instead of submitting.
    {
      question: `Follow-up ${label}?`,
      header: label,
      multiSelect: false,
      options: [{ label: `${label}-C` }],
    },
  ];
  return [
    { request_id: "req-first", tool_use_id: "ask-first", thread_id: "thread-1", questions: q("FIRST") },
    { request_id: "req-second", tool_use_id: "ask-second", thread_id: "thread-1", questions: q("SECOND") },
  ];
}

const toolEntry = (toolUseId, questions) => ({
  item_id: `tool:${toolUseId}`,
  kind: "tool_call",
  status: "running",
  tool: { name: "AskUserQuestion", input_preview: JSON.stringify({ questions }) },
});

const headerOrder = (container) =>
  [...container.querySelectorAll(".ask-user-question-header")].map((el) => el.textContent);

test("parked questions keep the order the relay asked them in, however they hydrate", async () => {
  const { container, root } = mount();
  const pending = twoPendingRequests();

  // Mid-hydration: only the SECOND question's row has loaded.
  await paint(
    root,
    [toolEntry("ask-second", pending[1].questions)],
    options({ pendingAskUserQuestions: pending })
  );
  assert.deepEqual(
    headerOrder(container),
    ["FIRST", "SECOND"],
    "the question asked first stays first even while its row is still missing"
  );

  // The older row arrives. Nothing may reshuffle under the reader.
  await paint(
    root,
    [toolEntry("ask-first", pending[0].questions), toolEntry("ask-second", pending[1].questions)],
    options({ pendingAskUserQuestions: pending })
  );
  assert.deepEqual(
    headerOrder(container),
    ["FIRST", "SECOND"],
    "and still first once its row hydrates"
  );

  await act(async () => root.unmount());
  container.remove();
});

test("an answer given before the row hydrates survives the row arriving", async () => {
  const { container, root } = mount();
  const pending = twoPendingRequests();
  // A chosen option gains a "✓ " prefix, so match on the label with it stripped.
  const firstOptions = () =>
    [...container.querySelectorAll(".ask-user-option-button")].filter((b) =>
      b.textContent.replace(/^✓\s*/, "").startsWith("FIRST-")
    );

  // No rows at all yet: both cards are built from the requests.
  await paint(root, [], options({ pendingAskUserQuestions: pending }));
  await act(async () => {
    firstOptions()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(
    firstOptions()[0].getAttribute("aria-pressed"),
    "true",
    "precondition: the pick registers on the request-backed card"
  );

  // The row hydrates and takes the card over. The draft key is derived the same
  // way on both sides, so the pick must ride across the swap.
  await paint(
    root,
    [toolEntry("ask-first", pending[0].questions)],
    options({ pendingAskUserQuestions: pending })
  );
  assert.equal(
    firstOptions()[0].getAttribute("aria-pressed"),
    "true",
    "the pick made before the row loaded is still made after it does"
  );

  await act(async () => root.unmount());
  container.remove();
});

// The hazard the dock was built to dodge: virtualization owns every row, so the
// card holding a half-finished answer is unmounted the moment the reader scrolls
// up to re-read what they are answering about.
test("scrolling history cannot unmount the question waiting for an answer", async () => {
  const { container, root } = mount();

  const filler = Array.from({ length: 60 }, (_, index) => ({
    item_id: `msg-${index}`,
    kind: "agent_text",
    text: `Line ${index}`,
    status: "completed",
  }));

  await paint(root, [...filler, askEntry()], options());

  assert.ok(
    container.querySelector(".transcript-virtual-spacer"),
    "precondition: this many rows virtualizes"
  );

  const card = container.querySelector(".chat-message-ask-user-interactive");
  assert.ok(card, "the live card is rendered");
  assert.equal(
    card.closest(".transcript-virtual-spacer"),
    null,
    "it must sit outside the virtualized range, so no scroll position can unmount it"
  );
  assert.ok(
    card.closest(".thread-content"),
    "and still inside the transcript, so it scrolls with the conversation rather than in its own pane"
  );

  await act(async () => root.unmount());
  container.remove();
});
