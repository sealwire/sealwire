// A remote reader who left a thread mid-history must land back on that offset
// after switching away and back — NOT at the bottom.
//
// The trap this guards is a React commit-ordering detail: child DOM mutations
// are committed BEFORE a parent's layout-effect cleanup runs, so by the time
// the transcript pane's cleanup fires, the scroller already shows the NEXT
// thread. Recording geometry there files the next thread's numbers (typically
// "empty, therefore at the bottom") under the LEAVING thread's key, which turns
// a history-reading offset into a false bottom-follow marker and snaps the
// reader to the tail on the way back.
//
// The scroller below models a real browser closely enough to expose exactly
// that: height derives from the rendered rows, and scrollTop is clamped (and
// stays clamped) when the content shrinks.
//
// Kept in its own file so the DOM globals below don't leak into the static suite.
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

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRemoteTranscriptScrollBookkeeping } = await import(
  "./use-transcript-scroll-bookkeeping.js"
);

const h = React.createElement;

const CLIENT_HEIGHT = 266;
const ROW_HEIGHT = 46;
const laidOut = new WeakSet();

// Minimal layout model: scrollHeight follows the rendered rows and scrollTop
// behaves like a browser's — clamped to the scrollable range, and it does NOT
// spring back when the content grows again.
function installFakeLayout(element) {
  if (laidOut.has(element)) {
    return;
  }
  laidOut.add(element);
  let top = 0;
  const maxScrollTop = () =>
    Math.max(0, element.scrollHeight - element.clientHeight);
  Object.defineProperty(element, "clientHeight", { get: () => CLIENT_HEIGHT });
  Object.defineProperty(element, "scrollHeight", {
    get: () =>
      Math.max(
        CLIENT_HEIGHT,
        element.querySelectorAll("[data-transcript-row]").length * ROW_HEIGHT
      ),
  });
  Object.defineProperty(element, "scrollTop", {
    get: () => {
      top = Math.min(top, maxScrollTop());
      return top;
    },
    set: (value) => {
      top = Math.max(0, Math.min(Number(value) || 0, maxScrollTop()));
    },
  });
}

function entriesFor(threadId, count) {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `${threadId}-item-${index}`,
    kind: index === 0 ? "user_text" : "assistant_text",
    text: `${threadId} line ${index}`,
  }));
}

function Harness({ currentState, entries, session, threadId }) {
  const transcriptRef = React.useRef(null);
  const attach = React.useCallback((element) => {
    transcriptRef.current = element;
    if (element) {
      installFakeLayout(element);
    }
  }, []);

  useRemoteTranscriptScrollBookkeeping({
    currentState,
    entries,
    session,
    threadId,
    transcriptRef,
  });

  return h(
    "div",
    { className: "chat-thread", id: "remote-transcript", ref: attach },
    entries.map((entry) =>
      h("div", { key: entry.item_id, "data-transcript-row": "1" }, entry.text)
    )
  );
}

function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const currentState = { activeRelayId: "relay-1" };
  return {
    scroller: () => host.querySelector(".chat-thread"),
    show(threadId, entries, session = null) {
      act(() => root.render(h(Harness, { currentState, entries, session, threadId })));
    },
    // A reader scroll: the browser moves scrollTop, then fires `scroll`.
    scrollTo(scrollTop) {
      const element = host.querySelector(".chat-thread");
      element.scrollTop = scrollTop;
      act(() => {
        element.dispatchEvent(new dom.window.Event("scroll"));
      });
    },
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("a mid-history offset survives switching to another thread and back", () => {
  const view = mount();
  try {
    const first = entriesFor("thread-a", 8);
    view.show("thread-a", first);
    const bottom = view.scroller().scrollTop;
    assert.equal(bottom, 8 * ROW_HEIGHT - CLIENT_HEIGHT, "first view lands at the bottom");

    // The reader escapes the tail to read history.
    view.scrollTo(bottom - 40);
    assert.equal(view.scroller().scrollTop, bottom - 40);

    // Switch away to a thread whose projection is still empty (the shorter
    // content clamps the shared scroller to the top), then come back.
    view.show("thread-b", []);
    view.show("thread-a", first);

    assert.equal(
      view.scroller().scrollTop,
      bottom - 40,
      "switch-back restores the history offset instead of snapping to the bottom"
    );
    const element = view.scroller();
    const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
    assert.equal(distance, 40, "the reader is still off the bottom after switch-back");
  } finally {
    view.cleanup();
  }
});

test("a reader left at the tail keeps following it after switching back", () => {
  const view = mount();
  try {
    const first = entriesFor("thread-a", 8);
    view.show("thread-a", first);
    const bottom = view.scroller().scrollTop;
    view.scrollTo(bottom);

    view.show("thread-b", []);
    // The thread grew while it was hidden: bottom-follow is an intent, not a
    // pixel offset, so we land at the NEW bottom.
    const grown = entriesFor("thread-a", 12);
    view.show("thread-a", grown);

    assert.equal(
      view.scroller().scrollTop,
      12 * ROW_HEIGHT - CLIENT_HEIGHT,
      "switch-back lands at the new bottom"
    );
  } finally {
    view.cleanup();
  }
});

test("an arriving ask-user question pulls an escaped reader to the request — once", () => {
  // The integration the pure-function tests cannot cover: a request that is not a
  // transcript entry still has to move a REAL scroller. AskUser renders inside the
  // tool-call entry it belongs to, at the tail of the transcript, so a reader who
  // scrolled up never sees it and the session just looks hung.
  const view = mount();
  try {
    const entries = entriesFor("thread-a", 20);
    view.show("thread-a", entries);
    const bottom = view.scroller().scrollTop;

    // The reader escapes upward while the turn is still running.
    view.scrollTo(bottom - 120);
    assert.equal(view.scroller().scrollTop, bottom - 120, "precondition: reader is off the tail");

    const asking = {
      active_thread_id: "thread-a",
      pending_ask_user_questions: [{ thread_id: "thread-a", request_id: "q-1" }],
    };
    view.show("thread-a", entries, asking);
    assert.equal(
      view.scroller().scrollTop,
      bottom,
      "the question the agent is blocked on must be brought into view"
    );

    // Fire-once: the reader may leave again while the SAME question is pending,
    // and every later render must leave them where they put themselves.
    view.scrollTo(bottom - 120);
    view.show("thread-a", entries, asking);
    view.show("thread-a", entries, asking);
    assert.equal(
      view.scroller().scrollTop,
      bottom - 120,
      "a still-pending question must not re-yank the reader on every render"
    );
  } finally {
    view.cleanup();
  }
});

test("a SECOND request after the first is answered pulls the reader back again", () => {
  const view = mount();
  try {
    const entries = entriesFor("thread-a", 20);
    view.show("thread-a", entries);
    const bottom = view.scroller().scrollTop;

    view.scrollTo(bottom - 120);
    view.show("thread-a", entries, {
      active_thread_id: "thread-a",
      pending_approvals: [{ thread_id: "thread-a", request_id: "req-1" }],
    });
    assert.equal(view.scroller().scrollTop, bottom, "first request lands");

    // Answered, reader goes back to reading history, then a NEW request arrives.
    view.show("thread-a", entries, { active_thread_id: "thread-a" });
    view.scrollTo(bottom - 120);
    view.show("thread-a", entries, {
      active_thread_id: "thread-a",
      pending_approvals: [{ thread_id: "thread-a", request_id: "req-2" }],
    });
    assert.equal(
      view.scroller().scrollTop,
      bottom,
      "fire-once is per request id, so a second request fires again"
    );
  } finally {
    view.cleanup();
  }
});

test("a send and a request arriving together are BOTH claimed by the one render", () => {
  // The call-site half of the same-render claim: the hook must record both ids off
  // a single action. If it only records the user entry, the next render sees a
  // "new" request and drags the reader back down — on the most common path there
  // is, because the relay publishes the user message and the approval in one beat.
  const view = mount();
  try {
    const entries = entriesFor("thread-a", 20);
    view.show("thread-a", entries);
    const firstBottom = view.scroller().scrollTop;

    // The reader is reading history when they fire off a new message.
    view.scrollTo(firstBottom - 120);
    const sent = [
      ...entries,
      { item_id: "thread-a-sent", kind: "user_text", text: "please run the tests" },
    ];
    const asking = {
      active_thread_id: "thread-a",
      pending_approvals: [{ thread_id: "thread-a", request_id: "r1" }],
    };
    view.show("thread-a", sent, asking);

    const bottom = view.scroller().scrollTop;
    const element = view.scroller();
    assert.equal(
      bottom,
      element.scrollHeight - element.clientHeight,
      "the send lands at the bottom, which also shows the request"
    );

    // The reader scrolls away again. The request is unchanged and already seen, so
    // every later render must leave them alone.
    view.scrollTo(bottom - 120);
    view.show("thread-a", sent, asking);
    view.show("thread-a", sent, asking);
    assert.equal(
      view.scroller().scrollTop,
      bottom - 120,
      "a request already shown by the send's own jump must not re-fire"
    );
  } finally {
    view.cleanup();
  }
});
