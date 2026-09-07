import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThreadGroups,
  canonicalizeWorkspace,
  findLatestThread,
  summarizeThreadGroups,
  UNASSIGNED_PROJECT_KEY,
} from "./shared/thread-groups.js";
import {
  createThreadListUiState,
  createThreadListRows,
  failThreadListRefresh,
  finishThreadListRefresh,
  setThreadListDrawerOpen,
  setThreadListSelectedCwd,
  startThreadListRefresh,
  toggleThreadListCollapsedGroup,
  toggleThreadListExpandedGroup,
  visibleThreadIds,
} from "./shared/thread-list-state.js";
import {
  createThreadListStore,
  readThreadListContextMenu,
  readThreadListUi,
} from "./shared/thread-list-store.js";

test("buildThreadGroups sorts groups by latest activity and threads by recency", () => {
  const groups = buildThreadGroups([
    {
      id: "thread-root-old",
      cwd: "/tmp/work/root",
      preview: "root old",
      updated_at: 10,
    },
    {
      id: "thread-nested-new",
      cwd: "/tmp/work/root/nested",
      preview: "nested new",
      updated_at: 30,
    },
    {
      id: "thread-nested-old",
      cwd: "/tmp/work/root/nested/",
      preview: "nested old",
      updated_at: 20,
    },
  ]);

  assert.deepEqual(
    groups.map((group) => group.cwd),
    ["/tmp/work/root/nested", "/tmp/work/root"]
  );
  assert.deepEqual(
    groups[0].threads.map((thread) => thread.id),
    ["thread-nested-new", "thread-nested-old"]
  );
  assert.equal(groups[0].label, "nested");
});

// The sidebar is a PASSIVE surface: it renders because a session exists, not because
// anyone asked about a workspace. Most workspaces are legitimately ungranted and nothing
// about the session is blocked by it, so a tag here would sit on most rows forever — and
// a badge everyone learns to ignore spends exactly the attention the in-context offer
// (diff panel / review dialog) needs. The grouping therefore carries no trust state at
// all: there is nothing here for a renderer to be tempted by.
test("a workspace group carries no trust state — the sidebar has nothing to warn about", () => {
  const [group] = buildThreadGroups([
    {
      id: "thread-1",
      cwd: "/tmp/work/ungranted",
      preview: "x",
      updated_at: 1,
      workspace_trusted: false,
    },
  ]);

  assert.equal(group.cwd, "/tmp/work/ungranted");
  assert.equal(
    Object.keys(group).some((key) => /restrict|trust/i.test(key)),
    false,
    `a passive group must carry no trust flag; got ${Object.keys(group).join(", ")}`
  );
});

test("buildThreadGroups project mode groups by project_id with a single Unassigned bucket", () => {
  const threads = [
    { id: "t1", cwd: "/a/repo", updated_at: 30 },
    { id: "t2", cwd: "/a/repo", updated_at: 20 },
    { id: "t3", cwd: "/b/repo", updated_at: 25 }, // no project, cwd /b
    { id: "t4", cwd: "/c/repo", updated_at: 10 }, // no project, cwd /c
  ];
  const groups = buildThreadGroups(threads, {
    groupBy: "project",
    projects: [{ id: "proj_a", name: "Sealwire" }],
    threadProjectId: { t1: "proj_a", t2: "proj_a" },
  });

  const byKey = new Map(groups.map((group) => [group.key, group]));
  assert.equal(byKey.get("proj_a").label, "Sealwire");
  assert.deepEqual(
    byKey.get("proj_a").threads.map((thread) => thread.id),
    ["t1", "t2"]
  );
  // t3 + t4 have no project and DIFFERENT cwds → ONE Unassigned bucket (not split).
  const unassigned = byKey.get(UNASSIGNED_PROJECT_KEY);
  assert.equal(unassigned.label, "Unassigned");
  assert.deepEqual(
    unassigned.threads.map((thread) => thread.id).sort(),
    ["t3", "t4"]
  );
  assert.equal(groups.length, 2);
});

test("buildThreadGroups project mode seeds empty projects and folds orphans into Unassigned", () => {
  const groups = buildThreadGroups([{ id: "t1", cwd: "/x", updated_at: 5 }], {
    groupBy: "project",
    projects: [
      { id: "proj_a", name: "Alpha" },
      { id: "proj_empty", name: "Empty" },
    ],
    // t1 points at a project that no longer exists → treated as Unassigned.
    threadProjectId: { t1: "proj_gone" },
  });

  const byKey = new Map(groups.map((group) => [group.key, group]));
  assert.ok(byKey.has("proj_empty"), "an empty project still appears (navigable)");
  assert.equal(byKey.get("proj_empty").threads.length, 0);
  assert.deepEqual(
    byKey.get(UNASSIGNED_PROJECT_KEY).threads.map((thread) => thread.id),
    ["t1"]
  );
  assert.ok(!byKey.has("proj_gone"), "an orphan membership never creates a raw-id group");
});

test("summarizeThreadGroups counts real projects, not the Unassigned bucket", () => {
  // One real project + one session in it.
  const one = buildThreadGroups([{ id: "t1", cwd: "/x", updated_at: 1 }], {
    groupBy: "project",
    projects: [{ id: "p", name: "P" }],
    threadProjectId: { t1: "p" },
  });
  assert.equal(summarizeThreadGroups(one, { groupBy: "project" }), "1 project · 1 session");

  // Unassigned-only: no real projects → "0 projects" (the bucket is not a project).
  const unassignedOnly = buildThreadGroups(
    [
      { id: "t1", cwd: "/x", updated_at: 1 },
      { id: "t2", cwd: "/y", updated_at: 2 },
    ],
    { groupBy: "project", projects: [], threadProjectId: {} }
  );
  assert.equal(
    summarizeThreadGroups(unassignedOnly, { groupBy: "project" }),
    "0 projects · 2 sessions"
  );

  // One real project PLUS Unassigned → still "1 project" (bucket excluded).
  const mixed = buildThreadGroups(
    [
      { id: "t1", cwd: "/x", updated_at: 1 },
      { id: "t2", cwd: "/y", updated_at: 2 },
    ],
    { groupBy: "project", projects: [{ id: "p", name: "P" }], threadProjectId: { t1: "p" } }
  );
  assert.equal(summarizeThreadGroups(mixed, { groupBy: "project" }), "1 project · 2 sessions");
});

test("createThreadListRows keys on the neutral project group key", () => {
  const groups = buildThreadGroups([{ id: "t1", cwd: "/x", updated_at: 1 }], {
    groupBy: "project",
    projects: [{ id: "proj_a", name: "A" }],
    threadProjectId: { t1: "proj_a" },
  });
  const rows = createThreadListRows({ groups, collapsible: true });
  const groupRow = rows.find((row) => row.type === "group");
  assert.equal(groupRow.key, "group:proj_a");
  assert.equal(groupRow.normalizedCwd, "proj_a");
});

// @deprecated along with findLatestThread itself — see thread-groups.js. Its only
// caller went away with the "Continue latest" button, so this test is now the sole
// thing keeping the function alive. Delete both together at the next cleanup pass.
test("findLatestThread respects preferred workspace when available", () => {
  const threads = [
    { id: "thread-a", cwd: "/tmp/a", updated_at: 20 },
    { id: "thread-b", cwd: "/tmp/b/", updated_at: 10 },
  ];

  assert.equal(findLatestThread(threads, "/tmp/b")?.id, "thread-b");
  assert.equal(findLatestThread(threads, "")?.id, "thread-a");
  assert.equal(findLatestThread([], "/tmp/b"), null);
});

test("thread list UI state normalizes shared local and remote controls", () => {
  let state = createThreadListUiState({
    selectedCwd: "/tmp/demo/",
  });

  state = toggleThreadListExpandedGroup(state, "/tmp/demo//");
  state = toggleThreadListCollapsedGroup(state, "/tmp/demo//");
  state = setThreadListDrawerOpen(state, true);
  assert.equal(state.selectedCwd, "/tmp/demo/");
  assert.equal(state.drawerOpen, true);
  assert.deepEqual([...state.expandedGroupCwds], ["/tmp/demo"]);
  assert.deepEqual([...state.collapsedGroupCwds], ["/tmp/demo"]);

  state = setThreadListSelectedCwd(state, "/tmp/next");
  state = startThreadListRefresh(state);
  assert.equal(state.selectedCwd, "/tmp/next");
  assert.equal(state.loading, true);
  assert.equal(state.error, null);

  state = failThreadListRefresh(state, "network failed");
  assert.equal(state.loading, false);
  assert.equal(state.error, "network failed");

  state = finishThreadListRefresh(startThreadListRefresh(state));
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
});

test("thread list store owns shared local and remote UI actions", () => {
  const store = createThreadListStore({
    selectedCwd: "/tmp/demo/",
  });

  store.getState().toggleExpandedGroup("/tmp/demo//");
  store.getState().toggleCollapsedGroup("/tmp/demo//");
  store.getState().setDrawerOpen(true);
  store.getState().startRefresh();

  let state = readThreadListUi(store);
  assert.equal(state.selectedCwd, "/tmp/demo/");
  assert.equal(state.drawerOpen, true);
  assert.equal(state.loading, true);
  assert.deepEqual([...state.expandedGroupCwds], ["/tmp/demo"]);
  assert.deepEqual([...state.collapsedGroupCwds], ["/tmp/demo"]);

  store.getState().failRefresh("timed out");
  state = readThreadListUi(store);
  assert.equal(state.loading, false);
  assert.equal(state.error, "timed out");

  store.getState().setSelectedCwd("/tmp/next");
  store.getState().openContextMenu("thread-1", 42, 84);
  store.getState().clearError();
  state = readThreadListUi(store);
  assert.equal(state.selectedCwd, "/tmp/next");
  assert.equal(state.error, null);
  assert.deepEqual(readThreadListContextMenu(store), {
    clientX: 42,
    clientY: 84,
    threadId: "thread-1",
  });

  store.getState().closeContextMenu();
  assert.equal(readThreadListContextMenu(store).threadId, null);
});

test("createThreadListRows flattens groups for virtual rendering", () => {
  const groups = buildThreadGroups(
    Array.from({ length: 12 }, (_, index) => ({
      id: `thread-${index + 1}`,
      cwd: "/tmp/demo",
      name: `Thread ${index + 1}`,
      updated_at: 100 - index,
    }))
  );

  const collapsedRows = createThreadListRows({
    groups,
    visibleThreadLimit: 10,
  });
  assert.equal(collapsedRows.length, 12);
  assert.equal(collapsedRows[0].type, "group");
  assert.equal(collapsedRows.at(-1).type, "show-more");
  assert.equal(collapsedRows.at(-1).hiddenCount, 2);

  const expandedRows = createThreadListRows({
    expandedGroupCwds: new Set(["/tmp/demo"]),
    groups,
    visibleThreadLimit: 10,
  });
  assert.equal(expandedRows.length, 14);
  assert.equal(expandedRows.at(-1).type, "show-less");

  const groupOnlyRows = createThreadListRows({
    collapsedGroupCwds: new Set(["/tmp/demo"]),
    collapsible: true,
    groups,
  });
  assert.deepEqual(groupOnlyRows.map((row) => row.type), ["group"]);
});

test("summarizeThreadGroups and canonicalizeWorkspace produce stable display values", () => {
  const groups = buildThreadGroups([
    { id: "thread-1", cwd: "/tmp/demo/", updated_at: 1 },
    { id: "thread-2", cwd: "/tmp/demo/nested", updated_at: 2 },
  ]);

  assert.equal(canonicalizeWorkspace("/tmp/demo///"), "/tmp/demo");
  assert.equal(summarizeThreadGroups(groups), "2 folders · 2 sessions");
  assert.equal(summarizeThreadGroups([]), "No saved sessions yet.");
});

// --- the pinned group's header row, and the three states that could strand it -------

const pinnedGroup = (threadCount) => ({
  key: "proj_a",
  cwd: "",
  projectId: "proj_a",
  pinned: true,
  label: "Pinned",
  threads: Array.from({ length: threadCount }, (_, index) => ({
    id: `t${index}`,
    updated_at: threadCount - index,
  })),
});

const cwdGroup = {
  key: "/work/a",
  cwd: "/work/a",
  label: "a",
  threads: [{ id: "other", updated_at: 1 }],
};

test("hidePinnedGroupHeader drops the pinned group's header row and keeps its sessions", () => {
  const groups = [pinnedGroup(2), cwdGroup];
  const withHeader = createThreadListRows({ groups, collapsible: true });
  const without = createThreadListRows({ groups, collapsible: true, hidePinnedGroupHeader: true });

  // Positive control: the flag has to remove something that was there.
  assert.equal(
    withHeader.filter((row) => row.type === "group").length,
    2,
    "precondition: both groups normally emit a header"
  );
  assert.deepEqual(
    without.filter((row) => row.type === "group").map((row) => row.normalizedCwd),
    ["/work/a"],
    "only the pinned group loses its header"
  );
  assert.deepEqual(
    without.filter((row) => row.type === "thread").map((row) => row.thread.id),
    ["t0", "t1", "other"],
    "and every session is still listed, in order"
  );
});

// The disclosure control lives ON the header. A headerless group that honoured a
// remembered collapse would hide its sessions with nothing on screen to bring them
// back — and the collapsed set is persisted, so it would stay that way across reloads.
test("a headerless pinned group cannot be stranded by a remembered collapse", () => {
  const rows = createThreadListRows({
    groups: [pinnedGroup(2)],
    collapsible: true,
    collapsedGroupCwds: new Set(["proj_a"]),
    hidePinnedGroupHeader: true,
  });

  assert.deepEqual(
    rows.map((row) => row.type),
    ["thread", "thread"],
    "its sessions render regardless of the collapsed set"
  );
});

test("an EMPTY pinned group contributes no rows at all rather than a bare header", () => {
  const rows = createThreadListRows({
    groups: [pinnedGroup(0), cwdGroup],
    collapsible: true,
    hidePinnedGroupHeader: true,
  });

  assert.deepEqual(rows.map((row) => row.key), ["group:/work/a", "thread:other"]);
});

// The "show more" row is emitted per group and keyed on the group, not on the header.
// Losing the header must not lose the overflow control with it.
test("a headerless pinned group past the visible limit still offers show-more", () => {
  const rows = createThreadListRows({
    groups: [pinnedGroup(12)],
    collapsible: true,
    hidePinnedGroupHeader: true,
    visibleThreadLimit: 10,
  });

  assert.equal(rows.filter((row) => row.type === "group").length, 0, "no header");
  assert.equal(rows.filter((row) => row.type === "thread").length, 10, "capped at the limit");
  const more = rows.find((row) => row.type === "show-more");
  assert.ok(more, "and the overflow row survives");
  assert.equal(more.hiddenCount, 2);
});

// Shift+click ranges over the rows the user can actually SEE, and the list is
// virtualized — the off-screen rows are not in the DOM to be read back. So the
// range order has to be derived from the same rows the list renders, which is
// what this function is for.
test("visibleThreadIds follows the rendered row order across groups", () => {
  const groups = buildThreadGroups(
    [
      { id: "t1", cwd: "/x", updated_at: 3 },
      { id: "t2", cwd: "/x", updated_at: 2 },
      { id: "t3", cwd: "/y", updated_at: 1 },
    ],
    {}
  );
  const rows = createThreadListRows({ groups, collapsible: true });
  assert.deepEqual(visibleThreadIds(rows), ["t1", "t2", "t3"]);
});

test("visibleThreadIds skips a collapsed group's sessions", () => {
  const groups = buildThreadGroups(
    [
      { id: "t1", cwd: "/x", updated_at: 2 },
      { id: "t2", cwd: "/y", updated_at: 1 },
    ],
    {}
  );
  const rows = createThreadListRows({
    groups,
    collapsible: true,
    collapsedGroupCwds: new Set([canonicalizeWorkspace("/x")]),
  });
  assert.deepEqual(visibleThreadIds(rows), ["t2"]);
});

test("visibleThreadIds stops at the per-group limit until the group is expanded", () => {
  const threads = Array.from({ length: 4 }, (_, index) => ({
    id: `t${index + 1}`,
    cwd: "/x",
    updated_at: 100 - index,
  }));
  const groups = buildThreadGroups(threads, {});

  assert.deepEqual(
    visibleThreadIds(createThreadListRows({ groups, visibleThreadLimit: 2 })),
    ["t1", "t2"],
    "a session hidden behind Show more cannot be in a range"
  );
  assert.deepEqual(
    visibleThreadIds(
      createThreadListRows({
        groups,
        visibleThreadLimit: 2,
        expandedGroupCwds: new Set([canonicalizeWorkspace("/x")]),
      })
    ),
    ["t1", "t2", "t3", "t4"]
  );
});
