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
