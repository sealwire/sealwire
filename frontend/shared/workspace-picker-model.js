// Grouped by repository even though the relay only ever sends one repo's worktrees, so
// that constraint can be relaxed later without reshaping the panel.

import { t } from "./i18n.js";
import { abbreviateHomePath, pathBasename } from "./workspace-chip-model.js";

/// Absent `changed_files` means "not measured" and must render as NOTHING: "clean" is a
/// claim we cannot back, and it is the answer that stops someone looking.
export function workspaceRootStatus(root) {
  const count = root?.changed_files;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
    return null;
  }
  if (count === 0) {
    return { tone: "clean", text: t("clean") };
  }
  // Counting stops at a cap so a tree full of build output cannot stream megabytes
  // of `git status` at us; past it the true number is unknown, so say so.
  const capped = root?.changed_files_capped === true;
  let text;
  if (capped) {
    text = t("{count}+ files changed", { count });
  } else if (count === 1) {
    text = t("{count} file changed", { count });
  } else {
    text = t("{count} files changed", { count });
  }
  return { tone: "changes", text };
}

/** "9 worktrees" / "1 worktree" — the group header's subtitle. */
export function worktreeCountLabel(count) {
  const n = Number.isFinite(count) && count > 0 ? count : 0;
  return n === 1 ? t("{count} worktree", { count: n }) : t("{count} worktrees", { count: n });
}

/// The relay does not label roots with a repo, so it is derived from the main
/// worktree's directory name.
function repoNameFor(roots) {
  const main = roots.find((root) => root?.is_main);
  return pathBasename(main?.path || roots[0]?.path || "") || "repository";
}

function matchesQuery(row, needle) {
  if (!needle) {
    return true;
  }
  return (
    row.branch.toLowerCase().includes(needle)
    || row.dirName.toLowerCase().includes(needle)
    || row.repo.toLowerCase().includes(needle)
    // Path last: it contains both of the above, so it only ever ADDS matches (a
    // query naming an intermediate directory), never changes what the others found.
    || row.path.toLowerCase().includes(needle)
  );
}

/// Keeps the relay's order: re-sorting by branch or dirtiness would move rows under the
/// cursor exactly when a tree's status changed.
export function buildWorktreeGroups({
  roots = [],
  selectedPath = "",
  sessionPath = "",
  query = "",
} = {}) {
  const list = (Array.isArray(roots) ? roots : []).filter(
    (root) => root && typeof root.path === "string" && root.path
  );
  const repo = repoNameFor(list);
  const needle = String(query || "").trim().toLowerCase();

  const rows = list.map((root) => {
    const isMain = root.is_main === true;
    const isSession = Boolean(sessionPath) && root.path === sessionPath;
    return {
      path: root.path,
      // A detached worktree has no branch, but the row's primary line cannot be blank.
      branch: root.branch || "detached",
      detached: !root.branch,
      dirName: pathBasename(root.path),
      repo: root.repo || repo,
      isMain,
      isSession,
      isSelected: Boolean(selectedPath) && root.path === selectedPath,
      status: workspaceRootStatus(root),
      // Presentational triple, shared with `buildSuggestionGroups` so one renderer
      // serves both the worktree list and the dialogs' plain path list.
      primary: root.branch || "detached",
      secondary: pathBasename(root.path),
      badges: [
        // Distinguishes the repo's own checkout from the linked worktrees under it.
        isMain ? "checkout" : null,
        // Replaces the removed "Follow session" button: this row is the way back to
        // following the session, so it has to be findable.
        isSession ? t("session") : null,
      ].filter(Boolean),
    };
  });

  const visible = rows.filter((row) => matchesQuery(row, needle));

  // Insertion-ordered, so groups appear in the order the relay listed their roots.
  const byRepo = new Map();
  for (const row of visible) {
    if (!byRepo.has(row.repo)) {
      byRepo.set(row.repo, []);
    }
    byRepo.get(row.repo).push(row);
  }

  const groups = [...byRepo.entries()].map(([name, groupRows]) => ({
    key: name,
    repo: name,
    title: name,
    subtitle: worktreeCountLabel(groupRows.length),
    // Counts what the filter LEFT, not the repo's true size: a header reading
    // "9 worktrees" above 2 visible rows reads as a rendering bug.
    count: groupRows.length,
    countLabel: worktreeCountLabel(groupRows.length),
    rows: groupRows,
  }));

  return { groups, total: rows.length, matched: visible.length };
}

/// The dialogs' list: arbitrary directories with a provenance label, not git metadata.
/// Untitled, because "repository" is not a thing these rows have in common.
export function buildSuggestionGroups({
  suggestions = [],
  selectedPath = "",
  query = "",
} = {}) {
  const list = (Array.isArray(suggestions) ? suggestions : []).filter(
    (entry) => entry && typeof entry.cwd === "string" && entry.cwd
  );
  const needle = String(query || "").trim().toLowerCase();

  const rows = list.map((entry) => ({
    path: entry.cwd,
    // Home-abbreviated for width; the SUBMITTED value stays `entry.cwd` verbatim,
    // because `normalize_cwd` works on real paths and owes a `~` nothing.
    primary: abbreviateHomePath(entry.cwd),
    secondary: entry.label || null,
    status: null,
    badges: [],
    isSelected: Boolean(selectedPath) && entry.cwd === selectedPath,
    isMain: false,
    isSession: false,
    branch: "",
    dirName: pathBasename(entry.cwd),
    repo: "",
  }));

  const visible = rows.filter(
    (row) =>
      !needle
      || row.path.toLowerCase().includes(needle)
      || String(row.secondary || "").toLowerCase().includes(needle)
  );

  const groups = visible.length
    ? [{ key: "suggestions", repo: "", title: null, subtitle: null, count: visible.length, countLabel: "", rows: visible }]
    : [];

  return { groups, total: rows.length, matched: visible.length };
}

/// The one input both filters and takes a path, because typing one is the dialogs' only
/// way to name a directory the relay has never seen. The shape is the tiebreak.
export function looksLikePath(text) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.startsWith("/")
    || trimmed.startsWith("~")
    // `normalize_cwd` absolutizes these, so they name real directories. Anchored on the
    // separator so `.claude` and `..foo` stay filter text.
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    // Exactly the directories they look like, and neither is worth filtering by.
    || trimmed === "."
    || trimmed === ".."
  );
}

/// A bare relative path (`sibling-repo`) is one the relay resolves but shape cannot
/// distinguish from a filter word. Outcome can: text that matched nothing was no filter.
export function canCommitDraft(text, matched) {
  return looksLikePath(text) || (Boolean(String(text || "").trim()) && matched === 0);
}
