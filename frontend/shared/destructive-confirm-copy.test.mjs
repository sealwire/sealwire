import test from "node:test";
import assert from "node:assert/strict";

import { describeProjectDelete, describeThreadRemoval } from "./destructive-confirm-copy.js";

test("a single delete names the session and its provider, and nothing about reviewers when it has none", () => {
  const copy = describeThreadRemoval({ titles: ["Auth work"], providerName: "Codex" });
  assert.equal(copy.title, "Delete “Auth work”?");
  assert.equal(copy.body, "Removes the session file from local Codex storage. This can’t be undone.");
  assert.equal(copy.confirmLabel, "Delete session");
  assert.doesNotMatch(copy.body, /reviewer/);
});

test("reviewer sessions that go with it are counted in the body", () => {
  assert.match(
    describeThreadRemoval({ titles: ["A"], reviewerCount: 1 }).body,
    /Its 1 reviewer session is deleted too\.$/
  );
  assert.match(
    describeThreadRemoval({ titles: ["A"], reviewerCount: 2 }).body,
    /Its 2 reviewer sessions are deleted too\.$/
  );
  assert.match(
    describeThreadRemoval({ action: "archive", titles: ["A"], reviewerCount: 3 }).body,
    /^Removes it from local history\. Its 3 reviewer sessions are deleted too\.$/
  );
});

test("a batch is counted, not listed", () => {
  const copy = describeThreadRemoval({ titles: ["A", "B", "C"], reviewerCount: 2 });
  assert.equal(copy.title, "Delete 3 sessions?");
  assert.equal(copy.confirmLabel, "Delete 3 sessions");
  assert.match(copy.body, /Their 2 reviewer sessions are deleted too\.$/);
});

test("deleting a project says where its sessions go and that none are deleted", () => {
  assert.deepEqual(describeProjectDelete({ name: "神仙教母", sessionCount: 3 }), {
    title: "Delete project “神仙教母”?",
    body: "Its 3 sessions leave the project. No sessions are deleted.",
    confirmLabel: "Delete project",
  });
  assert.equal(
    describeProjectDelete({ name: "x", sessionCount: 1 }).body,
    "Its 1 session leaves the project. No sessions are deleted."
  );
});

test("an empty project has nothing to confirm", () => {
  assert.equal(describeProjectDelete({ name: "x", sessionCount: 0 }), null);
});
