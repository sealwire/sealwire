import assert from "node:assert/strict";
import test from "node:test";
import { cacheViewedThread, getCachedViewedThread } from "./viewed-thread-cache.js";

test("recently viewed threads stay cached within a ten-thread memory limit", () => {
  const state = {};
  for (let index = 0; index < 10; index++) cacheViewedThread(state, `t${index}`, { index });
  assert.equal(getCachedViewedThread(state, "t0").index, 0);
  cacheViewedThread(state, "t10", { index: 10 });
  assert.equal(getCachedViewedThread(state, "t1"), null);
  assert.equal(getCachedViewedThread(state, "t0").index, 0);
  assert.equal(state.viewedThreadCache.threads.size, 10);
});

test("changing relay or device identity cannot restore the previous identity's messages", () => {
  const state = {};
  cacheViewedThread(state, "same-id", { text: "private" }, { scope: "relay-a:device-a", generation: "run" });
  assert.equal(getCachedViewedThread(state, "same-id", { scope: "relay-a:device-b", generation: "run" }), null);
  cacheViewedThread(state, "same-id", { text: "private" }, { scope: "relay-a:device-b", generation: "run" });
  assert.equal(getCachedViewedThread(state, "same-id", { scope: "relay-b:device-b", generation: "run" }), null);
});
