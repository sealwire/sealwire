import test from "node:test";
import assert from "node:assert/strict";

import { buildThreadActivityMap } from "./shared/thread-activity.js";

test("buildThreadActivityMap keys working threads by id", () => {
  const map = buildThreadActivityMap({
    thread_activity: [
      { thread_id: "a", phase: "tool", tool: "Bash" },
      { thread_id: "b", phase: null, tool: null },
    ],
  });

  assert.equal(map.size, 2);
  assert.deepEqual(map.get("a"), { phase: "tool", tool: "Bash" });
  assert.deepEqual(map.get("b"), { phase: null, tool: null });
});

test("buildThreadActivityMap tolerates missing or malformed activity", () => {
  assert.equal(buildThreadActivityMap(undefined).size, 0);
  assert.equal(buildThreadActivityMap(null).size, 0);
  assert.equal(buildThreadActivityMap({}).size, 0);
  assert.equal(buildThreadActivityMap({ thread_activity: "nope" }).size, 0);
});

test("buildThreadActivityMap skips entries without an id and defaults nullish fields", () => {
  const map = buildThreadActivityMap({
    thread_activity: [
      { phase: "tool" }, // no thread_id -> skipped
      { thread_id: "c" }, // missing phase/tool -> null
    ],
  });

  assert.equal(map.size, 1);
  assert.deepEqual(map.get("c"), { phase: null, tool: null });
});
