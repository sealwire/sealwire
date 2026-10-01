import test from "node:test";
import assert from "node:assert/strict";

import { offerProjectUndo } from "./project-undo.js";

test("an empty project's delete offers an Undo that brings the name back", async () => {
  const shown = [];
  const recreated = [];
  const offered = offerProjectUndo({
    name: "神仙教母",
    sessionCount: 0,
    recreate: (name) => recreated.push(name),
    showUndo: (toast) => shown.push(toast),
  });
  assert.equal(offered, true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].message, "Deleted project “神仙教母”.");
  await shown[0].onUndo();
  assert.deepEqual(recreated, ["神仙教母"]);
});

// A project with members was confirmed first, and recreating it could not put its
// members back — an Undo there would promise what it cannot do.
test("a project that had sessions gets no Undo", () => {
  const shown = [];
  assert.equal(
    offerProjectUndo({ name: "x", sessionCount: 2, recreate() {}, showUndo: (t) => shown.push(t) }),
    false
  );
  assert.deepEqual(shown, []);
});

// The note outlives the place it was raised in — on remote, another relay can be chosen
// while it is up. Undoing there would create the project on the wrong relay.
test("an Undo that is no longer about where you are does nothing", async () => {
  let shown = null;
  const recreated = [];
  let here = "relay-a";
  offerProjectUndo({
    name: "Ops",
    sessionCount: 0,
    isStillCurrent: () => here === "relay-a",
    recreate: (name) => recreated.push(name),
    showUndo: (toast) => {
      shown = toast;
    },
  });
  here = "relay-b";
  await shown.onUndo();
  assert.deepEqual(recreated, [], "nothing is created on the relay you moved to");

  here = "relay-a";
  await shown.onUndo();
  assert.deepEqual(recreated, ["Ops"]);
});
