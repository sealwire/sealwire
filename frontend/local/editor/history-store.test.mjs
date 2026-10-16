import test from "node:test";
import assert from "node:assert/strict";

import { createHistoryStore, graphApplies, NO_FILTERS } from "./history-store.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An api whose replies the test releases one by one. */
function pendingApi() {
  const calls = [];
  const reply = (kind) => (...args) => {
    const wait = deferred();
    calls.push({ kind, args, resolve: wait.resolve });
    return wait.promise;
  };
  return {
    calls,
    api: { history: reply("history"), historyCommit: reply("commit"), historyFile: reply("file") },
  };
}

const commit = (id, ...parents) => ({ id, parents, subject: id, author: "A", time: 1, refs: [] });

test("a reply for a folder the user has left does not replace the new folder's log", async () => {
  const { api, calls } = pendingApi();
  const history = createHistoryStore({ api });
  const first = history.show("/a");
  const second = history.show("/b");
  calls[1].resolve({ commits: [commit("b1")], more: false });
  calls[0].resolve({ commits: [commit("a1")], more: false });
  await Promise.all([first, second]);
  assert.equal(calls[1].args[0].root, "/b");
  assert.deepEqual(history.getState().log.commits.map((entry) => entry.id), ["b1"]);
});

test("only the latest filter's answer is shown, and the filters reach the relay trimmed", async () => {
  const { api, calls } = pendingApi();
  const history = createHistoryStore({ api });
  const shown = history.show("/a");
  const filtered = history.setFilters({ author: "  ann ", branch: "topic" });
  assert.deepEqual(
    { author: calls[1].args[0].author, branch: calls[1].args[0].branch, skip: calls[1].args[0].skip },
    { author: "ann", branch: "topic", skip: 0 }
  );
  calls[1].resolve({ commits: [commit("t1")], more: false });
  calls[0].resolve({ commits: [commit("all1"), commit("all2")], more: false });
  await Promise.all([shown, filtered]);
  assert.deepEqual(history.getState().log.commits.map((entry) => entry.id), ["t1"]);
});

test("the next page continues from the last commit and drops one already shown", async () => {
  const { api, calls } = pendingApi();
  const history = createHistoryStore({ api });
  const shown = history.show("/a");
  calls[0].resolve({ commits: [commit("c1"), commit("c2")], more: true });
  await shown;
  const more = history.load({ append: true });
  void history.load({ append: true });
  assert.equal(calls.length, 2, "a second 'more' while one is loading asks nothing");
  assert.equal(calls[1].args[0].skip, 2);
  calls[1].resolve({ commits: [commit("c2"), commit("c3")], more: false });
  await more;
  assert.deepEqual(history.getState().log.commits.map((entry) => entry.id), ["c1", "c2", "c3"]);
  assert.equal(history.getState().log.more, false);
});

test("a commit's details and a file's sides belong to what is picked when they arrive", async () => {
  const { api, calls } = pendingApi();
  const history = createHistoryStore({ api });
  const shown = history.show("/a");
  calls[0].resolve({ commits: [commit("c1"), commit("c2")], more: false });
  await shown;

  const pickOne = history.select("c1");
  const pickTwo = history.select("c2");
  calls[2].resolve({ id: "c2", files: [{ path: "x.rs", status: "M" }] });
  calls[1].resolve({ id: "c1", files: [{ path: "old.rs", status: "M" }] });
  await Promise.all([pickOne, pickTwo]);
  assert.equal(history.getState().detail.data.id, "c2");

  const file = history.openFile({ path: "x.rs" });
  assert.deepEqual(calls[3].args, ["/a", "c2", "x.rs", ""]);
  const pickBack = history.select("c1");
  calls[3].resolve({ path: "x.rs", before: "a", after: "b" });
  await file;
  assert.equal(history.getState().file.data, null, "the file reply for c2 is dropped once c1 is picked");
  calls[4].resolve({ id: "c1", files: [] });
  await pickBack;
});

test("a reload that no longer lists the picked commit lets go of it", async () => {
  const { api, calls } = pendingApi();
  const history = createHistoryStore({ api });
  const shown = history.show("/a");
  calls[0].resolve({ commits: [commit("c1"), commit("c2")], more: false });
  await shown;
  const pick = history.select("c2");
  calls[1].resolve({ id: "c2", files: [] });
  await pick;
  const narrowed = history.setFilters({ path: "src" });
  calls[2].resolve({ commits: [commit("c1")], more: false });
  await narrowed;
  assert.equal(history.getState().selected, null);
  assert.equal(history.getState().detail.data, null);
});

test("the graph is drawn unless an author or text filter has dropped commits", () => {
  assert.equal(graphApplies(NO_FILTERS), true);
  assert.equal(graphApplies({ ...NO_FILTERS, branch: "x", path: "src" }), true);
  assert.equal(graphApplies({ ...NO_FILTERS, author: "ann" }), false);
  assert.equal(graphApplies({ ...NO_FILTERS, query: "fix" }), false);
});

test("the next page names the commits the first page started from, and starts over when they moved", async () => {
  const { api, calls } = pendingApi();
  const history = createHistoryStore({ api });
  const shown = history.show("/a");
  calls[0].resolve({ commits: [commit("c1"), commit("c2")], more: true, tips: "t1" });
  await shown;
  const more = history.load({ append: true });
  assert.equal(calls[1].args[0].tips, "t1");
  calls[1].resolve({ commits: [], more: false, moved: true, tips: "t2" });
  await settle();
  assert.equal(calls.length, 3, "a moved branch reloads from the top");
  assert.equal(calls[2].args[0].skip, 0);
  assert.equal(calls[2].args[0].tips, "");
  calls[2].resolve({ commits: [commit("c0"), commit("c1")], more: false, tips: "t2" });
  await more;
  await settle();
  assert.deepEqual(history.getState().log.commits.map((entry) => entry.id), ["c0", "c1"]);
});

test("a branch picked for another folder than the one last shown goes to that folder", async () => {
  const { api, calls } = pendingApi();
  const history = createHistoryStore({ api });
  const shown = history.show("/a");
  calls[0].resolve({ commits: [], more: false });
  await shown;
  const picked = history.setFilters({ branch: "topic" }, "/b");
  assert.equal(calls[1].args[0].root, "/b");
  assert.equal(calls[1].args[0].branch, "topic");
  calls[1].resolve({ commits: [commit("b1")], more: false });
  await picked;
  const again = history.show("/b");
  assert.equal(calls[2].args[0].branch, "topic", "showing the same folder keeps the pick");
  calls[2].resolve({ commits: [commit("b1")], more: false });
  await again;
});

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
