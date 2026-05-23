import React from "react";
import {
  createWorkspaceDiffStore,
  WorkspaceChangesPanel,
  WorkspaceDiffChip,
  WorkspaceDiffSheetBody,
} from "../local/workspace-diff.js";
import { fetchRemoteWorkspaceDiff } from "./session-ops.js";

const h = React.createElement;

let sharedStore = null;
let lastRemoteTurnDiffId = null;
let lastRemoteCwd = null;

export function getRemoteWorkspaceDiffStore() {
  if (!sharedStore) {
    sharedStore = createWorkspaceDiffStore({
      apiFetch: null,
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

export function RemoteWorkspaceChangesRail() {
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
    h(WorkspaceChangesPanel, { store })
  );
}

export function RemoteWorkspaceDiffChip({ onTap }) {
  const store = getRemoteWorkspaceDiffStore();
  return h(WorkspaceDiffChip, { store, onTap });
}

export function triggerRemoteWorkspaceDiffRefresh() {
  if (!sharedStore) return;
  void sharedStore.refresh();
}

export function RemoteWorkspaceDiffModal() {
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
    h("section", { className: "panel-modal-body" }, h(WorkspaceDiffSheetBody, { store }))
  );
}
