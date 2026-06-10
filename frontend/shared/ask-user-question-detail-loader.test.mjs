import test from "node:test";
import assert from "node:assert/strict";

import { createAskUserQuestionDetailLoader } from "./ask-user-question-detail-loader.js";

const detailFor = (id) => ({ request_id: id, questions: [{ q: `full text of ${id}` }] });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("loads a detail, then clears loading and stores it", async () => {
  const loader = createAskUserQuestionDetailLoader({
    fetchDetail: async (id) => detailFor(id),
  });
  loader.sync(["ask:1"]);
  assert.equal(loader.snapshot().loading.has("ask:1"), true, "loading set synchronously");

  await tick();
  const snap = loader.snapshot();
  assert.equal(snap.loading.has("ask:1"), false, "loading cleared after resolve");
  assert.deepEqual(snap.details.get("ask:1"), detailFor("ask:1"), "detail stored");
});

test("REGRESSION: a re-sync while a fetch is in flight does NOT cancel it", async () => {
  // This is the stuck "Loading question detail" bug: the old inline effect
  // re-triggered itself on setLoading and its cleanup discarded the in-flight
  // fetch, so loading never cleared and the detail never arrived.
  const d = deferred();
  let fetchCount = 0;
  const loader = createAskUserQuestionDetailLoader({
    fetchDetail: () => {
      fetchCount += 1;
      return d.promise;
    },
  });

  loader.sync(["ask:1"]); // starts the fetch
  assert.equal(loader.snapshot().loading.has("ask:1"), true);
  await tick(); // let the (microtask-deferred) fetchDetail actually run
  assert.equal(fetchCount, 1);
  assert.equal(loader.snapshot().loading.has("ask:1"), true, "still in flight (unresolved)");

  loader.sync(["ask:1"]); // simulate a re-render / re-sync while still loading
  loader.sync(["ask:1"]);
  assert.equal(fetchCount, 1, "must not refetch while already loading");

  d.resolve(detailFor("ask:1")); // fetch resolves AFTER the re-syncs
  await tick();

  const snap = loader.snapshot();
  assert.equal(snap.loading.has("ask:1"), false, "loading must clear, not get stuck");
  assert.equal(snap.details.has("ask:1"), true, "detail must be delivered, not discarded");
});

test("records an error and clears loading on fetch failure", async () => {
  const loader = createAskUserQuestionDetailLoader({
    fetchDetail: async () => {
      throw new Error("boom");
    },
  });
  loader.sync(["ask:1"]);
  await tick();

  const snap = loader.snapshot();
  assert.equal(snap.loading.has("ask:1"), false);
  assert.equal(snap.errors.get("ask:1"), "boom");
  assert.equal(snap.details.has("ask:1"), false);
});

test("pruning a request ignores its late result without touching others", async () => {
  const slow = deferred();
  const loader = createAskUserQuestionDetailLoader({
    fetchDetail: (id) => (id === "ask:1" ? slow.promise : Promise.resolve(detailFor(id))),
  });

  loader.sync(["ask:1"]); // ask:1 starts (slow)
  loader.sync(["ask:2"]); // ask:1 pruned, ask:2 starts
  await tick();
  assert.equal(loader.snapshot().details.has("ask:2"), true, "unrelated request still loads");

  slow.resolve(detailFor("ask:1")); // pruned request resolves late
  await tick();
  assert.equal(loader.snapshot().details.has("ask:1"), false, "late result of pruned request ignored");
  assert.equal(loader.snapshot().loading.has("ask:1"), false);
  assert.equal(loader.snapshot().details.has("ask:2"), true, "the other request is unaffected");
});

test("a pruned-then-rewanted request fetches again", async () => {
  let fetchCount = 0;
  const loader = createAskUserQuestionDetailLoader({
    fetchDetail: async (id) => {
      fetchCount += 1;
      return detailFor(id);
    },
  });
  loader.sync(["ask:1"]);
  loader.sync([]); // prune
  await tick();
  loader.sync(["ask:1"]); // wanted again
  await tick();
  assert.equal(fetchCount, 2);
  assert.equal(loader.snapshot().details.has("ask:1"), true);
});

test("dispose ignores in-flight results and clears state", async () => {
  const d = deferred();
  const loader = createAskUserQuestionDetailLoader({ fetchDetail: () => d.promise });
  loader.sync(["ask:1"]);
  loader.dispose();
  d.resolve(detailFor("ask:1"));
  await tick();
  assert.equal(loader.snapshot().details.has("ask:1"), false);
  assert.equal(loader.snapshot().loading.has("ask:1"), false);
});

test("onChange fires snapshots as state evolves", async () => {
  const snaps = [];
  const loader = createAskUserQuestionDetailLoader({
    fetchDetail: async (id) => detailFor(id),
    onChange: (snap) => snaps.push(snap),
  });
  loader.sync(["ask:1"]); // -> loading snapshot
  await tick(); // -> loaded snapshot
  assert.ok(snaps.length >= 2, "at least a loading and a loaded snapshot");
  assert.equal(snaps[0].loading.has("ask:1"), true);
  assert.equal(snaps[snaps.length - 1].details.has("ask:1"), true);
  assert.equal(snaps[snaps.length - 1].loading.has("ask:1"), false);
});

test("a missing detail (no request_id) clears loading and allows a later retry", async () => {
  let fetchCount = 0;
  let result = null;
  const loader = createAskUserQuestionDetailLoader({
    fetchDetail: async () => {
      fetchCount += 1;
      return result;
    },
  });
  loader.sync(["ask:1"]);
  await tick();
  assert.equal(loader.snapshot().loading.has("ask:1"), false, "loading cleared even without a detail");
  assert.equal(loader.snapshot().details.has("ask:1"), false);

  result = detailFor("ask:1");
  loader.sync(["ask:1"]); // a later sync retries (request still not loaded)
  await tick();
  assert.equal(fetchCount, 2);
  assert.equal(loader.snapshot().details.has("ask:1"), true);
});
