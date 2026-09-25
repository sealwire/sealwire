import React from "react";
import {
  createWorkspaceDiffStore,
  ReviewerChip,
  WorkspaceChangesPanel,
  WorkspaceDiffChip,
  WorkspaceDiffModalTitle,
  WorkspaceDiffSheetBody,
} from "../local/workspace-diff.js";
import { RightPanelTabs } from "../shared/right-panel-tabs.js";
import {
  decideWorkspaceRefresh,
  sessionViewedWorkspaceKey,
} from "../shared/viewed-workspace-key.js";
import {
  fetchRemoteThreadWorkspace,
  fetchRemoteWorkspaceDiff,
  getRemoteViewedThreadId,
  getRemoteViewedWorkspaceKey,
  setRemoteThreadWorkspace,
} from "./session-ops.js";

const h = React.createElement;

let sharedStore = null;
let lastRemoteTurnDiffId = null;
let lastRemoteWorkspaceKey = null;

export function getRemoteWorkspaceDiffStore() {
  if (!sharedStore) {
    sharedStore = createWorkspaceDiffStore({
      apiFetch: null,
      surface: "remote",
      // Keys the viewed-workspace identity (thread + birth cwd + remembered tree)
      // so a view switch, same-thread cwd change, or observation-only move clears
      // the previous diff; the actual fetch goes through fetchDiff below.
      getWorkspaceKey: getRemoteViewedWorkspaceKey,
      // Session the workspace read/pin is for.
      getThreadId: getRemoteViewedThreadId,
      fetchDiff: async ({ viewRoot } = {}) => {
        const data = await fetchRemoteWorkspaceDiff({ viewRoot });
        if (!data) {
          throw new Error("workspace_diff missing in remote response");
        }
        return data;
      },
      // Session workspace is relay state. Diff preview is local via setViewRoot.
      fetchWorkspace: async (threadId, options) => {
        const data = await fetchRemoteThreadWorkspace(threadId, options);
        if (!data) {
          throw new Error("thread_workspace missing in remote response");
        }
        return data;
      },
      setWorkspace: async (threadId, cwd) => {
        const data = await setRemoteThreadWorkspace(threadId, cwd);
        if (!data) {
          throw new Error("thread_workspace missing in remote response");
        }
        return data;
      },
    });
  }
  return sharedStore;
}

// Counts are cached by PATH, which only identifies a directory while the relay is the
// same machine — and this store is a singleton that survives the switch.
export function resetRemoteWorkspaceCounts() {
  sharedStore?.clearRootCounts();
}

export function notifyRemoteSessionUpdated(session) {
  if (!sharedStore) return;
  if (!session) return;
  // Observation does not move current_cwd; key includes the remembered tree.
  const workspaceKey = sessionViewedWorkspaceKey(session, getRemoteViewedThreadId());
  const decision = decideWorkspaceRefresh({
    session,
    workspaceKey,
    lastWorkspaceKey: lastRemoteWorkspaceKey,
    lastTurnDiffId: lastRemoteTurnDiffId,
  });
  lastRemoteWorkspaceKey = decision.workspaceKey;
  lastRemoteTurnDiffId = decision.turnDiffId;
  if (decision.refresh) {
    void sharedStore.refresh();
  }
}

function RemoteRailToggleIcon() {
  return h(
    "svg",
    { "aria-hidden": "true", fill: "none", height: "16", viewBox: "0 0 16 16", width: "16", stroke: "currentColor", strokeWidth: "1.4" },
    h("rect", { x: "1.5", y: "2.5", width: "13", height: "11", rx: "2" }),
    h("line", { x1: "10", y1: "2.5", x2: "10", y2: "13.5" })
  );
}

export function RemoteWorkspaceChangesRail({ reviewer = {} } = {}) {
  const store = getRemoteWorkspaceDiffStore();
  return h(
    "aside",
    {
      className: "right-rail",
      id: "remote-workspace-changes-rail",
      "aria-label": "Workspace overview",
    },
    h("div", {
      className: "right-rail-resize",
      id: "remote-right-rail-resize",
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": "Resize workspace panel",
      tabIndex: 0,
    }),
    h(
      "button",
      {
        "aria-label": "Hide workspace panel",
        className: "header-button header-panel-toggle rail-top-toggle",
        id: "remote-rail-top-toggle",
        title: "Hide workspace panel (⌥⌘B)",
        type: "button",
      },
      h(RemoteRailToggleIcon)
    ),
    h(
      "div",
      { className: "right-rail-body" },
      h(RightPanelTabs, {
        store,
        panelId: "review-panel-remote-rail",
        reviewer,
        changes: h(WorkspaceChangesPanel, { store }),
      })
    )
  );
}

export function RemoteWorkspaceDiffChip({ onTap }) {
  const store = getRemoteWorkspaceDiffStore();
  return h(WorkspaceDiffChip, { store, onTap });
}

export function RemoteReviewerChip({ onTap }) {
  const store = getRemoteWorkspaceDiffStore();
  return h(ReviewerChip, { store, onTap });
}

export function triggerRemoteWorkspaceDiffRefresh() {
  if (!sharedStore) return;
  void sharedStore.refresh();
}

export function RemoteWorkspaceDiffModal({ reviewer = {} } = {}) {
  const store = getRemoteWorkspaceDiffStore();
  function close() {
    const dialog = document.getElementById("remote-workspace-diff-modal");
    dialog?.close?.();
  }
  return h(
    "dialog",
    {
      className: "panel-modal panel-modal-wide",
      id: "remote-workspace-diff-modal",
      onClick: (event) => {
        if (event.target?.id === "remote-workspace-diff-modal") close();
      },
    },
    h(
      "div",
      { className: "modal-header" },
      h(WorkspaceDiffModalTitle, { store }),
      h(
        "div",
        { className: "modal-header-actions" },
        // Diff refresh now lives inside the Changes body (WorkspaceDiffSheetBody),
        // scoped to the diff. Header keeps only the close affordance.
        h(
          "button",
          {
            className: "header-button close-modal-btn",
            onClick: close,
            type: "button",
          },
          "×"
        )
      )
    ),
    h(
      "section",
      { className: "panel-modal-body" },
      h(RightPanelTabs, {
        store,
        panelId: "review-panel-remote-modal",
        reviewer,
        changes: h(WorkspaceDiffSheetBody, { store }),
      })
    )
  );
}
