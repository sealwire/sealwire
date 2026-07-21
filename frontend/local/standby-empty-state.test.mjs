import { test } from "node:test";
import assert from "node:assert/strict";

import { selectStandbyEmptyModel, buildStandbyEmptyActions } from "./standby-empty-state.js";

// The reviewer's finding: in standby (no active thread) the composer is disabled and a
// programmatic send is rejected with "No thread is selected", so a data-suggestion action
// is a dead-end. Every start action must instead open the real New session flow.
test("every quick-start action opens the start flow, never the disabled standby composer", () => {
  const actions = buildStandbyEmptyActions(selectStandbyEmptyModel({ threads: [] }));
  assert.ok(actions.length >= 1, "first-use still offers a way to start");
  for (const action of actions) {
    assert.equal(action.attrs["data-suggestion"], undefined, "must not prefill a disabled composer");
    assert.equal(action.attrs["data-start-session"], "true", "opens the New session dialog");
    assert.ok(action.attrs["data-start-prompt"], "carries the seed prompt for the dialog");
  }
});

test("returning: the first action continues the latest thread, the rest start new tasks", () => {
  const actions = buildStandbyEmptyActions(
    selectStandbyEmptyModel({ threads: [{ id: "t1", name: "Task", updated_at: 5 }] })
  );
  assert.equal(actions[0].attrs["data-open-thread-id"], "t1");
  assert.equal(actions[0].label, 'Continue "Task"');
  for (const action of actions.slice(1)) {
    assert.equal(action.attrs["data-start-session"], "true");
  }
});

test("returning: picks the most recently updated thread and offers to continue it", () => {
  const model = selectStandbyEmptyModel({
    threads: [
      { id: "aaaaaaaa1", name: "Old task", updated_at: 1000 },
      { id: "bbbbbbbb2", name: "Fix relay reconnect issue", updated_at: 3000 },
      { id: "cccccccc3", preview: "middle", updated_at: 2000 },
    ],
  });
  assert.equal(model.mode, "returning");
  assert.equal(model.continueAction.threadId, "bbbbbbbb2");
  assert.equal(model.continueAction.label, "Fix relay reconnect issue");
});

test("first-use: no threads → welcome with no continue action", () => {
  const model = selectStandbyEmptyModel({ threads: [] });
  assert.equal(model.mode, "first-use");
  assert.equal(model.continueAction, null);
  assert.equal(model.title, "Providers are ready");
});

test("label falls back name → preview → shortId, and long labels truncate", () => {
  assert.equal(
    selectStandbyEmptyModel({ threads: [{ id: "abcdef123456", updated_at: 1 }] }).continueAction.label,
    "abcdef12"
  );
  const long = selectStandbyEmptyModel({
    threads: [{ id: "z", name: "x".repeat(100), updated_at: 1 }],
  }).continueAction.label;
  assert.ok(long.length <= 48, "truncated to the cap");
  assert.ok(long.endsWith("…"), "shows an ellipsis when clipped");
});

test("ISO-string timestamps compare correctly for the latest pick", () => {
  const model = selectStandbyEmptyModel({
    threads: [
      { id: "a", name: "older", updated_at: "2026-01-01T00:00:00Z" },
      { id: "b", name: "newer", updated_at: "2026-06-01T00:00:00Z" },
    ],
  });
  assert.equal(model.continueAction.label, "newer");
});

test("threads without ids are ignored when choosing the latest", () => {
  const model = selectStandbyEmptyModel({
    threads: [
      { name: "no id but newest", updated_at: 9999 },
      { id: "real", name: "has id", updated_at: 5 },
    ],
  });
  assert.equal(model.continueAction.threadId, "real");
});

test("selectedCwd is passed through for the workspace detail line", () => {
  assert.equal(selectStandbyEmptyModel({ selectedCwd: "/tmp/x" }).selectedCwd, "/tmp/x");
});
