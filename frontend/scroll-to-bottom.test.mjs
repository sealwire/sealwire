import test from "node:test";
import assert from "node:assert/strict";

import {
  SCROLL_TO_BOTTOM_THRESHOLD_PX,
  computeScrollToBottomVisible,
  findScrollContainer,
  isScrolledToBottom,
  maxScrollTop,
  nextSettleScrollTop,
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

test("nextSettleScrollTop: returns the bottom when we're above it (scroll down)", () => {
  assert.equal(
    nextSettleScrollTop(metrics({ scrollTop: 0, clientHeight: 400, scrollHeight: 2000 })),
    1600
  );
});

test("nextSettleScrollTop: never scrolls UP — returns null when the bottom is above us", () => {
  // content-visibility shrank scrollHeight so maxScrollTop (900) is now *above*
  // the current scrollTop (1600). Scrolling there would yank the viewport
  // backward — the "violent shaking" bug — so it must be a no-op.
  assert.equal(
    nextSettleScrollTop({ scrollTop: 1600, clientHeight: 400, scrollHeight: 1300 }),
    null
  );
});

test("nextSettleScrollTop: returns null when already at the bottom", () => {
  assert.equal(
    nextSettleScrollTop(metrics({ scrollTop: 1600, clientHeight: 400, scrollHeight: 2000 })),
    null
  );
});

test("nextSettleScrollTop: null metrics is a no-op", () => {
  assert.equal(nextSettleScrollTop(null), null);
});

test("readScrollMetrics: reads geometry from a scrollable element", () => {
  const element = { scrollTop: 120, clientHeight: 400, scrollHeight: 1800 };
  assert.deepEqual(readScrollMetrics(element), {
    scrollTop: 120,
    clientHeight: 400,
    scrollHeight: 1800,
  });
});

test("readScrollMetrics: null for a missing scroller", () => {
  assert.equal(readScrollMetrics(null), null);
});

test("findScrollContainer: resolves the nearest .chat-thread element scroller", () => {
  // The transcript is an element scroller on every surface, so this is simply
  // the enclosing `.chat-thread` — regardless of whether it currently overflows.
  const chatThread = { id: "chat-thread", scrollHeight: 2000, clientHeight: 400 };
  const node = {
    closest(selector) {
      return selector === ".chat-thread" ? chatThread : null;
    },
  };
  assert.equal(findScrollContainer(node), chatThread);
});

test("findScrollContainer: null when there is no enclosing .chat-thread", () => {
  const node = { closest: () => null };
  assert.equal(findScrollContainer(node), null);
});
