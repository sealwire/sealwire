import test from "node:test";
import assert from "node:assert/strict";

import { branchMenuModel } from "./branch-menu-model.js";

const data = {
  current: "main",
  busy: null,
  worktrees: [
    { path: "/repo", branch: "main", is_main: true },
    { path: "/repo/.sealwire/worktrees/feature", branch: "feature", is_main: false },
  ],
  branches: [
    { name: "main", remote: false, worktree: "/repo" },
    { name: "feature", remote: false, worktree: "/repo/.sealwire/worktrees/feature" },
    { name: "topic", remote: false, worktree: null },
    { name: "origin/topic", remote: true, worktree: null },
    { name: "origin/only-remote", remote: true, worktree: null },
  ],
};

test("each branch offers one way in: current, open its worktree, or switch", () => {
  const model = branchMenuModel({ data });
  assert.deepEqual(
    model.local.map((row) => [row.name, row.action]),
    [["main", "current"], ["feature", "open"], ["topic", "switch"]]
  );
  assert.equal(model.local[1].worktree, "/repo/.sealwire/worktrees/feature");
});

test("a remote branch with a local namesake is not offered twice", () => {
  assert.deepEqual(branchMenuModel({ data }).remote.map((row) => row.name), ["origin/only-remote"]);
});

test("while an agent works here, switching carries the reason", () => {
  const model = branchMenuModel({ data: { ...data, busy: "an agent is working here" } });
  assert.equal(model.local[2].switchBlocked, "an agent is working here");
});

test("search narrows every list; a long list is cut until asked", () => {
  assert.deepEqual(branchMenuModel({ data, query: "TOP" }).local.map((row) => row.name), ["topic"]);
  const many = { ...data, branches: Array.from({ length: 30 }, (_, i) => ({ name: `b${i}`, remote: false, worktree: null })) };
  const short = branchMenuModel({ data: many });
  assert.equal(short.local.length, 12);
  assert.equal(short.hidden, 18);
  assert.equal(branchMenuModel({ data: many, showAll: true }).local.length, 30);
});
