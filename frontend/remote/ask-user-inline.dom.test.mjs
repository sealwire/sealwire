// The phone answers the question in the conversation, not in a pane of its own.
//
// A dock above the composer took up to 45vh of a phone screen and scrolled
// separately, so the transcript behind it could not be read back through. In the
// transcript the card has to earn that place: last, below anything the turn said
// after asking, and holding the pick across the snapshots that keep arriving.
//
// Imports the panel module directly rather than react-app.js, for the reason
// spelled out in remote-transcript-panel-empty-states.test.mjs.
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
// jsdom ships neither: the shared stick-to-bottom follower and the transcript's
// history prefetch each build one as soon as the panel mounts.
dom.window.ResizeObserver = class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.IntersectionObserver = class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};
global.ResizeObserver = dom.window.ResizeObserver;
global.IntersectionObserver = dom.window.IntersectionObserver;
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RemoteTranscriptPanel } = await import("./remote-transcript-panel.js");

const h = React.createElement;

const THREAD = "thread-1";
const TOOL_USE_ID = "askuser-1";
const REQUEST_ID = "req-ask-1";
const TRAILING_TEXT = "Meanwhile, here is some context.";

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
        thread_id: THREAD,
        questions: questions(),
      },
    ])
  );
}

function session() {
  return {
    active_thread_id: THREAD,
    provider: "claude_code",
    transcript: [
      { item_id: "msg-1", kind: "agent_text", text: "Working on it.", status: "completed" },
      {
        item_id: `tool:${TOOL_USE_ID}`,
        kind: "tool_call",
        status: "running",
        tool: {
          name: "AskUserQuestion",
          input_preview: JSON.stringify({ questions: questions() }),
        },
      },
      { item_id: "msg-2", kind: "agent_text", text: TRAILING_TEXT, status: "completed" },
    ],
  };
}

function panelProps(overrides = {}) {
  return {
    currentState: {},
    emptyStateModel: { showRelayHome: false, showServerDisconnected: false },
    onApplyFileChange: () => {},
    onForkFromMessage: () => {},
    onSelectRelay: () => {},
    onToggleExpandableBlock: () => {},
    onSubmitDecision: () => {},
    onSubmitAskUserAnswers: () => {},
    onToggleTranscriptItem: () => {},
    onEnsureFileChangeDetail: () => {},
    pendingAskUserQuestions: pendingList(),
    session: session(),
    sessionView: { canWrite: true, canCompose: true, approval: null },
    transcriptDetailEntries: new Map(),
    askUserDetailErrors: new Map(),
    askUserDetailLoadingRequestIds: new Set(),
    uiState: {
      transcriptExpandedItemIds: new Set(),
      transcriptLoadingItemIds: new Set(),
      askUserSubmittingRequestIds: new Set(),
      askUserErrors: new Map(),
    },
    ...overrides,
  };
}

test("the live question is the last thing in the conversation, and the only copy", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(RemoteTranscriptPanel, panelProps()));
  });

  const cards = host.querySelectorAll(".chat-message-ask-user");
  assert.equal(cards.length, 1, "one card, not a record and a live copy competing for the tap");
  assert.ok(
    cards[0].classList.contains("chat-message-ask-user-interactive"),
    "and it is the answerable one"
  );

  // The turn kept talking after it asked, so in document order the question
  // would sit above that text; pinned, it is below it.
  const rendered = host.textContent;
  assert.ok(
    rendered.indexOf(TRAILING_TEXT) < rendered.indexOf("Which approach?"),
    "the question the turn is parked on is pinned past what it said afterwards"
  );

  // No scroller of its own — that is what made the conversation behind it
  // unreadable on a phone.
  const scroller = host.querySelector(".thread-content");
  assert.ok(scroller?.contains(cards[0]), "the card scrolls with the conversation");

  act(() => root.unmount());
  host.remove();
});

test("the phone holds the pick across the snapshots that keep arriving", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // Fresh props each time, the way a delivered snapshot rebuilds them.
  const render = () => {
    act(() => {
      root.render(h(RemoteTranscriptPanel, panelProps()));
    });
  };

  render();
  const buttons = () => [...host.querySelectorAll(".ask-user-option-button")];
  assert.ok(buttons().length, "the question the turn is parked on is answerable");

  act(() => {
    buttons()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(buttons()[0].getAttribute("aria-pressed"), "true");

  render();
  assert.equal(
    buttons()[0].getAttribute("aria-pressed"),
    "true",
    "the pick survives the re-render"
  );

  act(() => root.unmount());
  host.remove();
});
