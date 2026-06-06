import React from "react";
import {
  createWorkspaceDiffStore,
  ReviewerChip,
  WorkspaceChangesPanel,
  WorkspaceDiffChip,
  WorkspaceDiffSheetBody,
} from "../local/workspace-diff.js";
import { RightPanelTabs } from "../shared/right-panel-tabs.js";
import { fetchRemoteWorkspaceDiff } from "./session-ops.js";

const h = React.createElement;

let sharedStore = null;
let lastRemoteTurnDiffId = null;
let lastRemoteCwd = null;

export function getRemoteWorkspaceDiffStore() {
  if (!sharedStore) {
    sharedStore = createWorkspaceDiffStore({
      apiFetch: null,
      surface: "remote",
      fetchDiff: async () => {
        const data = await fetchRemoteWorkspaceDiff();
        if (!data) {
          throw new Error("workspace_diff missing in remote response");
        }
        return data;
      },
    });
  }
  return sharedStore;
}

export function notifyRemoteSessionUpdated(session) {
  if (!sharedStore) return;
  if (!session) return;
  const cwd = session.current_cwd || "";
  if (lastRemoteCwd !== null && cwd !== lastRemoteCwd) {
    lastRemoteCwd = cwd;
    lastRemoteTurnDiffId = null;
    void sharedStore.refresh();
    return;
  }
  lastRemoteCwd = cwd;
  const entries = session.transcript || [];
  let latest = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.tool?.item_type === "turnDiff") {
      latest = entries[i].item_id || null;
      break;
    }
  }
  if (latest && latest !== lastRemoteTurnDiffId) {
    lastRemoteTurnDiffId = latest;
    void sharedStore.refresh();
  } else if (!latest) {
    lastRemoteTurnDiffId = null;
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
    h(RightPanelTabs, {
      store,
      panelId: "review-panel-remote-rail",
      reviewer,
      changes: h(WorkspaceChangesPanel, { store }),
    })
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
      h("h2", null, "Workspace diff"),
      h(
        "div",
        { className: "modal-header-actions" },
        h(
          "button",
          {
            className: "load-button",
            onClick: () => store.refresh(),
            type: "button",
          },
          "Refresh"
        ),
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
