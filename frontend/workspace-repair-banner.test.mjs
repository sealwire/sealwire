import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { selectControlBannerModel } from "./local/control-banner.js";
import { ControlBannerContent } from "./local/react-session-panels.js";

// Exactly the shape `thread_state.workspace_missing` arrives in (see
// WorkspaceRepairView in crates/relay-server/src/protocol.rs).
const WORKTREE_PLAN = {
  branch: "task/beautiful-ui",
  kind: "worktree",
  recorded_cwd: "/Users/luchi/git/agent-relay/.sealwire/worktrees/beautiful-ui",
  repo_root: "/Users/luchi/git/agent-relay",
};

const FOLDER_PLAN = {
  branch: null,
  kind: "folder",
  recorded_cwd: "/Users/luchi/scratch/gone",
  repo_root: null,
};

// A thread whose review lock would otherwise claim the slot.
function reviewLockedInputs(extra = {}) {
  return {
    hasActiveThread: true,
    lockedByAgent: true,
    viewingConversation: true,
    ...extra,
  };
}

test("a missing worktree names the directory and offers to re-create it on its branch", () => {
  const model = selectControlBannerModel({
    hasActiveThread: true,
    viewingConversation: true,
    workspaceMissing: WORKTREE_PLAN,
  });

  assert.equal(model.hidden, false);
  assert.ok(
    model.summary.includes(WORKTREE_PLAN.recorded_cwd),
    `summary must name the missing directory, got: ${model.summary}`
  );
  assert.ok(model.repair, "a missing workspace must offer a repair action");
  assert.ok(
    /re-create/i.test(model.repair.label),
    `worktree repair must read as re-creating it, got: ${model.repair.label}`
  );
  assert.ok(
    model.repair.label.includes("task/beautiful-ui"),
    `worktree repair must say the branch comes back, got: ${model.repair.label}`
  );
});

test("a missing plain folder offers to create the folder", () => {
  const model = selectControlBannerModel({
    hasActiveThread: true,
    viewingConversation: true,
    workspaceMissing: FOLDER_PLAN,
  });

  assert.equal(model.hidden, false);
  assert.ok(
    model.summary.includes(FOLDER_PLAN.recorded_cwd),
    `summary must name the missing directory, got: ${model.summary}`
  );
  assert.equal(model.repair.label, "Create folder");
});

test("the repair banner outranks the review lock: a send would die before the review matters", () => {
  const locked = selectControlBannerModel(reviewLockedInputs());
  assert.equal(locked.hidden, false);
  assert.equal(locked.repair, null);

  const repairing = selectControlBannerModel(
    reviewLockedInputs({ workspaceMissing: WORKTREE_PLAN })
  );
  assert.equal(repairing.hidden, false);
  assert.ok(repairing.repair, "the repair action must win the single banner slot");
  assert.ok(repairing.summary.includes(WORKTREE_PLAN.recorded_cwd));
});

test("no workspace_missing leaves the ordinary banner behaviour untouched", () => {
  const idle = selectControlBannerModel({
    hasActiveThread: true,
    viewingConversation: true,
    workspaceMissing: null,
  });
  assert.equal(idle.hidden, true);
  assert.equal(idle.repair, null);

  const locked = selectControlBannerModel(reviewLockedInputs({ workspaceMissing: null }));
  assert.equal(locked.hidden, false);
  assert.equal(locked.repair, null);
});

test("a repair banner never appears outside a conversation view", () => {
  const noThread = selectControlBannerModel({
    hasActiveThread: false,
    viewingConversation: true,
    workspaceMissing: WORKTREE_PLAN,
  });
  assert.equal(noThread.hidden, true);

  const elsewhere = selectControlBannerModel({
    hasActiveThread: true,
    viewingConversation: false,
    workspaceMissing: WORKTREE_PLAN,
  });
  assert.equal(elsewhere.hidden, true);
});

test("a pending repair says so and a failed one keeps the server's message", () => {
  const pending = selectControlBannerModel({
    hasActiveThread: true,
    repairPending: true,
    viewingConversation: true,
    workspaceMissing: WORKTREE_PLAN,
  });
  assert.equal(pending.repair.pending, true);
  assert.notEqual(pending.repair.label, "Re-create worktree on task/beautiful-ui");

  const failed = selectControlBannerModel({
    hasActiveThread: true,
    repairError: "/Users/luchi/git/agent-relay no longer exists either",
    viewingConversation: true,
    workspaceMissing: WORKTREE_PLAN,
  });
  assert.equal(failed.repair.pending, false);
  assert.ok(
    failed.repair.error.includes("no longer exists either"),
    `the server's message must survive, got: ${failed.repair.error}`
  );
});

test("a malformed workspace_missing is treated as no workspace problem at all", () => {
  const noPath = selectControlBannerModel({
    hasActiveThread: true,
    viewingConversation: true,
    workspaceMissing: { kind: "worktree", recorded_cwd: "   " },
  });
  assert.equal(noPath.hidden, true);
  assert.equal(noPath.repair, null);

  // Unknown kinds fall back to the folder offer: creating the directory is the one
  // repair that is always available.
  const unknownKind = selectControlBannerModel({
    hasActiveThread: true,
    viewingConversation: true,
    workspaceMissing: { kind: "wat", recorded_cwd: "/tmp/x" },
  });
  assert.equal(unknownKind.repair.label, "Create folder");
});

test("the banner component renders the repair action", () => {
  const model = selectControlBannerModel({
    hasActiveThread: true,
    repairError: "git worktree add failed",
    viewingConversation: true,
    workspaceMissing: WORKTREE_PLAN,
  });
  const markup = renderToStaticMarkup(
    React.createElement(ControlBannerContent, {
      hint: model.hint,
      repair: model.repair,
      summary: model.summary,
      summaryTitle: model.summaryTitle,
    })
  );

  assert.ok(
    markup.includes(WORKTREE_PLAN.recorded_cwd),
    `the rendered banner must name the missing directory, got: ${markup}`
  );
  assert.ok(
    markup.includes('id="workspace-repair-button"'),
    `the repair button must be clickable by id, got: ${markup}`
  );
  assert.ok(markup.includes("Re-create worktree on task/beautiful-ui"));
  assert.ok(
    markup.includes("git worktree add failed"),
    `the server's failure must stay on screen, got: ${markup}`
  );
});

test("a pending repair renders a disabled button so it cannot be double-fired", () => {
  const model = selectControlBannerModel({
    hasActiveThread: true,
    repairPending: true,
    viewingConversation: true,
    workspaceMissing: FOLDER_PLAN,
  });
  const markup = renderToStaticMarkup(
    React.createElement(ControlBannerContent, {
      repair: model.repair,
      summary: model.summary,
    })
  );

  assert.ok(markup.includes("disabled"), `pending repair must disable its button, got: ${markup}`);
});
