// The Editor's History: branches on the left, and a History tab with the log, the picked
// commit's files and one file's change. Read-only; the branch actions are the location
// menu's, with the same limits.

import React from "react";

import { t } from "../../shared/i18n.js";
import { relativeTime } from "../../shared/settings-model.js";
import { ContextMenu, MenuItem, MenuSeparator } from "../../shared/context-menu-react.js";
import { branchMenuModel } from "./branch-menu-model.js";
import { baseName, dirName, useStore } from "./editor-ui.js";
import { layoutGraph } from "./history-graph.js";
import { graphApplies } from "./history-store.js";

const h = React.createElement;
const { useEffect, useMemo, useRef, useState } = React;

const ROW_HEIGHT = 26;
const LANE_WIDTH = 12;
const MAX_LANES = 12;
const LANE_COLORS = 6;
const FILTER_DELAY_MS = 300;

function shortId(id) {
  return String(id || "").slice(0, 8);
}

/** The tab for History in the Editor's tab strip, ahead of the file tabs. */
export function HistoryTab({ active, onFocus, onClose }) {
  return h(
    "div",
    {
      className: ["editor-tab", "is-history", active ? "is-active" : ""].filter(Boolean).join(" "),
      role: "tab",
      "aria-selected": active,
      "data-history-tab": "",
      onClick: onFocus,
      onMouseDown: (event) => {
        if (event.button === 1) {
          event.preventDefault();
          onClose();
        }
      },
    },
    h("span", { className: "editor-tab-label" }, t("History")),
    h(
      "button",
      {
        className: "editor-tab-close",
        type: "button",
        "aria-label": t("Close {title}", { title: t("History") }),
        onClick: (event) => {
          event.stopPropagation();
          onClose();
        },
      },
      "×"
    )
  );
}

function BranchTreeRow({ label, note = null, selected, onClick, onContextMenu, title, dataName }) {
  return h(
    "button",
    {
      type: "button",
      className: ["editor-tree-row", "editor-history-branch", selected ? "is-active" : ""].filter(Boolean).join(" "),
      title: title || label,
      "data-branch": dataName,
      onClick,
      onContextMenu,
    },
    h("span", { className: "editor-tree-twisty" }),
    h("span", { className: "editor-tree-name" }, label),
    note ? h("span", { className: "editor-tree-dir" }, note) : null
  );
}

/** The left panel while History is picked: worktrees, local and remote branches. */
export function HistoryPanel({ store, history }) {
  const root = useStore(store, (state) => state.root);
  const branches = useStore(store, (state) => state.branches);
  const filters = useStore(history, (state) => state.filters);
  const [menu, setMenu] = useState(null);
  useEffect(() => {
    void store.loadBranches();
  }, [store, root]);
  const data = branches.data?.root === root ? branches.data : null;
  const model = branchMenuModel({ data, showAll: true });
  const acting = branches.acting === true;

  const showBranch = (name, remote) => {
    store.showHistory();
    void history.setFilters({ branch: name, remote });
  };
  const openMenu = (row, remote) => (event) => {
    event.preventDefault();
    setMenu({ row, remote, x: event.clientX, y: event.clientY });
  };
  const branchRows = (rows, remote) =>
    rows.map((row) =>
      h(BranchTreeRow, {
        key: row.name,
        label: row.name,
        dataName: row.name,
        note: row.action === "current" ? t("Current") : row.worktree ? t("in {name}", { name: baseName(row.worktree) }) : null,
        selected: filters.branch === row.name && filters.remote === remote,
        onClick: () => showBranch(row.name, remote),
        onContextMenu: openMenu(row, remote),
      })
    );

  return h(
    "div",
    { className: "editor-tree editor-history-tree" },
    branches.error ? h("div", { className: "editor-menu-error", role: "alert" }, branches.error) : null,
    h(BranchTreeRow, {
      label: t("All branches"),
      selected: !filters.branch,
      onClick: () => {
        store.showHistory();
        void history.setFilters({ branch: null, remote: false });
      },
    }),
    branches.loading && !data ? h("div", { className: "editor-tree-note" }, t("Loading…")) : null,
    model.local.length ? h("div", { className: "editor-history-heading" }, t("Local")) : null,
    ...branchRows(model.local, false),
    model.remote.length ? h("div", { className: "editor-history-heading" }, t("Remote")) : null,
    ...branchRows(model.remote, true),
    model.worktrees.length ? h("div", { className: "editor-history-heading" }, t("Worktrees")) : null,
    ...model.worktrees.map((tree) =>
      h(BranchTreeRow, {
        key: tree.path,
        label: tree.branch ? `${baseName(tree.path)} · ${tree.branch}` : baseName(tree.path),
        title: tree.path,
        selected: tree.path === root,
        onClick: () => {
          if (tree.path !== root) {
            void store.setRoot(tree.path);
          }
          store.showHistory();
        },
      })
    ),
    menu
      ? h(
          ContextMenu,
          { anchor: menu, ariaLabel: t("Branch {name}", { name: menu.row.name }), onClose: () => setMenu(null) },
          h(MenuItem, {
            label: t("Show history"),
            onSelect: () => {
              setMenu(null);
              showBranch(menu.row.name, menu.remote);
            },
          }),
          h(MenuSeparator, null),
          menu.row.action === "open"
            ? h(MenuItem, {
                label: t("Open its worktree"),
                onSelect: () => {
                  setMenu(null);
                  void store.setRoot(menu.row.worktree);
                },
              })
            : h(MenuItem, {
                label: t("Switch here"),
                disabled: acting || menu.row.action === "current" || Boolean(menu.row.switchBlocked),
                onSelect: () => {
                  setMenu(null);
                  void store.switchBranch({ branch: menu.row.name, remote: menu.remote });
                },
              }),
          h(MenuItem, {
            label: t("Open in a new worktree"),
            disabled: acting || menu.row.action !== "switch",
            onSelect: () => {
              setMenu(null);
              void store.addWorktree({ branch: menu.row.name, remote: menu.remote });
            },
          })
        )
      : null
  );
}

function GraphCell({ row, lanes }) {
  const width = lanes * LANE_WIDTH + 4;
  const x = (lane) => Math.min(lane, MAX_LANES) * LANE_WIDTH + LANE_WIDTH / 2;
  const mid = ROW_HEIGHT / 2;
  const line = (key, x1, y1, x2, y2, lane) =>
    h("line", { key, x1, y1, x2, y2, className: `editor-graph-lane is-lane-${lane % LANE_COLORS}` });
  return h(
    "svg",
    { className: "editor-graph", width, height: ROW_HEIGHT, "aria-hidden": "true" },
    ...row.top.map(([from, to], index) => line(`t${index}`, x(from), 0, x(to), mid, from)),
    ...row.bottom.map(([from, to], index) => line(`b${index}`, x(from), mid, x(to), ROW_HEIGHT, to)),
    h("circle", { cx: x(row.column), cy: mid, r: 3.5, className: `editor-graph-dot is-lane-${row.column % LANE_COLORS}` })
  );
}

function RefBadges({ refs }) {
  if (!refs?.length) {
    return null;
  }
  return h(
    "span",
    { className: "editor-history-refs" },
    ...refs.map((name) =>
      h(
        "span",
        { key: name, className: name.startsWith("HEAD") ? "editor-history-ref is-head" : "editor-history-ref" },
        name.replace(/^HEAD -> /, "")
      )
    )
  );
}

function FilterInput({ value, placeholder, label, onChange }) {
  const [text, setText] = useState(value);
  const timer = useRef(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return h("input", {
    type: "search",
    className: "editor-history-filter",
    value: text,
    placeholder,
    "aria-label": label,
    spellCheck: false,
    autoComplete: "off",
    onChange: (event) => {
      const next = event.target.value;
      setText(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => onChange(next), FILTER_DELAY_MS);
    },
  });
}

/** One file of a commit, before and after it, read-only. */
function CommitFileDiff({ file }) {
  const hostRef = useRef(null);
  const data = file.data;
  const showable = data && !data.binary && !data.too_large;
  const original = showable ? data.before ?? "" : null;
  const text = showable ? data.after ?? "" : null;
  useEffect(() => {
    if (!showable) {
      return undefined;
    }
    let cancelled = false;
    let view = null;
    void import("./code-editor.js").then((mod) => {
      if (!cancelled && hostRef.current) {
        view = mod.createDiffView(hostRef.current, { original, text, path: file.path });
      }
    });
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [showable, original, text, file.path]);

  if (file.loading) {
    return h("div", { className: "editor-tree-note" }, t("Loading…"));
  }
  if (file.error) {
    return h("div", { className: "editor-tree-note", role: "alert" }, file.error);
  }
  if (!data) {
    return h("div", { className: "editor-tree-note" }, t("Pick a file to see what this commit changed in it."));
  }
  if (data.too_large) {
    return h("div", { className: "editor-tree-note" }, t("This file is too large to show here."));
  }
  if (data.binary) {
    return h("div", { className: "editor-tree-note" }, t("This file is not text, so its change cannot be shown."));
  }
  const note = data.before == null
    ? t("Added in this commit")
    : data.after == null
      ? t("Deleted in this commit")
      : t("Compared with the commit before");
  return h(
    React.Fragment,
    null,
    h("div", { className: "editor-panel-diff-note" }, note),
    h("div", { className: "editor-panel-diff editor-history-diff", ref: hostRef })
  );
}

function CommitDetail({ store, history }) {
  const detail = useStore(history, (state) => state.detail);
  const file = useStore(history, (state) => state.file);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [detail.id]);
  if (detail.loading) {
    return h("div", { className: "editor-history-detail" }, h("div", { className: "editor-tree-note" }, t("Loading…")));
  }
  if (detail.error || !detail.data) {
    return h(
      "div",
      { className: "editor-history-detail" },
      h("div", { className: "editor-tree-note", role: detail.error ? "alert" : undefined }, detail.error || "")
    );
  }
  const commit = detail.data;
  const [subject, ...body] = String(commit.message || "").replace(/\s+$/, "").split("\n");
  return h(
    "div",
    { className: "editor-history-detail" },
    h(
      "div",
      { className: "editor-history-info" },
      h("div", { className: "editor-history-subject" }, subject),
      body.join("\n").trim() ? h("pre", { className: "editor-history-body" }, body.join("\n").trim()) : null,
      h(
        "div",
        { className: "editor-history-meta" },
        h("span", { title: commit.email }, commit.author),
        h("span", null, commit.time ? new Date(commit.time * 1000).toLocaleString() : ""),
        h(
          "button",
          {
            type: "button",
            className: "editor-history-id",
            title: t("Copy the full commit id"),
            onClick: () => {
              void globalThis.navigator?.clipboard?.writeText?.(commit.id)?.then?.(() => setCopied(true));
            },
          },
          copied ? t("Copied") : shortId(commit.id)
        )
      ),
      h(
        "div",
        { className: "editor-history-files", role: "list" },
        commit.files.length
          ? null
          : h("div", { className: "editor-tree-note" }, t("No files in this folder changed in this commit.")),
        ...commit.files.map((entry) =>
          h(
            "div",
            {
              key: entry.path,
              role: "listitem",
              className: [
                "editor-change-row",
                `is-status-${{ A: "added", D: "deleted", R: "renamed" }[entry.status] || "modified"}`,
                file.path === entry.path ? "is-active" : "",
              ].filter(Boolean).join(" "),
              "data-path": entry.path,
            },
            h(
              "button",
              {
                type: "button",
                className: "editor-change-open",
                title: entry.old_path ? `${entry.old_path} → ${entry.path}` : entry.path,
                onClick: () => void history.openFile(entry),
              },
              h("span", { className: "editor-tree-name" }, baseName(entry.path)),
              dirName(entry.path) ? h("span", { className: "editor-tree-dir" }, dirName(entry.path)) : null
            ),
            entry.status !== "D"
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "editor-history-open",
                    title: t("Open the file as it is now"),
                    onClick: () => store.openFile(entry.path),
                  },
                  t("Open")
                )
              : null,
            h("span", { className: "editor-tree-status" }, entry.status)
          )
        ),
        commit.truncated
          ? h("div", { className: "editor-tree-note" }, t("Only the first 2,000 files are listed."))
          : null
      )
    ),
    h("div", { className: "editor-history-change" }, h(CommitFileDiff, { file }))
  );
}

/** The History tab: filters, the log with its graph, and the picked commit. */
export function HistoryView({ store, history }) {
  const root = useStore(store, (state) => state.root);
  const filters = useStore(history, (state) => state.filters);
  const log = useStore(history, (state) => state.log);
  const selected = useStore(history, (state) => state.selected);
  useEffect(() => {
    void history.show(root);
  }, [history, root]);
  const drawGraph = graphApplies(filters);
  const rows = useMemo(() => (drawGraph ? layoutGraph(log.commits) : null), [drawGraph, log.commits]);
  const lanes = rows ? Math.min(MAX_LANES, Math.max(1, ...rows.map((row) => row.width))) : 0;

  let list;
  if (!log.isRepo) {
    list = h("div", { className: "editor-tree-note" }, t("This folder is not in a git repository."));
  } else if (!log.complete) {
    list = h("div", { className: "editor-tree-note" }, t("Git took too long to read the history."));
  } else if (log.error && !log.commits.length) {
    list = h("div", { className: "editor-tree-note", role: "alert" }, log.error);
  } else if (log.loading && !log.commits.length) {
    list = h("div", { className: "editor-tree-note" }, t("Loading…"));
  } else if (!log.commits.length) {
    list = h("div", { className: "editor-tree-note" }, t("No commits match."));
  } else {
    list = h(
      React.Fragment,
      null,
      ...log.commits.map((commit, index) =>
        h(
          "button",
          {
            key: commit.id,
            type: "button",
            className: ["editor-history-row", commit.id === selected ? "is-selected" : ""].filter(Boolean).join(" "),
            "data-commit": commit.id,
            "aria-pressed": commit.id === selected,
            onClick: () => void history.select(commit.id),
          },
          rows ? h(GraphCell, { row: rows[index], lanes }) : null,
          h(
            "span",
            { className: "editor-history-title" },
            h(RefBadges, { refs: commit.refs }),
            h("span", { className: "editor-history-text" }, commit.subject)
          ),
          h("span", { className: "editor-history-author" }, commit.author),
          h("span", { className: "editor-history-when", title: new Date(commit.time * 1000).toLocaleString() }, relativeTime(commit.time)),
          h("span", { className: "editor-history-short" }, shortId(commit.id))
        )
      ),
      log.more
        ? h(
            "button",
            {
              type: "button",
              className: "editor-menu-more editor-history-more",
              disabled: log.loading,
              onClick: () => void history.load({ append: true }),
            },
            log.loading ? t("Loading…") : t("Show older commits")
          )
        : null
    );
  }

  return h(
    "div",
    { className: selected ? "editor-history has-detail" : "editor-history" },
    h(
      "div",
      { className: "editor-history-bar" },
      filters.branch
        ? h(
            "span",
            { className: "editor-history-chip", title: filters.branch },
            filters.branch,
            h(
              "button",
              {
                type: "button",
                className: "editor-history-chip-clear",
                "aria-label": t("Show every branch"),
                onClick: () => void history.setFilters({ branch: null, remote: false }),
              },
              "×"
            )
          )
        : h("span", { className: "editor-history-chip is-all" }, t("All branches")),
      h(FilterInput, {
        value: filters.query,
        placeholder: t("Search messages"),
        label: t("Search commit messages"),
        onChange: (query) => void history.setFilters({ query }),
      }),
      h(FilterInput, {
        value: filters.author,
        placeholder: t("Author"),
        label: t("Filter by author"),
        onChange: (author) => void history.setFilters({ author }),
      }),
      h(FilterInput, {
        value: filters.path,
        placeholder: t("Path"),
        label: t("Filter by path"),
        onChange: (path) => void history.setFilters({ path }),
      }),
      h(
        "button",
        { type: "button", className: "editor-button", disabled: log.loading, onClick: () => void history.load() },
        t("Refresh")
      )
    ),
    log.error && log.commits.length ? h("div", { className: "editor-menu-error", role: "alert" }, log.error) : null,
    h("div", { className: "editor-history-list" }, list),
    selected ? h(CommitDetail, { store, history }) : null
  );
}
