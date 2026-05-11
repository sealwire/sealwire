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
    { cwd: "/tmp/root-a", label: "root-a (1 threads)" },
    { cwd: "/tmp/history", label: "history (1 threads)" },
    { cwd: "/tmp/root-b", label: "Allowed root" },
  ]);
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
    { cwd: "/tmp/history", label: "history (1 threads)" },
    { cwd: "/tmp/root-a", label: "Allowed root" },
  ]);
});
