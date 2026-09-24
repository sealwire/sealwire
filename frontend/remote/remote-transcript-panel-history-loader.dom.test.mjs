// React reuses the remote pane's history sentinel across thread and relay
// switches; one thread's exhausted loader must not strand the next one.
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

global.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
};

const observers = [];
global.IntersectionObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    observers.push(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {
    this.disconnected = true;
  }
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { RemoteTranscriptPanel } = await import("./remote-transcript-panel.js");

function entriesFor(threadId) {
  return Array.from({ length: 3 }, (_, index) => ({
    item_id: `${threadId}-item-${index}`,
    kind: index === 0 ? "user_text" : "agent_text",
    status: "completed",
    text: `${threadId} line ${index}`,
    turn_id: `${threadId}-turn`,
  }));
}

function props({ relayId = "relay-1", threadId }) {
  return {
    currentState: { activeRelayId: relayId },
    emptyStateModel: { showRelayHome: false, showServerDisconnected: false },
    onApplyFileChange: () => {},
    onForkFromMessage: () => {},
    onSelectRelay: () => {},
    onToggleExpandableBlock: () => {},
    onSubmitDecision: () => {},
    onSubmitAskUserAnswers: () => {},
    onToggleTranscriptItem: () => {},
    onEnsureFileChangeDetail: () => {},
    pendingAskUserQuestions: [],
    session: {
      active_thread_id: threadId,
      provider: "codex",
      transcript: entriesFor(threadId),
    },
    sessionView: { approval: null, canCompose: true, canWrite: true },
    transcriptDetailEntries: new Map(),
    askUserDetailErrors: new Map(),
    askUserDetailLoadingRequestIds: new Set(),
    uiState: {
      transcriptExpandedItemIds: new Set(),
      transcriptLoadingItemIds: new Set(),
      askUserSubmittingRequestIds: new Set(),
      askUserErrors: new Map(),
    },
  };
}

test("switching remote threads or relays starts a fresh history loader on the reused sentinel", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (next) => act(() => root.render(React.createElement(RemoteTranscriptPanel, props(next))));
  try {
    render({ threadId: "thread-a" });
    const sentinel = host.querySelector("[data-transcript-history-sentinel]");
    assert.ok(sentinel, "precondition: the transcript renders its history sentinel");
    assert.equal(observers.length, 1);

    render({ threadId: "thread-a" });
    assert.equal(observers.length, 1, "a re-render of the same thread keeps its loader");

    render({ threadId: "thread-b" });
    assert.equal(
      host.querySelector("[data-transcript-history-sentinel]"),
      sentinel,
      "precondition: React reused the sentinel node"
    );
    assert.equal(observers.length, 2, "the new thread gets its own loader");
    assert.equal(observers[0].disconnected, true);

    render({ relayId: "relay-2", threadId: "thread-b" });
    assert.equal(observers.length, 3, "the same thread id on another relay is another history");
    assert.equal(observers.filter((observer) => !observer.disconnected).length, 1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
