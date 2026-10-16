import test from "node:test";
import assert from "node:assert/strict";

import { formatCommitTime, reflowMessage, visibleRefs } from "./history-message.js";

test("a hard-wrapped commit message reads as paragraphs; lists, indented code and trailers keep their lines", () => {
  const body = [
    "The relay used to read it from a file next to the binary, which meant every",
    "deploy had to remember to copy it.",
    "",
    "- first point that wraps",
    "  onto a second line",
    "- second point",
    "",
    "    let indented = code;",
    "    keep(it);",
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "Signed-off-by: Tess <t@e.com>",
  ].join("\n");
  assert.equal(
    reflowMessage(body),
    [
      "The relay used to read it from a file next to the binary, which meant every deploy had to remember to copy it.",
      "",
      "- first point that wraps onto a second line",
      "- second point",
      "",
      "    let indented = code;",
      "    keep(it);",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "Signed-off-by: Tess <t@e.com>",
    ].join("\n")
  );
});

test("a commit shows a few branch labels and counts the rest", () => {
  const refs = ["HEAD -> main", "origin/main", "backup/a", "backup/b", "origin/backup/a"];
  assert.deepEqual(visibleRefs(refs, 2), { shown: ["HEAD -> main", "origin/main"], hidden: ["backup/a", "backup/b", "origin/backup/a"] });
  assert.deepEqual(visibleRefs(["main"], 2), { shown: ["main"], hidden: [] });
  assert.deepEqual(visibleRefs(undefined, 2), { shown: [], hidden: [] });
});

test("a commit's time is written in the interface's language, not the browser's", () => {
  const time = 1_790_000_000;
  assert.match(formatCommitTime(time, "en"), /AM|PM/);
  assert.doesNotMatch(formatCommitTime(time, "en"), /[一-鿿]/);
  assert.match(formatCommitTime(time, "zh-CN"), /2026/);
});

test("a wrapped line that happens to start like a trailer still joins its paragraph", () => {
  const body = [
    "A new Editor destination beside Sessions browses and edits the files of a",
    "worktree: a file tree with git status, tabs, and CodeMirror 6.",
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
  ].join("\n");
  assert.equal(
    reflowMessage(body),
    [
      "A new Editor destination beside Sessions browses and edits the files of a worktree: a file tree with git status, tabs, and CodeMirror 6.",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n")
  );
});
