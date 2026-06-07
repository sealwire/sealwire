import React from "react";
import { createRoot } from "react-dom/client";
import { FileChangeDiff } from "../shared/transcript-react.js";
import { RightPanelTabs } from "../shared/right-panel-tabs.js";

const h = React.createElement;

function useStoreState(store) {
  return React.useSyncExternalStore(
    React.useCallback((listener) => store.subscribe(() => listener()), [store]),
    () => store.getState(),
    () => store.getState()
  );
}

export function createWorkspaceDiffStore({ apiFetch, fetchDiff = null, surface = "local" }) {
  const tabStorageKey = `agent-relay:right-panel-tab:${surface}`;
  let state = {
    status: "idle",
    data: null,
    error: null,
    expanded: false,
    activeTab: readStoredTab(tabStorageKey),
    review: { reviewJobs: [], reviewModel: {}, canRequest: false, blocked: false },
  };
  const listeners = new Set();

  function emit() {
    listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (error) {
        console.warn("workspace-diff listener failed", error);
      }
    });
  }

  function setState(patch) {
    state = { ...state, ...patch };
    emit();
  }

  async function refresh() {
    setState({ status: "loading", error: null });
    try {
      const data = fetchDiff
        ? await fetchDiff()
        : await fetchViaApi(apiFetch);
      setState({ status: "loaded", data, error: null });
    } catch (error) {
      setState({
        status: "error",
        error: error?.message || String(error),
      });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setExpanded(value) {
      setState({ expanded: Boolean(value) });
    },
    toggleExpanded() {
      setState({ expanded: !state.expanded });
    },
    setActiveTab(tab) {
      const next = tab === "reviewer" ? "reviewer" : "changes";
      if (next === state.activeTab) return;
      writeStoredTab(tabStorageKey, next);
      setState({ activeTab: next });
    },
    setReview(patch) {
      const next = { ...state.review, ...patch };
      // Avoid churn: only emit when the review slice actually changed.
      if (JSON.stringify(next) === JSON.stringify(state.review)) return;
      setState({ review: next });
    },
    refresh,
  };
}

function readStoredTab(key) {
  try {
    if (typeof localStorage === "undefined") return "changes";
    return localStorage.getItem(key) === "reviewer" ? "reviewer" : "changes";
  } catch {
    return "changes";
  }
}

function writeStoredTab(key, value) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // ignore persistence failures (private mode, etc.)
  }
}

async function fetchViaApi(apiFetch) {
  const response = await apiFetch("/api/workspace/diff", { method: "GET" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload.data;
}

export function computeChangeStats(data) {
  const fileChanges = data?.file_changes || [];
  let added = 0;
  let removed = 0;
  for (const change of fileChanges) {
    const counts = countDiffLines(change?.diff || "");
    added += counts.added;
    removed += counts.removed;
  }
  return { fileCount: fileChanges.length, added, removed };
}

function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function mountChangesPanel({ store, mount, reviewer = {}, panelId = "review-panel-rail" }) {
  if (!mount) return null;
  const root = createRoot(mount);
  root.render(
    h(RightPanelTabs, {
      store,
      panelId,
      reviewer,
      changes: h(WorkspaceChangesPanel, { store }),
    })
  );
  return {
    destroy() {
      root.unmount();
    },
  };
}

export function mountChip({ store, mount, onTap }) {
  if (!mount) return null;
  const root = createRoot(mount);
  root.render(h(WorkspaceDiffChip, { store, onTap }));
  return {
    destroy() {
      root.unmount();
    },
  };
}

export function createWorkspaceDiffSheet({
  store,
  mount,
  modal,
  closeButton,
  refreshButton,
  reviewer = {},
  panelId = "review-panel-sheet",
}) {
  if (!mount || !modal) return null;
  const root = createRoot(mount);
  root.render(
    h(RightPanelTabs, {
      store,
      panelId,
      reviewer,
      changes: h(WorkspaceDiffSheetBody, { store }),
    })
  );

  function open() {
    if (typeof modal.showModal === "function") {
      modal.showModal();
    } else {
      modal.setAttribute("open", "");
    }
    void store.refresh();
  }

  function close() {
    if (typeof modal.close === "function") {
      modal.close();
    } else {
      modal.removeAttribute("open");
    }
  }

  closeButton?.addEventListener("click", close);
  refreshButton?.addEventListener("click", () => {
    void store.refresh();
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      close();
    }
  });

  return {
    open,
    close,
    destroy() {
      root.unmount();
    },
  };
}

export function WorkspaceChangesPanel({ store }) {
  const state = useStoreState(store);
  const stats = computeChangeStats(state.data);
  const expanded = state.expanded;
  return h(
    "section",
    { className: "workspace-changes-panel" },
    h(
      "header",
      { className: "workspace-changes-header" },
      h("h2", { className: "workspace-changes-title" }, "Environment")
    ),
    h(
      "div",
      { className: "workspace-changes-list" },
      h(WorkspaceChangesEntry, { store, state, stats, expanded })
    )
  );
}

function RefreshIcon() {
  return h(
    "svg",
    {
      "aria-hidden": "true",
      fill: "none",
      height: "14",
      viewBox: "0 0 16 16",
      width: "14",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    },
    h("path", { d: "M13.5 3.5v3.5h-3.5" }),
    h("path", { d: "M13.1 7A5.5 5.5 0 1 0 12.5 11.5" })
  );
}

function WorkspaceChangesEntry({ store, state, stats, expanded }) {
  const isLoading = state.status === "loading";
  const isError = state.status === "error";
  const expandLabel = expanded ? "Collapse workspace diff" : "Expand workspace diff";
  function handleRowKey(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      store.toggleExpanded();
    }
  }
  return h(
    "div",
    { className: `workspace-changes-entry${expanded ? " is-expanded" : ""}` },
    h(
      "div",
      {
        className: "workspace-changes-row",
        onClick: (event) => {
          if (event.target.closest("[data-workspace-changes-skip]")) return;
          store.toggleExpanded();
        },
        onKeyDown: handleRowKey,
        role: "button",
        tabIndex: 0,
        "aria-expanded": expanded ? "true" : "false",
        "aria-label": expandLabel,
      },
      h(
        "span",
        { className: "workspace-changes-row-main" },
        h("span", { className: "workspace-changes-row-icon", "aria-hidden": "true" }, "±"),
        h("span", { className: "workspace-changes-row-label" }, "Changes"),
        renderStatsBadge(state, stats)
      ),
      h(
        "button",
        {
          type: "button",
          className: `workspace-changes-refresh${isLoading ? " is-loading" : ""}`,
          onClick: (event) => {
            event.stopPropagation();
            void store.refresh();
          },
          disabled: isLoading,
          title: isLoading ? "Refreshing…" : "Refresh",
          "aria-label": isLoading ? "Refreshing workspace diff" : "Refresh workspace diff",
          "data-workspace-changes-skip": "true",
        },
        h(RefreshIcon)
      ),
      h(
        "span",
        { className: "workspace-changes-row-chevron", "aria-hidden": "true" },
        expanded ? "▾" : "▸"
      )
    ),
    expanded
      ? h(
          "div",
          { className: "workspace-changes-body" },
          renderDiffContent(state)
        )
      : null,
    !expanded && isError
      ? h(
          "p",
          { className: "workspace-changes-error-inline" },
          `Failed to load: ${state.error}`
        )
      : null
  );
}

function renderStatsBadge(state, stats) {
  if (state.status === "idle" && !state.data) {
    return h("span", { className: "workspace-changes-row-pending" }, "—");
  }
  if (state.status === "loading" && !state.data) {
    return h("span", { className: "workspace-changes-row-pending" }, "…");
  }
  if (state.data?.not_a_git_repo) {
    return h("span", { className: "workspace-changes-row-empty" }, "no git");
  }
  if (stats.fileCount === 0) {
    return h("span", { className: "workspace-changes-row-empty" }, "clean");
  }
  return h(
    "span",
    { className: "workspace-changes-row-stats" },
    stats.added > 0
      ? h("span", { className: "workspace-changes-add" }, `+${stats.added}`)
      : null,
    stats.removed > 0
      ? h("span", { className: "workspace-changes-del" }, `-${stats.removed}`)
      : null
  );
}

function renderDiffContent(state) {
  if (state.status === "loading" && !state.data) {
    return h("p", { className: "diff-file-empty" }, "Loading…");
  }
  if (state.status === "error" && !state.data) {
    return h(
      "p",
      { className: "diff-file-empty" },
      `Failed to load diff: ${state.error}`
    );
  }
  const data = state.data;
  if (!data) {
    return h("p", { className: "diff-file-empty" }, "No data yet.");
  }
  if (data.not_a_git_repo) {
    return h(
      "p",
      { className: "diff-file-empty" },
      "This workspace is not a git repository."
    );
  }
  const fileChanges = data.file_changes || [];
  if (fileChanges.length === 0) {
    return h(
      "p",
      { className: "diff-file-empty" },
      "Working tree is clean — no uncommitted changes."
    );
  }
  return h(FileChangeDiff, {
    tool: {
      item_type: "workspaceDiff",
      file_changes: fileChanges,
      diff: data.diff,
      display_options: { currentCwd: data.cwd },
    },
  });
}

const TERMINAL_REVIEW = new Set(["complete", "failed", "cancelled"]);

// The "Changes" entry point on mobile — pure file-diff stats. Review state lives
// on the separate ReviewerChip so each pill is a single, self-describing target.
export function WorkspaceDiffChip({ store, onTap }) {
  const state = useStoreState(store);
  const stats = computeChangeStats(state.data);
  const isClean = state.status === "loaded" && stats.fileCount === 0;
  const notRepo = state.data?.not_a_git_repo;
  if (notRepo) return null;
  if (state.status === "idle" && !state.data) return null;
  if (isClean) return null;
  return h(
    "button",
    {
      type: "button",
      className: "workspace-diff-chip",
      onClick: () => onTap?.(),
      title: "Tap to view file diffs",
    },
    h(
      "span",
      { className: "workspace-diff-chip-label" },
      stats.fileCount === 1 ? "1 file" : `${stats.fileCount} files`
    ),
    h("span", { className: "workspace-diff-chip-sep" }, "·"),
    stats.added > 0
      ? h("span", { className: "workspace-diff-chip-add" }, `+${stats.added}`)
      : null,
    stats.removed > 0
      ? h("span", { className: "workspace-diff-chip-del" }, `−${stats.removed}`)
      : null
  );
}

// A dedicated, self-describing "Reviewer" pill for mobile (the desktop rail has
// the tab instead). It surfaces whenever there's a review to see OR one can be
// started, and tapping it opens the right panel straight on the Reviewer tab.
// Shares `.workspace-diff-chip` base styles so it's mobile-only and pill-shaped.
export function ReviewerChip({ store, onTap }) {
  const state = useStoreState(store);
  const review = state.review || {};
  const reviewJobs = review.reviewJobs || [];
  const blocked = Boolean(review.blocked);
  const active = reviewJobs.some((job) => !TERMINAL_REVIEW.has(job.status));
  const hasReviews = reviewJobs.length > 0;
  // Only surface once there's an actual review to track (in progress / blocked /
  // done) — that's when the status badge carries signal. In the pure-idle "you
  // could start one" state the chip says nothing and just competes for composer
  // space with the diff chip and the "Want a second opinion?" idle nudge already
  // shown there, so stay hidden and let those handle discovery + launch.
  if (!hasReviews) return null;
  const badge = blocked ? "⚠" : active ? "•" : hasReviews ? "✓" : null;
  const modifier = blocked
    ? "is-blocked"
    : active
    ? "is-active"
    : hasReviews
    ? "is-done"
    : "is-idle";
  const title = blocked
    ? "Review blocked — tap to resolve"
    : active
    ? "Review in progress — tap to view"
    : hasReviews
    ? "Review complete — tap to view findings"
    : "Ask another agent to review — tap to start";
  return h(
    "button",
    {
      type: "button",
      className: `workspace-diff-chip reviewer-chip ${modifier}`,
      onClick: () => onTap?.(),
      title,
    },
    h("span", { className: "reviewer-chip-icon", "aria-hidden": "true" }, "🔍"),
    h("span", { className: "workspace-diff-chip-label" }, "Reviewer"),
    badge
      ? h(
          "span",
          { className: `workspace-diff-chip-review ${modifier}`, "aria-hidden": "true" },
          badge
        )
      : null
  );
}

export function mountReviewerChip({ store, mount, onTap }) {
  if (!mount) return null;
  const root = createRoot(mount);
  root.render(h(ReviewerChip, { store, onTap }));
  return {
    destroy() {
      root.unmount();
    },
  };
}

export function WorkspaceDiffSheetBody({ store }) {
  const state = useStoreState(store);
  return h(
    "div",
    { className: "workspace-diff-sheet-body" },
    state.data?.cwd
      ? h(
          "div",
          { className: "workspace-diff-status" },
          h(
            "span",
            { className: "workspace-diff-cwd", title: state.data.cwd },
            state.data.cwd
          ),
          state.data?.truncated
            ? h(
                "span",
                { className: "workspace-diff-warning" },
                "Output truncated (large diff)."
              )
            : null
        )
      : null,
    renderDiffContent(state)
  );
}
