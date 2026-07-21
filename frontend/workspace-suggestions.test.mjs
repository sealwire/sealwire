import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkspaceSuggestions,
  selectWorkspaceSuggestionsModel,
} from "./shared/workspace-suggestions.js";

test("buildWorkspaceSuggestions merges selected cwd, session cwd, threads, and allowed roots", () => {
  const suggestions = buildWorkspaceSuggestions({
    allowedRoots: ["/tmp/root-a", "/tmp/root-b/"],
    currentCwd: "/tmp/current",
    selectedCwd: "/tmp/draft/",
    threads: [
      { cwd: "/tmp/current/", id: "thread-1", preview: "", updated_at: 2 },
      { cwd: "/tmp/history", id: "thread-2", preview: "", updated_at: 1 },
      { cwd: "/tmp/root-a", id: "thread-3", preview: "", updated_at: 3 },
    ],
  });

  assert.deepEqual(suggestions, [
    { cwd: "/tmp/draft", label: "Selected workspace" },
    { cwd: "/tmp/current", label: "Current session" },
    { cwd: "/tmp/root-a", label: "root-a (1 session)" },
    { cwd: "/tmp/history", label: "history (1 session)" },
    { cwd: "/tmp/root-b", label: "Allowed root" },
  ]);
});

test("workspace suggestion session counts pluralize (1 session vs N sessions)", () => {
  const suggestions = buildWorkspaceSuggestions({
    allowedRoots: [],
    currentCwd: "",
    selectedCwd: "",
    threads: [
      { cwd: "/tmp/solo", id: "a", preview: "", updated_at: 1 },
      { cwd: "/tmp/multi", id: "b", preview: "", updated_at: 2 },
      { cwd: "/tmp/multi", id: "c", preview: "", updated_at: 3 },
    ],
  });
  const labels = Object.fromEntries(suggestions.map((s) => [s.cwd, s.label]));
  assert.equal(labels["/tmp/solo"], "solo (1 session)");
  assert.equal(labels["/tmp/multi"], "multi (2 sessions)");
});

test("selectWorkspaceSuggestionsModel maps session fields into shared suggestions", () => {
  const suggestions = selectWorkspaceSuggestionsModel({
    session: {
      allowed_roots: ["/tmp/root-a/"],
      current_cwd: "/tmp/current/",
    },
    selectedCwd: "/tmp/draft",
    threads: [
      { cwd: "/tmp/history", id: "thread-1", preview: "", updated_at: 1 },
    ],
  });

  assert.deepEqual(suggestions, [
    { cwd: "/tmp/draft", label: "Selected workspace" },
    { cwd: "/tmp/current", label: "Current session" },
    { cwd: "/tmp/history", label: "history (1 session)" },
    { cwd: "/tmp/root-a", label: "Allowed root" },
  ]);
});
