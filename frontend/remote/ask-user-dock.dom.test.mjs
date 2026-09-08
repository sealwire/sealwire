// The phone gets the same split as the desktop: the transcript keeps the record
// that a question was asked, and the live card — the one you actually tap — is
// mounted beside the composer, where scrolling and virtualization cannot reach
// it. Two live copies, or a set of options in the transcript that look tappable
// and are not, is exactly the confusion this removes.
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
const { AskUserDock } = await import("../shared/ask-user-dock.js");

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

test("the remote transcript keeps the record and leaves the live card to the dock", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(h(RemoteTranscriptPanel, panelProps()));
  });

  assert.equal(
    host.querySelectorAll(".chat-message-ask-user-interactive").length,
    0,
    "the transcript must not render its own live copy of the question"
  );
  assert.equal(
    host.querySelectorAll(".ask-user-option-button").length,
    0,
    "nor options in the conversation that cannot be tapped"
  );
  assert.match(
    host.textContent,
    /Waiting for your answer/,
    "the record still says the question is open"
  );

  act(() => root.unmount());
  host.remove();
});

test("the remote dock takes the answer and holds the pick", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const submitted = [];
  const render = () => {
    act(() => {
      root.render(
        h(
          React.Fragment,
          null,
          h(RemoteTranscriptPanel, panelProps()),
          h(AskUserDock, {
            pendingAskUserQuestions: pendingList(),
            options: {
              onSubmitAskUserAnswers: (requestId, answers) => submitted.push({ requestId, answers }),
              askUserSubmittingRequestIds: new Set(),
              askUserErrors: new Map(),
            },
          })
        )
      );
    });
  };

  render();
  const buttons = () => [...host.querySelectorAll(".ask-user-dock .ask-user-option-button")];
  assert.ok(buttons().length, "the dock renders the question the turn is parked on");

  act(() => {
    buttons()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(buttons()[0].getAttribute("aria-pressed"), "true");

  // A snapshot lands while the reader is still on question one.
  render();
  assert.equal(
    buttons()[0].getAttribute("aria-pressed"),
    "true",
    "the pick survives the re-render"
  );

  act(() => root.unmount());
  host.remove();
});
