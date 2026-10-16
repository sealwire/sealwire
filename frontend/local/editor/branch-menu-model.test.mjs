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

const backups = ["20261013-131652", "20261012-211723", "20261009-225849", "20261006-082327"].map((stamp) => ({
  name: `backup/main-before-daytime-rewrite-${stamp}`,
  remote: false,
  worktree: null,
}));

test("branches sharing a prefix fold into one row that opens to show them by what tells them apart", () => {
  const model = branchMenuModel({ data: { ...data, branches: [...data.branches, ...backups] } });
  const group = model.local.find((row) => row.kind === "group");
  assert.equal(group.prefix, "backup/");
  assert.equal(group.count, 4);
  assert.equal(group.open, false);
  assert.ok(!model.local.some((row) => row.name?.startsWith("backup/")), "folded rows are not listed");
  const opened = branchMenuModel({ data: { ...data, branches: [...data.branches, ...backups] }, openGroups: ["backup/"] });
  const rows = opened.local.filter((row) => row.name?.startsWith("backup/"));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].label, "main-before-daytime-rewrite-20261013-131652", "the shared prefix is not repeated");
  const searched = branchMenuModel({ data: { ...data, branches: [...data.branches, ...backups] }, query: "131652" });
  assert.deepEqual(searched.local.map((row) => row.name), ["backup/main-before-daytime-rewrite-20261013-131652"]);
});

test("a long worktree list is cut until asked, and two folders with one name are told apart", () => {
  const trees = Array.from({ length: 9 }, (_, i) => ({ path: `/w/t${i}`, branch: `b${i}`, is_main: false }));
  const twins = [
    { path: "/Users/me/git/agent-relay", branch: "main", is_main: true },
    { path: "/Users/me/git/voice-lookup/agent-relay", branch: null, is_main: false },
  ];
  const model = branchMenuModel({ data: { ...data, worktrees: [...twins, ...trees] } });
  assert.equal(model.worktrees.length, 5);
  assert.equal(model.hiddenWorktrees, 6);
  assert.equal(branchMenuModel({ data: { ...data, worktrees: [...twins, ...trees] }, showAllWorktrees: true }).worktrees.length, 11);
  assert.deepEqual(
    model.worktrees.slice(0, 2).map((tree) => tree.label),
    ["agent-relay (git)", "agent-relay (voice-lookup)"]
  );
});

test("the folder on screen stays in a cut worktree list", () => {
  const trees = Array.from({ length: 9 }, (_, i) => ({ path: `/w/t${i}`, branch: `b${i}`, is_main: false }));
  const model = branchMenuModel({ data: { ...data, worktrees: trees }, root: "/w/t8" });
  assert.ok(model.worktrees.some((tree) => tree.path === "/w/t8"));
  assert.equal(model.worktrees.length, 5);
});
