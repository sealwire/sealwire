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

test("a created file carries new-file headers; a vanished re-read is never a fabricated deletion", async () => {
  const addDiff = await diffFromEdit(null, "alpha\nbeta\n", "added.txt");
  assert.match(addDiff, /new file mode 100644/);
  assert.match(addDiff, /^--- \/dev\/null$/m);
  assert.match(addDiff, /^\+\+\+ b\/added\.txt$/m);
  const addCounts = countDiffLines(addDiff);
  assert.equal(addCounts.added, 2);
  assert.equal(addCounts.removed, 0);

  // An edit-type tool never deletes a file. A re-read that finds the file gone
  // with no reconstructable input must emit no diff, not a fabricated deletion.
  const delDiff = await diffFromEdit("alpha\nbeta\n", null, "gone.txt");
  assert.doesNotMatch(String(delDiff || ""), /deleted file mode/);
  assert.equal(countDiffLines(delDiff).removed, 0);
});

// Regression: a small in-place edit must never be reported as a whole-file
// change just because the post-result re-read failed to observe the new file.
// edit/multiedit/write/notebookedit never DELETE a file, so a re-read that finds
// it gone (ENOENT) raced the tool's write / an atomic write-and-rename window /
// a path that moved after the turn. The tracker must fall back to the diff
// reconstructed from the tool input, not emit the whole file as `-N`.
test("a real edit whose post-result re-read misses the file is not a whole-file deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-readmiss-"));
  const before = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const abs = path.join(root, "big.txt");
  try {
    await fs.writeFile(abs, before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "Edit",
      args: { file_path: "big.txt", old_string: "line 200", new_string: "line 200 CHANGED" },
    });
    // The edit landed, but the re-read observes the file as gone.
    await fs.rm(abs, { force: true });
    const event = await tracker.enrichResult({ type: "tool_call_result", id: "tool-1", content: "ok" });

    assert.notEqual(event.tool.file_changes[0].change_type, "delete", "an edit is never a delete");
    const { added, removed } = countDiffLines(event.tool.diff);
    assert.equal(removed, 1, `expected the edit's single removal, got -${removed}`);
    assert.equal(added, 1, `expected the edit's single addition, got +${added}`);
    assert.match(event.tool.diff, /^-line 200$/m);
    assert.match(event.tool.diff, /^\+line 200 CHANGED$/m);
    assert.doesNotMatch(event.tool.diff, /^-line 1$/m, "the whole file must not be emitted as deletions");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Same invariant when the re-read sees the file present but empty (a truncation
// race): a small edit must not collapse into all-lines-removed.
test("a real edit whose post-result re-read sees an empty file is not all-deletions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-readempty-"));
  const before = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const abs = path.join(root, "big.txt");
  try {
    await fs.writeFile(abs, before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "Edit",
      args: { file_path: "big.txt", old_string: "line 200", new_string: "line 200 CHANGED" },
    });
    await fs.writeFile(abs, "");
    const event = await tracker.enrichResult({ type: "tool_call_result", id: "tool-1", content: "ok" });

    const { added, removed } = countDiffLines(event.tool.diff);
    assert.equal(removed, 1, `expected the edit's single removal, got -${removed}`);
    assert.equal(added, 1, `expected the edit's single addition, got +${added}`);
    assert.doesNotMatch(event.tool.diff, /^-line 1$/m, "the whole file must not be emitted as deletions");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A Write over an EXISTING file whose re-read misses must stay a `modify` whose
// diff applies over the original preimage — not a fabricated `add`/new-file diff
// (which mislabels the op and cannot apply over the existing content).
test("an existing file overwritten by Write whose re-read misses is an appliable modify, not an add", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-writemiss-"));
  const before = "alpha\nbeta\ngamma\n";
  const content = "alpha\nBETA\ngamma\n";
  const abs = path.join(root, "f.txt");
  try {
    await fs.writeFile(abs, before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "Write",
      args: { file_path: "f.txt", content },
    });
    await fs.rm(abs, { force: true });
    const event = await tracker.enrichResult({ type: "tool_call_result", id: "tool-1", content: "ok" });

    assert.equal(event.tool.file_changes[0].change_type, "modify", "an overwrite of an existing file is a modify");
    assert.doesNotMatch(event.tool.diff, /new file mode/);
    assert.doesNotMatch(event.tool.diff, /^--- \/dev\/null$/m);
    // The reconstructed diff must apply over the ORIGINAL preimage.
    await fs.writeFile(abs, before);
    await gitApply(root, event.tool.diff);
    assert.equal(await fs.readFile(abs, "utf8"), content);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// NotebookEdit has no old_string/new_string to reconstruct from, so there is no
// input fallback. It still must never render as a whole-file deletion.
test("a NotebookEdit whose re-read misses is not a whole-file deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-nbmiss-"));
  const before = Array.from({ length: 200 }, (_, i) => `cell ${i + 1}`).join("\n") + "\n";
  const abs = path.join(root, "nb.ipynb");
  try {
    await fs.writeFile(abs, before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "NotebookEdit",
      args: { notebook_path: "nb.ipynb", new_source: "print('x')" },
    });
    await fs.rm(abs, { force: true });
    const event = await tracker.enrichResult({ type: "tool_call_result", id: "tool-1", content: "ok" });

    assert.notEqual(event.tool.file_changes[0].change_type, "delete");
    const { removed } = countDiffLines(event.tool.diff);
    assert.notEqual(removed, 200, "the whole notebook must not be emitted as deletions");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A MultiEdit whose re-read misses must reflect the edits against the real
// preimage (an appliable diff), not a whole-file deletion.
test("a MultiEdit whose re-read misses reflects the edits and applies over the original", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-multieditmiss-"));
  const before = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const abs = path.join(root, "f.txt");
  try {
    await fs.writeFile(abs, before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "MultiEdit",
      args: {
        file_path: "f.txt",
        edits: [
          { old_string: "line 100", new_string: "line 100 X" },
          { old_string: "line 250", new_string: "line 250 Y" },
        ],
      },
    });
    await fs.rm(abs, { force: true });
    const event = await tracker.enrichResult({ type: "tool_call_result", id: "tool-1", content: "ok" });

    const { removed } = countDiffLines(event.tool.diff);
    assert.ok(removed < 300, `whole-file deletion leaked: -${removed}`);
    assert.match(event.tool.diff, /^-line 100$/m);
    assert.match(event.tool.diff, /^\+line 100 X$/m);
    await fs.writeFile(abs, before);
    await gitApply(root, event.tool.diff);
    const applied = await fs.readFile(abs, "utf8");
    assert.match(applied, /^line 100 X$/m);
    assert.match(applied, /^line 250 Y$/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// A FAILED tool result must not synthesize a "successful" edit diff from the
// tool input, even when the file independently reads as missing/empty.
test("a failed edit result whose re-read misses does not fabricate a success diff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-failmiss-"));
  const before = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const abs = path.join(root, "f.txt");
  try {
    await fs.writeFile(abs, before);
    const tracker = createFileDiffTracker(root);
    await tracker.capture({
      type: "tool_call_requested",
      id: "tool-1",
      name: "Edit",
      args: { file_path: "f.txt", old_string: "line 50", new_string: "line 50 CHANGED" },
    });
    await fs.rm(abs, { force: true });
    const event = await tracker.enrichResult({
      type: "tool_call_result",
      id: "tool-1",
      content: "Error: file not found",
      is_error: true,
    });

    const { added, removed } = countDiffLines(event.tool.diff);
    assert.equal(added, 0, "a failed edit must not fabricate additions");
    assert.equal(removed, 0, "a failed edit must not fabricate deletions");
    assert.notEqual(event.tool.file_changes[0].change_type, "delete");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// The common failure mode: an Edit fails (no/non-unique match) and leaves the
// file INTACT. The re-read then equals the preimage, so this is not the
// missing/empty branch — the input-derived fallback must still never represent
// the failed edit. Applies equally to Write and MultiEdit.
for (const scenario of [
  {
    name: "Edit",
    args: { file_path: "f.txt", old_string: "line 50", new_string: "line 50 CHANGED" },
  },
  {
    name: "Write",
    args: { file_path: "f.txt", content: "totally\ndifferent\ncontent\n" },
  },
  {
    name: "MultiEdit",
    args: { file_path: "f.txt", edits: [{ old_string: "line 50", new_string: "line 50 CHANGED" }] },
  },
]) {
  test(`a failed ${scenario.name} that leaves the file unchanged reports no diff`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-relay-claude-failsame-"));
    const before = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const abs = path.join(root, "f.txt");
    try {
      await fs.writeFile(abs, before);
      const tracker = createFileDiffTracker(root);
      await tracker.capture({
        type: "tool_call_requested",
        id: "tool-1",
        name: scenario.name,
        args: scenario.args,
      });
      // The tool failed: the file is left exactly as it was.
      const event = await tracker.enrichResult({
        type: "tool_call_result",
        id: "tool-1",
        content: "Error: no match",
        is_error: true,
      });

      const { added, removed } = countDiffLines(event.tool.diff);
      assert.equal(added, 0, `failed ${scenario.name} must not fabricate additions`);
      assert.equal(removed, 0, `failed ${scenario.name} must not fabricate deletions`);
      assert.equal(await fs.readFile(abs, "utf8"), before, "the file is genuinely unchanged");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

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
