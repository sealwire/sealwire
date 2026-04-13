import test from "node:test";
import assert from "node:assert/strict";

import {
  buildThreadGroups,
  canonicalizeWorkspace,
  findLatestThread,
  renderThreadGroupsMarkup,
  summarizeThreadGroups,
} from "./shared/thread-groups.js";

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

test("renderThreadGroupsMarkup can render selectable groups and preview rows", () => {
  const groups = buildThreadGroups([
    {
      id: "thread-1",
      cwd: "/tmp/demo",
      name: "Primary thread",
      preview: "Fix login flow",
      updated_at: 100,
    },
  ]);

  const markup = renderThreadGroupsMarkup(groups, {
    activeThreadId: "thread-1",
    selectedCwd: "/tmp/demo/",
    selectWorkspaceAttrName: "data-select-workspace",
    includePreview: true,
    formatThreadMeta() {
      return "just now";
    },
  });

  assert.match(markup, /thread-group is-selected-workspace/);
  assert.match(markup, /data-select-workspace="\/tmp\/demo"/);
  assert.match(markup, /conversation-item is-active/);
  assert.match(markup, /Fix login flow/);
  assert.match(markup, /just now/);
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
