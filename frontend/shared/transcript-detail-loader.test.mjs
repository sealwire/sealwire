// The one way every surface loads a row's whole detail, tool call or card.
import test from "node:test";
import assert from "node:assert/strict";

import { createTranscriptDetailLoader } from "./transcript-detail-loader.js";

function harness({ fetchDetail } = {}) {
  const held = new Map();
  const loading = new Set();
  const calls = [];
  let thread = "thread-1";
  let changes = 0;
  const loader = createTranscriptDetailLoader({
    currentThreadId: () => thread,
    hasFull: (threadId, itemId) => held.has(`${threadId}:${itemId}`),
    fetchDetail: (threadId, itemId) => {
      calls.push(`${threadId}:${itemId}`);
      return fetchDetail ? fetchDetail(threadId, itemId) : Promise.resolve({ row_id: itemId, text: "whole" });
    },
    store: (threadId, detail) => held.set(`${threadId}:${detail.row_id}`, detail),
    setLoading: (itemId, on) => (on ? loading.add(itemId) : loading.delete(itemId)),
    onChange: () => {
      changes += 1;
    },
  });
  return {
    loader,
    held,
    loading,
    calls,
    switchTo: (next) => {
      thread = next;
    },
    changes: () => changes,
  };
}

test("one request per row, however often it is opened while it loads", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { loader, held, loading, calls } = harness({
    fetchDetail: async (_thread, itemId) => {
      await gate;
      return { row_id: itemId, text: "whole" };
    },
  });

  const first = loader.load("row");
  const second = loader.load("row");
  assert.deepEqual(calls, ["thread-1:row"]);
  assert.ok(loading.has("row"));
  release();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.ok(held.has("thread-1:row"));
  assert.equal(loading.size, 0);
});

test("a body already held whole is not asked for again", async () => {
  const { loader, held, calls } = harness();
  held.set("thread-1:row", { row_id: "row" });
  assert.equal(await loader.load("row"), false);
  assert.deepEqual(calls, []);
});

test("a failed load says so, and opening it again retries", async () => {
  let fail = true;
  const { loader, held, calls, changes } = harness({
    fetchDetail: async (_thread, itemId) => {
      if (fail) throw new Error("relay went away");
      return { row_id: itemId, text: "whole" };
    },
  });

  assert.equal(await loader.load("row"), false);
  assert.ok(loader.failedItemIds().has("row"));
  assert.ok(changes() > 0);
  const failedBefore = loader.failedItemIds();

  fail = false;
  assert.equal(await loader.load("row"), true);
  assert.equal(loader.failedItemIds().has("row"), false);
  assert.notEqual(loader.failedItemIds(), failedBefore, "a new set, so a memoized reader sees it");
  assert.deepEqual(calls, ["thread-1:row", "thread-1:row"]);
  assert.ok(held.has("thread-1:row"));
});

test("an answer for a thread no longer on screen is dropped", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    fetchDetail: async (_thread, itemId) => {
      await gate;
      return { row_id: itemId, text: "whole" };
    },
  });
  const pending = h.loader.load("row");
  h.switchTo("thread-2");
  release();
  assert.equal(await pending, false);
  assert.equal(h.held.size, 0);
  assert.equal(h.loader.failedItemIds().has("row"), false, "nothing failed; it is just not wanted");
});

test("a detail from another run of the relay comes back empty and can be retried", async () => {
  const { loader, held } = harness({ fetchDetail: async () => null });
  assert.equal(await loader.load("row"), false);
  assert.equal(held.size, 0);
  assert.ok(loader.failedItemIds().has("row"));
});

test("a caller can say what counts as whole for its own load", async () => {
  const { loader, held, calls } = harness();
  held.set("thread-1:row", { row_id: "row", summary: true });
  assert.equal(await loader.load("row", { hasFull: () => false }), true);
  assert.deepEqual(calls, ["thread-1:row"]);
});

test("a card's load fetches even with a copy held; a diff's only without the diff", async () => {
  const { loader, held, calls } = harness();
  held.set("thread-1:row", { row_id: "row" });
  assert.equal(await loader.loadBody("row"), true, "a card asks only while what it draws is short");
  assert.deepEqual(calls, ["thread-1:row"]);
  assert.equal(await loader.loadDiff("row"), false, "without its own rule a diff uses the default");
});
