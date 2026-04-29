import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildThreadGroups,
  canonicalizeWorkspace,
  findLatestThread,
  summarizeThreadGroups,
} from "./shared/thread-groups.js";
import { ThreadGroupList } from "./shared/thread-list-react.js";

const h = React.createElement;

function renderThreadGroups(groups, props = {}) {
  return renderToStaticMarkup(h(ThreadGroupList, { groups, ...props }));
}

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

test("ThreadGroupList can render selectable groups and preview rows", () => {
  const groups = buildThreadGroups([
    {
      id: "thread-1",
      cwd: "/tmp/demo",
      name: "Primary thread",
      preview: "Fix login flow",
      updated_at: 100,
    },
  ]);

  const markup = renderThreadGroups(groups, {
    activeThreadId: "thread-1",
    selectedCwd: "/tmp/demo/",
    onSelectWorkspace() {},
    includePreview: true,
    formatThreadMeta() {
      return "just now";
    },
  });

  assert.match(markup, /thread-group is-selected-workspace/);
  assert.match(markup, /title="\/tmp\/demo"/);
  assert.match(markup, /conversation-item is-active/);
  assert.match(markup, /Fix login flow/);
  assert.match(markup, /just now/);
});

test("ThreadGroupList can render collapsible groups", () => {
  const groups = buildThreadGroups([
    {
      id: "thread-1",
      cwd: "/tmp/demo",
      name: "Primary thread",
      preview: "Fix login flow",
      updated_at: 100,
    },
  ]);

  const markup = renderThreadGroups(groups, {
    activeThreadId: null,
    collapsible: true,
    collapsedGroupCwds: new Set(["/tmp/demo"]),
  });

  assert.match(markup, /thread-group is-collapsed/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /thread-group-list" hidden/);
});

test("ThreadGroupList allows collapsing the active thread group", () => {
  const groups = buildThreadGroups([
    {
      id: "thread-1",
      cwd: "/tmp/demo",
      name: "Primary thread",
      preview: "Fix login flow",
      updated_at: 100,
    },
  ]);

  const markup = renderThreadGroups(groups, {
    activeThreadId: "thread-1",
    collapsible: true,
    collapsedGroupCwds: new Set(["/tmp/demo"]),
  });

  assert.match(markup, /thread-group is-collapsed/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /conversation-item is-active/);
  assert.match(markup, /thread-group-list" hidden/);
});

test("ThreadGroupList can keep show-more state controlled by the parent", () => {
  const groups = buildThreadGroups(
    Array.from({ length: 12 }, (_, index) => ({
      id: `thread-${index + 1}`,
      cwd: "/tmp/demo",
      name: `Thread ${index + 1}`,
      updated_at: 100 - index,
    }))
  );

  const collapsedMarkup = renderThreadGroups(groups);
  assert.match(collapsedMarkup, /Show 2 more/);
  assert.doesNotMatch(collapsedMarkup, /Thread 11/);

  const expandedMarkup = renderThreadGroups(groups, {
    expandedGroupCwds: new Set(["/tmp/demo"]),
  });
  assert.match(expandedMarkup, /Thread 11/);
  assert.match(expandedMarkup, /Show less/);
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
