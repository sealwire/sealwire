import test from "node:test";
import assert from "node:assert/strict";

import {
  createCachingTranscriptPageFetcher,
  isCacheablePage,
  isVolatileEntry,
} from "./caching-transcript-fetcher.js";

function makePage(threadId, before, entries = [{ item_id: `i-${before}` }]) {
  return {
    thread_id: threadId,
    entries,
    prev_cursor: before != null ? before - 1 : 5,
    revision: 1,
  };
}

function makeCache(initial = []) {
  const store = new Map(initial.map((record) => [keyOf(record), record.page]));
  const reads = [];
  const writes = [];
  return {
    store,
    reads,
    writes,
    async readPage({ scope, threadId, before }) {
      reads.push({ scope, threadId, before });
      return store.get(`${scope}|${threadId}|${before}`) || null;
    },
    async writePage({ scope, threadId, before, page }) {
      writes.push({ scope, threadId, before, page });
      store.set(`${scope}|${threadId}|${before}`, page);
    },
  };
}

function keyOf({ scope = "s", threadId, before }) {
  return `${scope}|${threadId}|${before}`;
}

test("tail page (before == null) always hits network and never touches the cache", async () => {
  const cache = makeCache();
  let calls = 0;
  const fetchPage = async ({ threadId, before }) => {
    calls += 1;
    return makePage(threadId, before);
  };
  const fetcher = createCachingTranscriptPageFetcher({
    fetchPage,
    cache,
    getScope: () => "s",
  });

  const page = await fetcher({ threadId: "t1", before: null });

  assert.equal(calls, 1);
  assert.equal(page.thread_id, "t1");
  assert.equal(cache.reads.length, 0, "tail must not read cache");
  assert.equal(cache.writes.length, 0, "tail must not write cache");
});

test("older page cache hit returns cached page without calling the network", async () => {
  const cachedPage = makePage("t1", 10, [{ item_id: "cached" }]);
  const cache = makeCache([{ scope: "s", threadId: "t1", before: 10, page: cachedPage }]);
  let calls = 0;
  const fetchPage = async () => {
    calls += 1;
    return makePage("t1", 10);
  };
  const fetcher = createCachingTranscriptPageFetcher({
    fetchPage,
    cache,
    getScope: () => "s",
  });

  const page = await fetcher({ threadId: "t1", before: 10 });

  assert.equal(calls, 0, "cache hit must skip the network");
  assert.equal(page.entries[0].item_id, "cached");
});

test("older page cache miss fetches from network and writes through", async () => {
  const cache = makeCache();
  const fetchPage = async ({ threadId, before }) => makePage(threadId, before);
  const fetcher = createCachingTranscriptPageFetcher({
    fetchPage,
    cache,
    getScope: () => "s",
  });

  const page = await fetcher({ threadId: "t1", before: 10 });

  assert.equal(page.thread_id, "t1");
  assert.equal(cache.writes.length, 1);
  assert.deepEqual(
    { scope: cache.writes[0].scope, threadId: cache.writes[0].threadId, before: cache.writes[0].before },
    { scope: "s", threadId: "t1", before: 10 }
  );
});

test("empty network pages are not written to the cache", async () => {
  const cache = makeCache();
  const fetchPage = async ({ threadId }) => ({ thread_id: threadId, entries: [], prev_cursor: null });
  const fetcher = createCachingTranscriptPageFetcher({ fetchPage, cache, getScope: () => "s" });

  await fetcher({ threadId: "t1", before: 10 });

  assert.equal(cache.writes.length, 0);
});

test("a wrong-thread cached page is ignored and the network is used", async () => {
  const cache = makeCache([
    { scope: "s", threadId: "t1", before: 10, page: makePage("OTHER", 10) },
  ]);
  let calls = 0;
  const fetchPage = async ({ threadId, before }) => {
    calls += 1;
    return makePage(threadId, before);
  };
  const fetcher = createCachingTranscriptPageFetcher({ fetchPage, cache, getScope: () => "s" });

  const page = await fetcher({ threadId: "t1", before: 10 });

  assert.equal(calls, 1, "mismatched cache entry must fall back to network");
  assert.equal(page.thread_id, "t1");
});

test("a cache read error falls back to the network", async () => {
  const cache = {
    async readPage() {
      throw new Error("idb exploded");
    },
    async writePage() {},
  };
  let calls = 0;
  const fetchPage = async ({ threadId, before }) => {
    calls += 1;
    return makePage(threadId, before);
  };
  const fetcher = createCachingTranscriptPageFetcher({ fetchPage, cache, getScope: () => "s" });

  const page = await fetcher({ threadId: "t1", before: 10 });

  assert.equal(calls, 1);
  assert.equal(page.thread_id, "t1");
});

test("a cache write error never breaks the returned page", async () => {
  const cache = {
    async readPage() {
      return null;
    },
    async writePage() {
      throw new Error("quota exceeded");
    },
  };
  const fetchPage = async ({ threadId, before }) => makePage(threadId, before);
  const fetcher = createCachingTranscriptPageFetcher({ fetchPage, cache, getScope: () => "s" });

  const page = await fetcher({ threadId: "t1", before: 10 });
  assert.equal(page.thread_id, "t1");
});

test("missing cache degrades to the underlying fetcher", async () => {
  const fetchPage = async ({ threadId, before }) => makePage(threadId, before);
  const fetcher = createCachingTranscriptPageFetcher({ fetchPage, cache: null });
  assert.equal(fetcher, fetchPage);
});

test("an older page containing a still-running entry is NOT written through", async () => {
  const cache = makeCache();
  const fetchPage = async ({ threadId, before }) =>
    makePage(threadId, before, [
      { item_id: "done", status: "completed" },
      { item_id: "live-tool", status: "running" },
    ]);
  const fetcher = createCachingTranscriptPageFetcher({ fetchPage, cache, getScope: () => "s" });

  const page = await fetcher({ threadId: "t1", before: 10 });

  assert.equal(page.thread_id, "t1");
  assert.equal(cache.writes.length, 0, "a page with a volatile entry must not be cached");
});

test("an older page whose entries are all settled IS written through", async () => {
  const cache = makeCache();
  const fetchPage = async ({ threadId, before }) =>
    makePage(threadId, before, [
      { item_id: "a", status: "completed" },
      { item_id: "b", status: "completed" },
    ]);
  const fetcher = createCachingTranscriptPageFetcher({ fetchPage, cache, getScope: () => "s" });

  await fetcher({ threadId: "t1", before: 10 });

  assert.equal(cache.writes.length, 1);
});

test("isVolatileEntry flags in-flight statuses and clears terminal/empty ones", () => {
  for (const status of ["running", "in_progress", "in-progress", "pending", "streaming", "RUNNING"]) {
    assert.equal(isVolatileEntry({ status }), true, `${status} should be volatile`);
  }
  for (const status of ["completed", "failed", "aborted", "cancelled", "", undefined]) {
    assert.equal(isVolatileEntry({ status }), false, `${status} should be settled`);
  }
});

test("isCacheablePage requires a non-empty, thread-matching, fully-settled page", () => {
  const ok = { thread_id: "t1", entries: [{ item_id: "a", status: "completed" }] };
  assert.equal(isCacheablePage(ok, "t1"), true);
  assert.equal(isCacheablePage(ok, "other"), false);
  assert.equal(isCacheablePage({ thread_id: "t1", entries: [] }, "t1"), false);
  assert.equal(
    isCacheablePage({ thread_id: "t1", entries: [{ item_id: "a", status: "running" }] }, "t1"),
    false
  );
});
