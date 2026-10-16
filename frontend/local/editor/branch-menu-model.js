// What the location menu lists: pure, so the rules about which action a branch offers
// are tested without a browser.

const SHORT_LIST = 12;
const SHORT_WORKTREES = 5;
// A prefix shared by this many branches folds into one row: a repository with a dozen
// `backup/…` branches otherwise fills the menu with names that differ only past the cut.
const FOLD_AT = 3;

function baseName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "";
}

function parentName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 2] || "";
}

function prefixOf(name) {
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(0, slash + 1) : null;
}

/**
 * Rows for the folder's branches. A branch offers exactly one way in: it is the current
 * one, it is open in another worktree (go there), or it can be switched to here or opened
 * in a new worktree. `busy` is why switching here is refused right now.
 *
 * Without a search, branches sharing a prefix fold into a `kind: "group"` row; `openGroups`
 * lists the prefixes the user opened, whose branches follow labelled without the prefix.
 */
export function branchMenuModel({
  data,
  query = "",
  showAll = false,
  openGroups = [],
  root = null,
  showAllWorktrees = false,
}) {
  if (!data) {
    return { local: [], remote: [], hidden: 0, worktrees: [], hiddenWorktrees: 0 };
  }
  const needle = query.trim().toLowerCase();
  const matches = (name) => !needle || name.toLowerCase().includes(needle);
  const localNames = new Set(data.branches.filter((branch) => !branch.remote).map((branch) => branch.name));
  const rows = data.branches
    .filter((branch) => !branch.remote && matches(branch.name))
    .map((branch) => ({
      name: branch.name,
      label: branch.name,
      action:
        branch.name === data.current
          ? "current"
          : branch.worktree
            ? "open"
            : "switch",
      worktree: branch.worktree || null,
      switchBlocked: data.busy || null,
    }));

  let listed = rows;
  if (!needle) {
    const counts = new Map();
    for (const row of rows) {
      const prefix = row.action === "current" ? null : prefixOf(row.name);
      if (prefix) {
        counts.set(prefix, (counts.get(prefix) || 0) + 1);
      }
    }
    listed = [];
    const placed = new Set();
    for (const row of rows) {
      const prefix = row.action === "current" ? null : prefixOf(row.name);
      if (!prefix || counts.get(prefix) < FOLD_AT) {
        listed.push(row);
        continue;
      }
      const open = openGroups.includes(prefix);
      if (!placed.has(prefix)) {
        placed.add(prefix);
        listed.push({ kind: "group", name: null, prefix, count: counts.get(prefix), open });
      }
      if (open) {
        listed.push({ ...row, label: row.name.slice(prefix.length), group: prefix });
      }
    }
  }

  // A remote branch that already has a local namesake is reached through that one.
  const remote = data.branches
    .filter((branch) => branch.remote && matches(branch.name))
    .filter((branch) => !localNames.has(branch.name.slice(branch.name.indexOf("/") + 1)))
    .map((branch) => ({ name: branch.name, label: branch.name, action: "switch", worktree: null, switchBlocked: data.busy || null }));
  const shown = needle || showAll ? listed : listed.slice(0, SHORT_LIST);

  const matchedTrees = (data.worktrees || []).filter((tree) => matches(`${tree.path} ${tree.branch || ""}`));
  const nameCounts = new Map();
  for (const tree of matchedTrees) {
    nameCounts.set(baseName(tree.path), (nameCounts.get(baseName(tree.path)) || 0) + 1);
  }
  const labelled = matchedTrees.map((tree) => {
    const name = baseName(tree.path);
    return { ...tree, label: nameCounts.get(name) > 1 ? `${name} (${parentName(tree.path)})` : name };
  });
  let worktrees = labelled;
  if (!needle && !showAllWorktrees && labelled.length > SHORT_WORKTREES) {
    worktrees = labelled.slice(0, SHORT_WORKTREES);
    const current = root ? labelled.find((tree) => tree.path === root) : null;
    if (current && !worktrees.includes(current)) {
      worktrees[SHORT_WORKTREES - 1] = current;
    }
  }
  return {
    local: shown,
    remote,
    hidden: listed.length - shown.length,
    worktrees,
    hiddenWorktrees: labelled.length - worktrees.length,
  };
}
