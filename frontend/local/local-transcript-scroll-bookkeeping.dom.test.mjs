// The local transcript pane's read-before-swap trick only exists in the real
// commit cycle: a layout effect always sees the NEW thread's already-clamped
// scrollTop, so the hook has to read the leaving thread's geometry in its
// render body, before this commit's DOM mutation lands. That is only
// observable by driving the real hook through a real React root — a
// source-text read of the hook proves nothing about ordering.
//
// The scroller below models a real browser closely enough to expose exactly
// that: height derives from the rendered rows, and scrollTop is clamped (and
// stays clamped) when the content shrinks. Copied from
// use-transcript-scroll-bookkeeping.dom.test.mjs (remote); not shared, since
// sharing the harness would blur which surface a failure belongs to.
//
// Kept in its own file so the DOM globals below don't leak into the static
// suite.
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
const { useLocalTranscriptScrollBookkeeping } = await import(
  "./use-local-transcript-scroll-bookkeeping.js"
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

// `salt` lets a test mint a second, distinct user-entry id for a thread it
// already visited — without it, index 0's id would collide with the one
// already recorded as "seen" from the earlier visit, hiding a real fire-once
// bug behind an accidental match.
function entriesFor(threadId, count, salt = "") {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `${threadId}${salt}-item-${index}`,
    kind: index === 0 ? "user_text" : "assistant_text",
    text: `${threadId} line ${index}`,
  }));
}

function Harness({ activeThreadId, entries, mode, resetEpoch, scrollElement, session }) {
  useLocalTranscriptScrollBookkeeping({
    activeThreadId,
    entries,
    mode,
    resetEpoch,
    scrollElement,
    session,
  });

  return entries.map((entry) =>
    h("div", { key: entry.item_id, "data-transcript-row": "1" }, entry.text)
  );
}

function mount() {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  installFakeLayout(host);
  const root = createRoot(host);
  return {
    host,
    show(threadId, entries, { mode = "entries", resetEpoch = 0, session = null } = {}) {
      act(() =>
        root.render(
          h(Harness, {
            activeThreadId: threadId,
            entries,
            mode,
            resetEpoch,
            scrollElement: host,
            session,
          })
        )
      );
    },
    cleanup() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

test("a leaving thread's offset is retained at its pre-swap value, not the clamped post-swap reading", () => {
  const view = mount();
  try {
    view.show("thread-a", entriesFor("thread-a", 8));
    const bottom = view.host.scrollTop;
    assert.equal(bottom, 8 * ROW_HEIGHT - CLIENT_HEIGHT, "first view lands at the bottom");

    // The reader escapes the tail to read history.
    view.host.scrollTop = bottom - 40;
    assert.equal(view.host.scrollTop, bottom - 40);

    // Switch to a thread whose projection is empty — the shorter content
    // clamps the shared scroller to the top the instant it commits. If the
    // hook read geometry AFTER this swap it would retain 0, not bottom - 40.
    view.show("thread-b", [], { mode: "empty-ready" });
    assert.equal(view.host.scrollTop, 0, "the swap itself clamps the live scrollTop");

    view.show("thread-a", entriesFor("thread-a", 8));
    assert.equal(
      view.host.scrollTop,
      bottom - 40,
      "switch-back restores the PRE-swap offset, not the clamped post-swap one"
    );
  } finally {
    view.cleanup();
  }
});

test("switching away and back restores a bottom-follow reader to the new bottom, not a stale pixel offset", () => {
  const view = mount();
  try {
    view.show("thread-a", entriesFor("thread-a", 8));
    const bottom = view.host.scrollTop;
    view.host.scrollTop = bottom; // reader is at the tail, following

    view.show("thread-b", []);
    // The thread grew while it was hidden: bottom-follow is an intent, not a
    // pixel offset, so switch-back lands at the NEW bottom.
    view.show("thread-a", entriesFor("thread-a", 12));

    assert.equal(
      view.host.scrollTop,
      12 * ROW_HEIGHT - CLIENT_HEIGHT,
      "switch-back lands at the new bottom, not the old pixel offset"
    );
  } finally {
    view.cleanup();
  }
});

test("a genuinely empty thread's first message ignores a stale retained offset from an earlier visit under the same id", () => {
  // Without the empty-ready capture, the first message would see the STALE
  // previousSnapshot (still pointing at whatever thread came before) and
  // misclassify this as a thread SWITCH into "thread-a" — restoring an old,
  // unrelated offset instead of jumping fresh to the bottom like any other
  // new message.
  const view = mount();
  try {
    // An earlier visit to thread-a leaves a mid-history offset on record.
    view.show("thread-a", entriesFor("thread-a", 8));
    view.host.scrollTop = 10; // near the top, far from bottom-follow
    view.show("decoy-1", []); // evicts thread-a's offset (10) into the store

    // thread-a is now empty and ready (e.g. hydration reset before the first
    // send) — the hook must capture ITS OWN empty snapshot here.
    view.show("thread-a", [], { mode: "empty-ready" });

    // The first real message arrives. Salted so its user-entry id is fresh,
    // not the one already marked "seen" from the earlier visit above.
    view.show("thread-a", entriesFor("thread-a", 20, ":v2"));
    const freshBottom = 20 * ROW_HEIGHT - CLIENT_HEIGHT;
    assert.notEqual(freshBottom, 10, "precondition: the fresh bottom differs from the stale offset");
    assert.equal(
      view.host.scrollTop,
      freshBottom,
      "the first message must jump to the fresh bottom, not restore the stale offset (10) from its earlier visit"
    );
  } finally {
    view.cleanup();
  }
});

test("branches 1-4 (mode: null) leave the retained store untouched", () => {
  // Deliberately adversarial: same activeThreadId, same row count, but a
  // FRESH user-entry id -- if the mode gate were bypassed this would read as
  // a new message and jump-bottom for real, overwriting the retained
  // mid-history offset before the reader ever left the thread.
  const view = mount();
  try {
    view.show("thread-a", entriesFor("thread-a", 20));
    const bottom = view.host.scrollTop;
    view.host.scrollTop = 600;

    view.show("thread-a", entriesFor("thread-a", 20, ":decoy"), { mode: null });

    // The eviction below is the first read of scrollTop since it was set to
    // 600 -- a bypassed gate would have already overwritten it to `bottom`.
    view.show("decoy-1", []);
    view.show("thread-a", entriesFor("thread-a", 20));
    assert.equal(
      view.host.scrollTop,
      600,
      "mode: null must not evict, capture, or otherwise touch the store, even given fresh entries for the current thread"
    );
    assert.notEqual(600, bottom, "precondition: the retained offset differs from a fresh jump-bottom");
  } finally {
    view.cleanup();
  }
});

test("unmounting mid-thread does not throw or leave a callback that fires later", () => {
  const view = mount();
  view.show("thread-a", entriesFor("thread-a", 8));
  assert.doesNotThrow(() => view.cleanup());
});

test("a scroll-element identity swap applies the staged commit to the CURRENT element only", () => {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const elementA = dom.window.document.createElement("div");
  const elementB = dom.window.document.createElement("div");
  installFakeLayout(elementA);
  installFakeLayout(elementB);
  for (const [element, rows] of [[elementA, 8], [elementB, 20]]) {
    for (let index = 0; index < rows; index += 1) {
      const row = dom.window.document.createElement("div");
      row.setAttribute("data-transcript-row", "1");
      element.append(row);
    }
  }
  try {
    act(() =>
      root.render(
        h(Harness, {
          activeThreadId: "a",
          entries: entriesFor("a", 8),
          mode: "entries",
          resetEpoch: 0,
          scrollElement: elementA,
          session: null,
        })
      )
    );
    assert.equal(elementA.scrollTop, 8 * ROW_HEIGHT - CLIENT_HEIGHT);
    assert.equal(elementB.scrollTop, 0, "an element that was never the current scrollElement is untouched");

    act(() =>
      root.render(
        h(Harness, {
          activeThreadId: "b",
          entries: entriesFor("b", 20),
          mode: "entries",
          resetEpoch: 0,
          scrollElement: elementB,
          session: null,
        })
      )
    );
    assert.equal(elementB.scrollTop, 20 * ROW_HEIGHT - CLIENT_HEIGHT);
    assert.equal(
      elementA.scrollTop,
      8 * ROW_HEIGHT - CLIENT_HEIGHT,
      "the previous element is left exactly as the earlier commit left it -- no stale write"
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

test("a reset epoch bump clears the retained store", () => {
  const view = mount();
  try {
    view.show("thread-a", entriesFor("thread-a", 8));
    const bottom = view.host.scrollTop;
    view.host.scrollTop = bottom - 40;
    view.show("decoy-1", []); // evicts thread-a's offset into the store

    // Without a bump, switching back restores the retained offset.
    view.show("thread-a", entriesFor("thread-a", 8), { resetEpoch: 0 });
    assert.equal(view.host.scrollTop, bottom - 40, "precondition: the offset is retained");

    view.host.scrollTop = bottom - 40;
    view.show("decoy-1", [], { resetEpoch: 0 });

    // A hydration reset bumps the epoch between renders.
    view.show("thread-a", entriesFor("thread-a", 8), { resetEpoch: 1 });
    assert.equal(
      view.host.scrollTop,
      bottom,
      "the epoch bump must clear the retained offset, landing at a fresh jump-bottom"
    );
  } finally {
    view.cleanup();
  }
});
