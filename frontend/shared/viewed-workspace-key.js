import { transcriptRowKey } from "./transcript-row-key.js";
// Identity of the workspace a surface is looking at. Birth `current_cwd` does
// not move when a session is observed in another tree, so the remembered
// pin/proven path has to ride along — otherwise an open Changes panel keeps
// showing the previous tree until the user refreshes.
//
// `workspacesRevision` is the snapshot cache key for ANY thread's proven/pin
// change. The local surface keeps `state.session` as the real active session
// while viewing another thread, so that thread's proven path is not on the
// snapshot; the revision is what lets an already-open panel notice.
export function viewedWorkspaceKey({
  threadId,
  currentCwd,
  threadWorkspaceCwd,
  workspacesRevision,
}) {
  return JSON.stringify([
    threadId || "",
    currentCwd || "",
    threadWorkspaceCwd || "",
    workspacesRevision || 0,
  ]);
}

export function sessionViewedWorkspaceKey(session, threadId) {
  return viewedWorkspaceKey({
    threadId,
    currentCwd: session?.current_cwd,
    threadWorkspaceCwd: session?.thread_workspace_cwd,
    workspacesRevision: session?.thread_workspaces_revision,
  });
}

// Both surfaces watch the same two triggers — the viewed workspace changing, and a new
// turnDiff landing — off one snapshot event. Shared so a fix lands on both.
export function decideWorkspaceRefresh({
  session,
  workspaceKey,
  lastWorkspaceKey,
  lastTurnDiffId,
}) {
  // A key never seen before is a change: the boot refresh runs before any session, so
  // it settles blank, and a first snapshot read as "unchanged" leaves it that way.
  if (workspaceKey !== lastWorkspaceKey) {
    return { refresh: true, workspaceKey, turnDiffId: null };
  }
  const entries = session?.transcript || [];
  let latest = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.tool?.item_type === "turnDiff") {
      latest = transcriptRowKey(entries[i]) || null;
      break;
    }
  }
  if (latest && latest !== lastTurnDiffId) {
    return { refresh: true, workspaceKey, turnDiffId: latest };
  }
  return { refresh: false, workspaceKey, turnDiffId: latest ? lastTurnDiffId : null };
}

// Local view-only: the pin holds the viewed thread's own cwd, but a background
// observation does not rewrite the pin. Include the snapshot revision so the
// Changes store still refetches for thread A while B is active.
export function localViewedWorkspaceKey({ session, viewThreadId, viewOnlyThread }) {
  const pin = viewOnlyThread;
  if (pin && viewThreadId && pin.threadId === viewThreadId) {
    return viewedWorkspaceKey({
      threadId: viewThreadId,
      currentCwd: pin.cwd,
      threadWorkspaceCwd: pin.threadWorkspaceCwd,
      workspacesRevision: session?.thread_workspaces_revision,
    });
  }
  return sessionViewedWorkspaceKey(session, viewThreadId);
}
