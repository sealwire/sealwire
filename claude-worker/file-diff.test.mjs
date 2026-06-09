import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  createFileDiffTracker,
  fileChangeFromToolInput,
} from "./file-diff.mjs";

test("fileChangeFromToolInput synthesizes an edit diff from Claude Edit input", () => {
  const change = fileChangeFromToolInput("Edit", {
    file_path: "frontend/styles.css",
    old_string: "padding-left: 26px;",
    new_string: "padding-left: 0;",
  });

  assert.equal(change.path, "frontend/styles.css");
  assert.equal(change.change_type, "modify");
  assert.match(change.diff, /diff --git a\/frontend\/styles\.css b\/frontend\/styles\.css/);
  assert.match(change.diff, /-padding-left: 26px;/);
  assert.match(change.diff, /\+padding-left: 0;/);
});

test("createFileDiffTracker captures the real before and after file contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-diff-"));
  try {
    await fs.writeFile(path.join(root, "style.css"), "a {\n  color: red;\n}\n");
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "Edit",
      args: {
        file_path: "style.css",
        old_string: "color: red",
        new_string: "color: blue",
      },
    });
    await fs.writeFile(path.join(root, "style.css"), "a {\n  color: blue;\n}\n");
    const event = await tracker.enrichResult({
      type: "tool_call_result",
      id: "tool-1",
      content: "updated",
    });

    assert.equal(event.tool.item_type, "fileChange");
    assert.equal(event.tool.file_changes[0].path, "style.css");
    assert.match(event.tool.diff, /-  color: red;/);
    assert.match(event.tool.diff, /\+  color: blue;/);
    assert.equal(event.tool.result_preview, "updated");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("live Claude file diffs can be reapplied and rolled back with git apply", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-apply-"));
  const oldContent = "a {\n  color: red;\n}\n";
  const newContent = "a {\n  color: blue;\n}\n";
  try {
    await fs.writeFile(path.join(root, "style.css"), oldContent);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "Edit",
      args: {
        file_path: "style.css",
        old_string: "color: red",
        new_string: "color: blue",
      },
    });
    await fs.writeFile(path.join(root, "style.css"), newContent);
    const event = await tracker.enrichResult({
      type: "tool_call_result",
      id: "tool-1",
      content: "updated",
    });
    const diff = event.tool.diff;

    await fs.writeFile(path.join(root, "style.css"), oldContent);
    await gitApply(root, diff);
    assert.equal(await fs.readFile(path.join(root, "style.css"), "utf8"), newContent);

    await gitApply(root, diff, ["--reverse"]);
    assert.equal(await fs.readFile(path.join(root, "style.css"), "utf8"), oldContent);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a single-line edit in a large file produces a minimal one-hunk diff", async () => {
  const before = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 200", "line 200 CHANGED");
  const diff = await diffFromEdit(before, after);

  const { added, removed } = countDiffLines(diff);
  assert.equal(added, 1, "exactly one added line");
  assert.equal(removed, 1, "exactly one removed line");
  assert.equal((diff.match(/^@@ /gm) || []).length, 1, "exactly one hunk");
  assert.match(diff, /^-line 200$/m);
  assert.match(diff, /^\+line 200 CHANGED$/m);
  // Surrounding lines are emitted as context (space prefix), not as churn.
  assert.match(diff, /^ line 199$/m);
  assert.match(diff, /^ line 201$/m);
});

test("nearby edits coalesce into one hunk; distant edits split into two", async () => {
  const before = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n") + "\n";

  const near = before.replace("L5\n", "L5x\n").replace("L7\n", "L7x\n");
  const nearDiff = await diffFromEdit(before, near);
  assert.equal((nearDiff.match(/^@@ /gm) || []).length, 1, "two close edits share one hunk");

  const distant = before.replace("L5\n", "L5x\n").replace("L25\n", "L25x\n");
  const distantDiff = await diffFromEdit(before, distant);
  assert.equal((distantDiff.match(/^@@ /gm) || []).length, 2, "two far edits are two hunks");
});

test("pure add and pure delete carry the right headers", async () => {
  const addDiff = await diffFromEdit(null, "alpha\nbeta\n", "added.txt");
  assert.match(addDiff, /new file mode 100644/);
  assert.match(addDiff, /^--- \/dev\/null$/m);
  assert.match(addDiff, /^\+\+\+ b\/added\.txt$/m);
  const addCounts = countDiffLines(addDiff);
  assert.equal(addCounts.added, 2);
  assert.equal(addCounts.removed, 0);

  const delDiff = await diffFromEdit("alpha\nbeta\n", null, "gone.txt");
  assert.match(delDiff, /deleted file mode 100644/);
  assert.match(delDiff, /^--- a\/gone\.txt$/m);
  assert.match(delDiff, /^\+\+\+ \/dev\/null$/m);
  const delCounts = countDiffLines(delDiff);
  assert.equal(delCounts.added, 0);
  assert.equal(delCounts.removed, 2);
});

test("a multi-hunk minimal diff round-trips through git apply", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-multihunk-"));
  const before = Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
  const after = before.replace("L5\n", "L5x\n").replace("L25\n", "L25x\n");
  try {
    await fs.writeFile(path.join(root, "f.txt"), before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "Edit",
      args: { file_path: "f.txt" },
    });
    await fs.writeFile(path.join(root, "f.txt"), after);
    const event = await tracker.enrichResult({ type: "tool_call_result", id: "tool-1", content: "ok" });
    const diff = event.tool.diff;
    assert.equal((diff.match(/^@@ /gm) || []).length, 2, "diff has two hunks");

    await fs.writeFile(path.join(root, "f.txt"), before);
    await gitApply(root, diff);
    assert.equal(await fs.readFile(path.join(root, "f.txt"), "utf8"), after);

    await gitApply(root, diff, ["--reverse"]);
    assert.equal(await fs.readFile(path.join(root, "f.txt"), "utf8"), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Drive the real before/after capture path of createFileDiffTracker and return
// the resulting unified diff. Pass null for before (a create) or after (a delete).
async function diffFromEdit(before, after, fileName = "file.txt") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-diffhelper-"));
  const abs = path.join(root, fileName);
  try {
    if (before !== null) await fs.writeFile(abs, before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: before === null ? "Write" : "Edit",
      args: { file_path: fileName },
    });
    if (after !== null) await fs.writeFile(abs, after);
    else await fs.rm(abs, { force: true });
    const event = await tracker.enrichResult({ type: "tool_call_result", id: "tool-1", content: "ok" });
    return event.tool ? event.tool.diff : "";
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

function gitApply(cwd, diff, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn", ...args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `git apply exited with ${code}`));
      }
    });
    child.stdin.end(diff);
  });
}
