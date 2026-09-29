// The follower tags its OWN pins (`selfScrollTop`) so its echo is never mistaken for
// a reader scroll. Nothing else in the transcript is tagged — most importantly the
// TanStack virtualizer, which rewrites `scrollTop` whenever a row measures differently
// from its estimate. Those writes land wherever the correction puts them, and when
// that is the bottom, "distance <= restick" used to be read as "the reader settled
// back at the bottom" and re-armed the follow behind a reader who had just escaped.
//
// jsdom on purpose: there is no layout, so scrollTop/scrollHeight/clientHeight are
// exactly what this test says they are. That makes the ordering deterministic —
// escape, then an untagged write to the bottom, then growth — which in a real browser
// is a race decided by CPU speed (the browser suite lost it on CI and won it locally).
import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.IS_REACT_ACT_ENVIRONMENT = true;

const observers = [];
dom.window.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }

  observe() {}

  disconnect() {}
};
// The follower constructs `new ResizeObserver(...)` off the bare global, not off
// `window`, so the stub has to live there too.
global.ResizeObserver = dom.window.ResizeObserver;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { StickToBottomFollower } = await import("./stick-to-bottom.js");
const { getTranscriptScrollController } = await import("./transcript-scroll-controller.js");
const frames = new Map();
let nextFrame = 0;
dom.window.requestAnimationFrame = cb => { frames.set(++nextFrame, cb); return nextFrame; };
dom.window.cancelAnimationFrame = id => frames.delete(id);
function paint() { const pending = [...frames.values()]; frames.clear(); for (const cb of pending) cb(); }

const h = React.createElement;
const VIEWPORT = 1000;

// Long enough to outlive the follower's reader-intent window, so the write under test
// is unattributable — which is exactly what a virtualizer correction is.
const AFTER_READER_INTENT_MS = 350;

function mountFollower() {
  const scroller = dom.window.document.createElement("div");
  scroller.className = "chat-thread";
  const content = dom.window.document.createElement("div");
  content.className = "thread-content";
  scroller.appendChild(content);
  dom.window.document.body.appendChild(scroller);

  let scrollTop = 0;
  let scrollHeight = 5000;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT });

  observers.length = 0;
  const root = createRoot(content);
  act(() => root.render(h(StickToBottomFollower)));

  const bottom = () => scrollHeight - VIEWPORT;
  return {
    scroller,
    root,
    bottom,
    get scrollTop() {
      return scrollTop;
    },
    grow(by) {
      scrollHeight += by;
      // The follower follows growth through the ResizeObserver, never through scroll.
      for (const observer of observers) observer.callback();
      paint();
    },
    // A write with no reader gesture behind it and no `selfScrollTop` tag — a
    // virtualizer size correction, or any other programmatic writer.
    untaggedWriteTo(value) {
      scrollTop = value;
      scroller.dispatchEvent(new dom.window.Event("scroll"));
    },
    readerWheelUpTo(value) {
      scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -800 }));
      scrollTop = value;
      scroller.dispatchEvent(new dom.window.Event("scroll"));
    },
    jumpToBottom() {
      scrollTop = bottom();
      getTranscriptScrollController(scroller).apply({ kind: "jump-bottom" });
    },
  };
}

test("an untagged write to the bottom does not re-arm the follow after a reader escapes", async () => {
  const view = mountFollower();
  try {
    view.jumpToBottom();
    view.grow(1000);
    assert.equal(view.scrollTop, view.bottom(), "following the bottom before the escape");

    view.readerWheelUpTo(2000);
    view.grow(1000);
    assert.equal(view.scrollTop, 2000, "the escape holds while the stream keeps growing");

    // The virtualizer corrects scrollTop, and the correction happens to land at the
    // bottom. No wheel, no key, no pointer — nothing that makes it the reader's.
    await new Promise((resolve) => setTimeout(resolve, AFTER_READER_INTENT_MS));
    const landedAt = view.bottom();
    view.untaggedWriteTo(landedAt);

    view.grow(1000);
    assert.equal(
      view.scrollTop,
      landedAt,
      "an untagged write that lands at the bottom must not re-arm bottom-follow — "
        + "the reader stays where the correction left them instead of being glued down"
    );
  } finally {
    act(() => view.root.unmount());
  }
});

test("the reader wheeling back to the bottom still re-arms the follow", () => {
  const view = mountFollower();
  try {
    view.jumpToBottom();
    view.readerWheelUpTo(2000);
    view.grow(1000);
    assert.equal(view.scrollTop, 2000, "escaped");

    // Same landing spot as the test above, but with a reader gesture behind it.
    view.readerWheelUpTo(view.bottom());
    view.grow(1000);
    assert.equal(
      view.scrollTop,
      view.bottom(),
      "a reader-driven return to the bottom must still re-lock the follow"
    );
  } finally {
    act(() => view.root.unmount());
  }
});
