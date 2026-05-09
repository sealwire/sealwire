import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThreadGroups,
  canonicalizeWorkspace,
  findLatestThread,
  summarizeThreadGroups,
} from "./shared/thread-groups.js";
import {
  createThreadListUiState,
  createThreadListRows,
  failThreadListRefresh,
  finishThreadListRefresh,
  setThreadListDrawerOpen,
  setThreadListFilterValue,
  setThreadListSelectedCwd,
  startThreadListRefresh,
  toggleThreadListCollapsedGroup,
  toggleThreadListExpandedGroup,
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
    filterValue: " /tmp/demo ",
    selectedCwd: "/tmp/demo/",
  });

  state = toggleThreadListExpandedGroup(state, "/tmp/demo//");
  state = toggleThreadListCollapsedGroup(state, "/tmp/demo//");
  state = setThreadListDrawerOpen(state, true);
  assert.equal(state.selectedCwd, "/tmp/demo/");
  assert.equal(state.filterValue, " /tmp/demo ");
  assert.equal(state.drawerOpen, true);
  assert.deepEqual([...state.expandedGroupCwds], ["/tmp/demo"]);
  assert.deepEqual([...state.collapsedGroupCwds], ["/tmp/demo"]);

  state = setThreadListSelectedCwd(state, "/tmp/next");
  state = setThreadListFilterValue(state, "/tmp/filter");
  state = startThreadListRefresh(state);
  assert.equal(state.selectedCwd, "/tmp/next");
  assert.equal(state.filterValue, "/tmp/filter");
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
  store.getState().setFilterValue("/tmp/filter");
  store.getState().startRefresh();

  let state = readThreadListUi(store);
  assert.equal(state.selectedCwd, "/tmp/demo/");
  assert.equal(state.filterValue, "/tmp/filter");
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
  assert.equal(summarizeThreadGroups(groups), "2 folders · 2 threads");
  assert.equal(summarizeThreadGroups([]), "No saved threads yet.");
});
