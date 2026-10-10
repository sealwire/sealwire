import test from "node:test";
import assert from "node:assert/strict";

import { selectSessionChromeRenderModel } from "./remote/chrome-view-model.js";
import { ControlBanner } from "./remote/react-renderer.js";
import {
  dispatchWorkspaceRepair,
  readWorkspaceRepair,
  setWorkspaceRepairError,
  setWorkspaceRepairPending,
  workspaceRepairResolved,
} from "./remote/workspace-repair.js";

// Exactly the shape `snapshot.workspace_missing` arrives in — see `WorkspaceRepairView`
// in crates/relay-server/src/protocol.rs. Non-null ONLY when the recorded cwd is not a
// directory right now.
const WORKTREE_PLAN = {
  branch: "task/beautiful-ui",
  kind: "worktree",
  recorded_cwd: "/Users/luchi/git/agent-relay/.sealwire/worktrees/beautiful-ui",
  repo_root: "/Users/luchi/git/agent-relay",
};

const FOLDER_PLAN = {
  branch: null,
  kind: "folder",
  recorded_cwd: "/Users/luchi/scratch/gone-for-good",
  repo_root: null,
};

const THREAD_ID = "thread-1";

function remoteState(extra = {}) {
  return {
    remoteAuth: { deviceId: "device-1" },
    socketConnected: true,
    ...extra,
  };
}

// A thread whose review lock banner would otherwise own the slot.
function reviewedSession(extra = {}) {
  return {
    active_thread_id: THREAD_ID,
    active_review_jobs: [
      { id: "review-1", status: "waiting_for_reviewer", parent_thread_id: THREAD_ID },
    ],
    current_status: "idle",
    pending_approvals: [],
    provider_connected: true,
    ...extra,
  };
}

function idleSession(extra = {}) {
  return {
    active_thread_id: THREAD_ID,
    current_cwd: "/Users/luchi/git/agent-relay",
    current_status: "idle",
    pending_approvals: [],
    provider_connected: true,
    ...extra,
  };
}

// The verdict rides the snapshot, so seeding "this workspace is gone" means handing the
// SESSION a `workspace_missing` — see the `idleSession({ workspace_missing: ... })` call
// sites. What still lives on the state, per thread, is the repair BUTTON: in flight, or
// carrying the relay's last failure.
function stateWithRepairButton({ error = "", pending = false } = {}, threadId = THREAD_ID) {
  const state = remoteState();
  if (pending) {
    setWorkspaceRepairPending(state, threadId, true);
  }
  if (error) {
    setWorkspaceRepairError(state, threadId, error);
  }
  return state;
}

function findElement(node, predicate) {
  if (!node || typeof node !== "object") {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (predicate(node)) {
    return node;
  }
  return findElement(node.props?.children, predicate);
}

test("a missing worktree claims the remote banner, names the path, and offers to re-create it", () => {
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton(),
    idleSession({ workspace_missing: WORKTREE_PLAN })
  ).controlBanner;

  assert.equal(model.hidden, false);
  assert.ok(model.repair, "expected a repair action on the banner");
  assert.equal(model.repair.kind, "worktree");
  assert.equal(model.repair.threadId, THREAD_ID);
  assert.equal(model.repair.pending, false);
  assert.match(model.repair.label, /re-create/i);
  assert.match(model.repair.label, /worktree/i);
  // The whole point: the banner names the directory that is gone.
  assert.match(model.summary, /beautiful-ui/, `summary must name the directory: ${model.summary}`);
  assert.equal(model.summaryTitle, WORKTREE_PLAN.recorded_cwd);
  // The branch comes back with the worktree — say so somewhere the user can read it.
  assert.match(model.hint, /task\/beautiful-ui/);
});

test("a missing plain folder offers to create the folder, with no branch talk", () => {
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton(),
    idleSession({ workspace_missing: FOLDER_PLAN })
  ).controlBanner;

  assert.equal(model.hidden, false);
  assert.equal(model.repair.kind, "folder");
  assert.match(model.repair.label, /create folder/i);
  assert.doesNotMatch(model.repair.label, /worktree/i);
  assert.doesNotMatch(model.hint, /branch/i);
  assert.match(model.summary, /gone-for-good/);
  assert.equal(model.summaryTitle, FOLDER_PLAN.recorded_cwd);
});

test("a long recorded cwd keeps its meaningful tail instead of being clipped", () => {
  const deep = {
    ...WORKTREE_PLAN,
    recorded_cwd:
      "/Users/luchi/development/checkouts/agent-relay/.sealwire/worktrees/very-long-worktree-name",
  };
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton(),
    idleSession({ workspace_missing: deep })
  ).controlBanner;

  assert.ok(
    model.summary.length <= 72,
    `summary must survive a narrow phone, got ${model.summary.length}: ${model.summary}`
  );
  assert.match(model.summary, /very-long-worktree-name$/, "the tail is the meaningful part");
  assert.match(model.summary, /…|\.\.\./, "a shortened path must say it was shortened");
  assert.equal(model.summaryTitle, deep.recorded_cwd, "the full path stays reachable");
});

test("workspace_missing: null leaves ordinary banner behaviour untouched", () => {
  const state = stateWithRepairButton();

  const idle = selectSessionChromeRenderModel(
    state,
    idleSession({ workspace_missing: null })
  ).controlBanner;
  assert.equal(idle.hidden, true);
  assert.equal(idle.repair, null);

  const reviewed = selectSessionChromeRenderModel(
    state,
    reviewedSession({ workspace_missing: null })
  ).controlBanner;
  assert.equal(reviewed.hidden, false);
  assert.equal(reviewed.repair, null);
  assert.equal(reviewed.summary, "Review in progress");
});

test("the repair banner wins over the review lock when both would apply", () => {
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton(),
    reviewedSession({ workspace_missing: WORKTREE_PLAN })
  ).controlBanner;

  assert.equal(model.hidden, false);
  assert.ok(model.repair, "the missing workspace outranks the review lock");
  assert.doesNotMatch(model.summary, /review/i);
});

test("a pending repair says so on the button and keeps the banner up", () => {
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton({ pending: true }),
    idleSession({ workspace_missing: WORKTREE_PLAN })
  ).controlBanner;

  assert.equal(model.repair.pending, true);
  assert.match(model.repair.label, /…|ing\b/i, `pending label should read as in-flight: ${model.repair.label}`);
});

test("a failed repair surfaces the relay's own message verbatim", () => {
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton({ error: "the repository /Users/luchi/git/agent-relay no longer exists either" }),
    idleSession({ workspace_missing: WORKTREE_PLAN })
  ).controlBanner;

  assert.equal(
    model.repair.error,
    "the repository /Users/luchi/git/agent-relay no longer exists either"
  );
  assert.equal(model.repair.pending, false);
});

// The verdict is per snapshot now, i.e. per active thread — but the BUTTON is still keyed
// by thread, because a repair can settle after the user has swiped to another session.
test("a repair in flight on one thread leaves another thread's button idle", () => {
  const state = stateWithRepairButton({ pending: true });

  const mine = selectSessionChromeRenderModel(
    state,
    idleSession({ workspace_missing: WORKTREE_PLAN })
  ).controlBanner;
  const other = selectSessionChromeRenderModel(
    state,
    idleSession({ active_thread_id: "thread-2", workspace_missing: WORKTREE_PLAN })
  ).controlBanner;

  assert.equal(mine.repair.pending, true);
  assert.equal(other.repair.threadId, "thread-2");
  assert.equal(other.repair.pending, false, "thread-2 is not the thread being repaired");
  assert.equal(other.repair.error, "");
});

test("workspaceRepairResolved clears the button, and leaves the verdict to the next snapshot", () => {
  const state = stateWithRepairButton({ pending: true });

  workspaceRepairResolved(state, THREAD_ID);

  assert.deepEqual(readWorkspaceRepair(state, THREAD_ID), { error: "", pending: false });
  // The banner is the relay's call: it goes away when the snapshot stops saying the
  // workspace is missing, not because this surface guessed the repair worked.
  const stillMissing = selectSessionChromeRenderModel(
    state,
    idleSession({ workspace_missing: WORKTREE_PLAN })
  ).controlBanner;
  assert.equal(stillMissing.hidden, false);
  assert.equal(stillMissing.repair.pending, false, "the button is idle again");
  assert.equal(
    selectSessionChromeRenderModel(state, idleSession({ workspace_missing: null })).controlBanner
      .hidden,
    true
  );
});

test("dispatchWorkspaceRepair sends repair_workspace for that thread and stamps no device", async () => {
  const calls = [];
  const dispatch = async (...args) => {
    calls.push(args);
    return {};
  };

  await dispatchWorkspaceRepair(dispatch, "thread-42");

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "repair_workspace");
  assert.deepEqual(calls[0][1], { input: {}, thread_id: "thread-42" });
  assert.equal("device_id" in calls[0][1].input, false, "the relay stamps the device itself");
});

test("dispatchWorkspaceRepair does not swallow the relay's failure", async () => {
  const dispatch = async () => {
    throw new Error("worktree add failed: branch is already checked out");
  };

  await assert.rejects(
    () => dispatchWorkspaceRepair(dispatch, "thread-42"),
    /branch is already checked out/
  );
});

test("the remote banner renders the repair button and its error", () => {
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton({ error: "nope" }),
    idleSession({ workspace_missing: WORKTREE_PLAN })
  ).controlBanner;

  const pressed = [];
  const tree = ControlBanner({
    model,
    onRepairWorkspace: (threadId) => pressed.push(threadId),
  });

  const summary = findElement(tree, (node) => node.props?.className === "control-summary");
  assert.ok(summary);
  assert.equal(summary.props.title, WORKTREE_PLAN.recorded_cwd);

  const repairButton = findElement(
    tree,
    (node) => node.props?.id === "remote-workspace-repair-button"
  );
  assert.ok(repairButton, "expected a repair button in the banner");
  assert.equal(repairButton.props.disabled, false);

  repairButton.props.onClick();
  assert.deepEqual(pressed, [THREAD_ID], "pressing repair must target the banner's own thread");

  const errorLine = findElement(tree, (node) => node.props?.className === "control-banner-error");
  assert.ok(errorLine, "the relay's failure must be on screen");
  assert.equal(errorLine.props.children, "nope");
});

test("the review lock banner carries no repair button and no error line", () => {
  const model = selectSessionChromeRenderModel(
    stateWithRepairButton(),
    reviewedSession({ workspace_missing: null })
  ).controlBanner;

  const tree = ControlBanner({ model });

  assert.equal(
    findElement(tree, (node) => node.props?.id === "remote-workspace-repair-button"),
    null
  );
  assert.equal(
    findElement(tree, (node) => node.props?.className === "control-banner-error"),
    null
  );
  const summary = findElement(tree, (node) => node.props?.className === "control-summary");
  assert.equal(summary.props.children, "Review in progress");
});
