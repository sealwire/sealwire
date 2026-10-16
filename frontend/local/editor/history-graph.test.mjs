import test from "node:test";
import assert from "node:assert/strict";

import { layoutGraph } from "./history-graph.js";

const c = (id, ...parents) => ({ id, parents });

test("a straight history is one lane", () => {
  const rows = layoutGraph([c("a", "b"), c("b", "c"), c("c")]);
  assert.deepEqual(rows.map((row) => row.column), [0, 0, 0]);
  assert.deepEqual(rows[0], { column: 0, width: 1, top: [], bottom: [[0, 0]] });
  assert.deepEqual(rows[1].top, [[0, 0]]);
  assert.deepEqual(rows[2].bottom, [], "the first commit ends its lane");
});

test("a merge opens a lane for its second parent and the lanes join at the fork", () => {
  const rows = layoutGraph([c("m", "p", "s"), c("s", "base"), c("p", "base"), c("base")]);
  assert.deepEqual(rows[0].bottom, [[0, 0], [0, 1]]);
  assert.equal(rows[1].column, 1, "the side commit sits in the lane the merge opened");
  assert.deepEqual(rows[1].bottom, [[0, 0], [1, 1]], "main's lane passes the side commit");
  assert.deepEqual(rows[2].bottom, [[1, 1], [0, 0]]);
  assert.deepEqual(rows[3].top, [[0, 0], [1, 0]], "both lanes end in the commit they forked from");
  assert.deepEqual(rows[3].bottom, []);
});

test("a second branch tip takes the next free lane", () => {
  const rows = layoutGraph([c("x", "base"), c("y", "base"), c("base")]);
  assert.deepEqual(rows.map((row) => row.column), [0, 1, 0]);
  assert.equal(rows[1].width, 2);
});

test("a lane freed by a join is reused, and a page that stops early leaves lanes open", () => {
  const rows = layoutGraph([c("x", "base"), c("y", "base"), c("base", "older"), c("z", "older2")]);
  assert.equal(rows[3].column, 1, "the freed lane is taken again");
  assert.deepEqual(rows[3].bottom, [[0, 0], [1, 1]]);
});

test("a merge whose second parent is already waiting in a lane draws into that lane", () => {
  const rows = layoutGraph([c("x", "base"), c("m", "p", "base"), c("p", "base"), c("base")]);
  assert.equal(rows[1].column, 1);
  assert.deepEqual(rows[1].bottom, [[0, 0], [1, 1], [1, 0]]);
});
