import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectWorkerFiles } from "./tauri-worker-files.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// F6: the packaged claude-worker file list must be derived from the source dir,
// not a hardcoded allowlist that silently drifts when a new module is added.
test("selectWorkerFiles: keeps runtime modules, drops tests + fakes", () => {
  const entries = [
    "worker.mjs",
    "protocol.mjs",
    "sdk-mapping.mjs",
    "worker.test.mjs",
    "protocol.test.mjs",
    "fake-claude-worker.mjs",
    "fake-claude-worker-pending-repro.mjs",
    "test-fake-sdk.mjs",
    "package.json",
    "package-lock.json",
    "README.md",
  ];
  const selected = selectWorkerFiles(entries);

  assert.ok(selected.includes("worker.mjs"), "keeps worker.mjs");
  assert.ok(selected.includes("protocol.mjs"), "keeps runtime module");
  assert.ok(selected.includes("package.json"), "keeps package.json");
  assert.ok(selected.includes("package-lock.json"), "keeps lockfile");

  assert.ok(!selected.includes("worker.test.mjs"), "drops *.test.mjs");
  assert.ok(!selected.includes("fake-claude-worker.mjs"), "drops fake-* fixtures");
  assert.ok(!selected.includes("test-fake-sdk.mjs"), "drops test-* fixtures");
  assert.ok(!selected.includes("README.md"), "drops non-runtime files");
});

// Regression guard: whatever the previous hardcoded allowlist shipped, the
// derived list must still cover every real module the worker imports today.
test("selectWorkerFiles: covers the actual claude-worker source tree", () => {
  const entries = readdirSync(path.join(repoRoot, "claude-worker"));
  const selected = selectWorkerFiles(entries);
  const previouslyShipped = [
    "ask-user-question.mjs",
    "file-diff.mjs",
    "package-lock.json",
    "package.json",
    "permissions.mjs",
    "progress-tracker.mjs",
    "protocol.mjs",
    "sdk-mapping.mjs",
    "session-options.mjs",
    "session-page.mjs",
    "worker.mjs",
  ];
  for (const file of previouslyShipped) {
    assert.ok(selected.includes(file), `must still ship ${file}`);
  }
  for (const file of selected) {
    assert.ok(
      !file.endsWith(".test.mjs") && !file.startsWith("fake-") && !file.startsWith("test-"),
      `must not ship fixture ${file}`,
    );
  }
});
