// Reader gestures that must escape the live bottom-follow, in event orders a real
// browser produces but a slow, even drag does not. jsdom keeps geometry exact.
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
global.ResizeObserver = dom.window.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {}
};

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { StickToBottomFollower } = await import("./stick-to-bottom.js");
const { TRANSCRIPT_SCROLL_ACTION_EVENT } = await import("./transcript-scroll.js");

const VIEWPORT = 800;

function mountFollower({ scrollHeight: initialHeight = 6000 } = {}) {
  const scroller = dom.window.document.createElement("div");
  scroller.className = "chat-thread";
  const content = dom.window.document.createElement("div");
  content.className = "thread-content";
  scroller.appendChild(content);
  dom.window.document.body.appendChild(scroller);

  let scrollTop = 0;
  let scrollHeight = initialHeight;
  const maxTop = () => Math.max(0, scrollHeight - VIEWPORT);
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = Math.max(0, Math.min(value, maxTop()));
    },
  });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT });

  observers.length = 0;
  const root = createRoot(content);
  act(() => root.render(React.createElement(StickToBottomFollower)));

  const touch = (type, clientY, { clientX = 100, target = scroller } = {}) => {
    const event = new dom.window.Event(type, { bubbles: true });
    event.touches = clientY == null ? [] : [{ clientX, clientY }];
    target.dispatchEvent(event);
  };
  return {
    bottom: maxTop,
    get scrollTop() {
      return scrollTop;
    },
    jumpToBottom() {
      scrollTop = maxTop();
      scroller.dispatchEvent(
        new dom.window.CustomEvent(TRANSCRIPT_SCROLL_ACTION_EVENT, {
          detail: { kind: "jump-bottom" },
        })
      );
    },
    grow(by) {
      scrollHeight += by;
      for (const observer of observers) observer.callback();
    },
    // The browser applying a scroll (reader or momentum) and reporting it.
    scrollTo(value) {
      scrollTop = Math.max(0, Math.min(value, maxTop()));
      scroller.dispatchEvent(new dom.window.Event("scroll"));
    },
    wheel(deltaY) {
      scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY }));
    },
    content,
    touchStart: (y, options) => touch("touchstart", y, options),
    touchMove: (y, options) => touch("touchmove", y, options),
    touchEnd: (options) => touch("touchend", null, options),
    unmount() {
      act(() => root.unmount());
      scroller.remove();
    },
  };
}

test("a trackpad's first small wheel step up escapes the follow", () => {
  const view = mountFollower();
  try {
    view.jumpToBottom();
    const escapedTo = view.bottom() - 2;
    view.wheel(-2);
    view.scrollTo(escapedTo);
    view.grow(400);
    assert.equal(view.scrollTop, escapedTo, "two pixels up is still the reader leaving the bottom");
  } finally {
    view.unmount();
  }
});

test("a finger creeping up one pixel per frame escapes the follow", () => {
  const view = mountFollower();
  try {
    view.jumpToBottom();
    const start = view.bottom();
    view.touchStart(300);
    for (let step = 1; step <= 12; step += 1) {
      view.touchMove(300 + step);
      view.scrollTo(view.scrollTop - 1);
    }
    assert.equal(view.scrollTop, start - 12, "no step of the drag may be pinned back");
    view.touchEnd();
    view.grow(400);
    assert.equal(view.scrollTop, start - 12, "the stream keeps growing below the reader");
  } finally {
    view.unmount();
  }
});

test("a flick whose scroll is reported after the finger lifts is not pulled back", () => {
  const view = mountFollower();
  try {
    view.jumpToBottom();
    const start = view.bottom();
    view.touchStart(300);
    view.touchMove(330);
    view.touchMove(370);
    view.touchEnd();
    view.scrollTo(start - 250);
    view.scrollTo(start - 600);
    view.grow(400);
    assert.equal(view.scrollTop, start - 600, "the momentum of an upward flick belongs to the reader");
  } finally {
    view.unmount();
  }
});

test("a pull on a transcript with nothing above it keeps following", () => {
  const view = mountFollower({ scrollHeight: VIEWPORT });
  try {
    view.jumpToBottom();
    view.touchStart(300);
    view.touchMove(360);
    view.touchEnd();
    view.grow(1200);
    assert.equal(view.scrollTop, view.bottom(), "there was nothing to escape to, so the reply stays followed");
  } finally {
    view.unmount();
  }
});

test("a sideways swipe across a wide block keeps following", () => {
  const view = mountFollower();
  try {
    view.jumpToBottom();
    view.touchStart(300, { clientX: 300 });
    view.touchMove(306, { clientX: 220 });
    view.touchMove(314, { clientX: 120 });
    view.touchEnd();
    view.grow(400);
    assert.equal(view.scrollTop, view.bottom(), "horizontal intent must not release the follow");
  } finally {
    view.unmount();
  }
});

test("pulling inside a nested box that can still scroll up keeps following", () => {
  const view = mountFollower();
  try {
    const box = dom.window.document.createElement("pre");
    Object.defineProperty(box, "scrollTop", { configurable: true, get: () => 120 });
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => 900 });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => 300 });
    view.content.appendChild(box);
    view.jumpToBottom();
    view.touchStart(300, { target: box });
    view.touchMove(360, { target: box });
    view.touchEnd({ target: box });
    view.grow(400);
    assert.equal(view.scrollTop, view.bottom(), "only the nested box moved, so the reply stays followed");
  } finally {
    view.unmount();
  }
});
