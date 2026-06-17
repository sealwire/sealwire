import test from "node:test";
import assert from "node:assert/strict";

import {
  SCROLL_TO_BOTTOM_THRESHOLD_PX,
  computeScrollToBottomVisible,
  findScrollContainer,
  isScrolledToBottom,
  maxScrollTop,
  readScrollMetrics,
} from "./shared/scroll-to-bottom-core.js";

function metrics({ scrollTop = 0, clientHeight = 400, scrollHeight = 2000 } = {}) {
  return { scrollTop, clientHeight, scrollHeight };
}

test("maxScrollTop is scrollHeight minus clientHeight, floored at 0", () => {
  assert.equal(maxScrollTop(metrics({ scrollHeight: 2000, clientHeight: 400 })), 1600);
  assert.equal(maxScrollTop(metrics({ scrollHeight: 300, clientHeight: 400 })), 0);
  assert.equal(maxScrollTop(null), 0);
});

test("isScrolledToBottom: exactly at the bottom", () => {
  assert.equal(isScrolledToBottom(metrics({ scrollTop: 1600 })), true);
});

test("isScrolledToBottom: within the threshold counts as at-bottom", () => {
  const justInside = 1600 - (SCROLL_TO_BOTTOM_THRESHOLD_PX - 1);
  assert.equal(isScrolledToBottom(metrics({ scrollTop: justInside })), true);
});

test("isScrolledToBottom: beyond the threshold is not at-bottom", () => {
  const justOutside = 1600 - (SCROLL_TO_BOTTOM_THRESHOLD_PX + 1);
  assert.equal(isScrolledToBottom(metrics({ scrollTop: justOutside })), false);
});

test("isScrolledToBottom: non-scrollable content is always at-bottom", () => {
  assert.equal(
    isScrolledToBottom(metrics({ scrollHeight: 300, clientHeight: 400, scrollTop: 0 })),
    true
  );
});

test("isScrolledToBottom: missing metrics defaults to at-bottom", () => {
  assert.equal(isScrolledToBottom(null), true);
});

test("computeScrollToBottomVisible: shows when scrolled up past the threshold", () => {
  assert.equal(computeScrollToBottomVisible(metrics({ scrollTop: 0 })), true);
});

test("computeScrollToBottomVisible: hidden when pinned to the bottom", () => {
  assert.equal(computeScrollToBottomVisible(metrics({ scrollTop: 1600 })), false);
});

test("computeScrollToBottomVisible: hidden when content does not overflow", () => {
  assert.equal(
    computeScrollToBottomVisible(metrics({ scrollHeight: 300, clientHeight: 400 })),
    false
  );
});

test("computeScrollToBottomVisible: hidden for missing metrics", () => {
  assert.equal(computeScrollToBottomVisible(null), false);
});

test("readScrollMetrics: reads geometry from a scrollable element", () => {
  const element = { scrollTop: 120, clientHeight: 400, scrollHeight: 1800 };
  assert.deepEqual(readScrollMetrics(element), {
    scrollTop: 120,
    clientHeight: 400,
    scrollHeight: 1800,
  });
});

test("readScrollMetrics: reads geometry from a window-like scroller", () => {
  const win = {
    scrollY: 240,
    innerHeight: 700,
    document: { scrollingElement: { scrollHeight: 5000 } },
  };
  win.window = win;
  assert.deepEqual(readScrollMetrics(win), {
    scrollTop: 240,
    clientHeight: 700,
    scrollHeight: 5000,
  });
});

test("readScrollMetrics: null for a missing scroller", () => {
  assert.equal(readScrollMetrics(null), null);
});

test("findScrollContainer: uses .chat-thread when it overflows (desktop)", () => {
  const chatThread = { id: "chat-thread", scrollHeight: 2000, clientHeight: 400 };
  const node = {
    closest(selector) {
      return selector === ".chat-thread" ? chatThread : null;
    },
    ownerDocument: { defaultView: { name: "window" } },
  };
  assert.equal(findScrollContainer(node), chatThread);
});

test("findScrollContainer: falls back to the window when .chat-thread does not overflow (phone)", () => {
  // On phone the chat shell is height:auto and the page/window scrolls, so the
  // `.chat-thread` box is exactly as tall as its content (no overflow). The
  // button must then track the window, not the non-scrolling container.
  const view = { name: "window" };
  const chatThread = { id: "chat-thread", scrollHeight: 2719, clientHeight: 2719 };
  const node = {
    closest(selector) {
      return selector === ".chat-thread" ? chatThread : null;
    },
    ownerDocument: { defaultView: view },
  };
  assert.equal(findScrollContainer(node), view);
});

test("findScrollContainer: falls back to the document window with no container", () => {
  const view = { name: "window" };
  const node = {
    closest() {
      return null;
    },
    ownerDocument: { defaultView: view },
  };
  assert.equal(findScrollContainer(node), view);
});
