import { test } from "node:test";
import assert from "node:assert/strict";

import { computeChangeStats } from "./workspace-diff.js";

test("computeChangeStats returns zero stats for null data", () => {
  const stats = computeChangeStats(null);
  assert.equal(stats.fileCount, 0);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

test("computeChangeStats counts +/- lines per file change, ignoring file headers", () => {
  const stats = computeChangeStats({
    file_changes: [
      {
        path: "a.txt",
        change_type: "update",
        diff: [
          "diff --git a/a.txt b/a.txt",
          "--- a/a.txt",
          "+++ b/a.txt",
          "@@ -1,2 +1,3 @@",
          "-old",
          "+new",
          "+extra",
        ].join("\n"),
      },
      {
        path: "b.txt",
        change_type: "add",
        diff: [
          "diff --git a/b.txt b/b.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/b.txt",
          "@@ -0,0 +1,1 @@",
          "+hello",
        ].join("\n"),
      },
    ],
  });
  assert.equal(stats.fileCount, 2);
  assert.equal(stats.added, 3);
  assert.equal(stats.removed, 1);
});

test("computeChangeStats handles file changes with empty diff strings", () => {
  const stats = computeChangeStats({
    file_changes: [
      { path: "x.bin", change_type: "add", diff: "" },
    ],
  });
  assert.equal(stats.fileCount, 1);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});
