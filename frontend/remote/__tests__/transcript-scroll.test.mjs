import test from "node:test";
import assert from "node:assert/strict";

function installBrowserStubs() {
  const storage = new Map();
  globalThis.document = {
    querySelector() {
      return {
        clientHeight: 0,
        scrollHeight: 0,
        scrollTop: 0,
      };
    },
  };
  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Test Browser" },
  });
}

installBrowserStubs();

const {
  computeTranscriptScrollPosition,
  deriveTranscriptScrollMode,
  didPrependOlderTranscript,
} = await import("../transcript-scroll.js");

function entry(id, turn = id) {
  return {
    item_id: id,
    kind: "agent_text",
    status: "completed",
    tool: null,
    turn_id: turn,
  };
}

test("deriveTranscriptScrollMode follows latest only when near the bottom", () => {
  assert.equal(
    deriveTranscriptScrollMode({
      clientHeight: 400,
      scrollHeight: 2000,
      scrollTop: 1590,
    }),
    "follow-latest"
  );

  assert.equal(
    deriveTranscriptScrollMode({
      clientHeight: 400,
      scrollHeight: 2000,
      scrollTop: 1200,
    }),
    "preserve"
  );
});

test("computeTranscriptScrollPosition preserves the viewport while reading history", () => {
  const result = computeTranscriptScrollPosition({
    clientHeight: 400,
    currentMode: "preserve",
    nextEntries: [entry("item-1"), entry("item-2")],
    nextScrollHeight: 2000,
    nextThreadId: "thread-1",
    previousEntries: [entry("item-1"), entry("item-2")],
    previousScrollHeight: 2000,
    previousScrollTop: 240,
    previousThreadId: "thread-1",
  });

  assert.deepEqual(result, {
    reason: "preserve",
    scrollTop: 240,
  });
});

test("computeTranscriptScrollPosition anchors after prepending older transcript", () => {
  const result = computeTranscriptScrollPosition({
    clientHeight: 400,
    currentMode: "preserve",
    nextEntries: [entry("item-1"), entry("item-2"), entry("item-3")],
    nextScrollHeight: 1700,
    nextThreadId: "thread-1",
    previousEntries: [entry("item-2"), entry("item-3")],
    previousScrollHeight: 1200,
    previousScrollTop: 180,
    previousThreadId: "thread-1",
  });

  assert.deepEqual(result, {
    reason: "prepended-anchor",
    scrollTop: 680,
  });
});

test("computeTranscriptScrollPosition keeps the user pinned at top during prepend hydration", () => {
  const result = computeTranscriptScrollPosition({
    clientHeight: 400,
    currentMode: "preserve",
    nextEntries: [entry("item-1"), entry("item-2"), entry("item-3")],
    nextScrollHeight: 1700,
    nextThreadId: "thread-1",
    previousEntries: [entry("item-2"), entry("item-3")],
    previousScrollHeight: 1200,
    previousScrollTop: 0,
    previousThreadId: "thread-1",
  });

  assert.deepEqual(result, {
    reason: "prepended-keep-top",
    scrollTop: 0,
  });
});

test("computeTranscriptScrollPosition snaps to the latest message on thread switch", () => {
  const result = computeTranscriptScrollPosition({
    clientHeight: 400,
    currentMode: "preserve",
    nextEntries: [entry("item-9")],
    nextScrollHeight: 1700,
    nextThreadId: "thread-2",
    previousEntries: [entry("item-1")],
    previousScrollHeight: 1200,
    previousScrollTop: 120,
    previousThreadId: "thread-1",
  });

  assert.deepEqual(result, {
    reason: "stick-bottom",
    scrollTop: 1300,
  });
});

test("computeTranscriptScrollPosition stays bottom-pinned across async hydration updates", () => {
  const result = computeTranscriptScrollPosition({
    clientHeight: 400,
    currentMode: "follow-latest",
    nextEntries: [entry("item-7"), entry("item-9")],
    nextScrollHeight: 2100,
    nextThreadId: "thread-2",
    previousEntries: [entry("item-9")],
    previousScrollHeight: 1700,
    previousScrollTop: 0,
    previousThreadId: "thread-2",
  });

  assert.deepEqual(result, {
    reason: "stick-bottom",
    scrollTop: 1700,
  });
});

test("didPrependOlderTranscript only matches true prepends", () => {
  assert.equal(
    didPrependOlderTranscript([entry("item-2"), entry("item-3")], [
      entry("item-1"),
      entry("item-2"),
      entry("item-3"),
    ]),
    true
  );

  assert.equal(
    didPrependOlderTranscript([entry("item-2"), entry("item-3")], [
      entry("item-2"),
      entry("item-4"),
    ]),
    false
  );
});
