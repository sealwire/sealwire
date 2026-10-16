// What the location menu lists: pure, so the rules about which action a branch offers
// are tested without a browser.

const SHORT_LIST = 12;

/**
 * Rows for the folder's branches. A branch offers exactly one way in: it is the current
 * one, it is open in another worktree (go there), or it can be switched to here or opened
 * in a new worktree. `busy` is why switching here is refused right now.
 */
export function branchMenuModel({ data, query = "", showAll = false }) {
  if (!data) {
    return { local: [], remote: [], hidden: 0, worktrees: [] };
  }
  const needle = query.trim().toLowerCase();
  const matches = (name) => !needle || name.toLowerCase().includes(needle);
  const localNames = new Set(data.branches.filter((branch) => !branch.remote).map((branch) => branch.name));
  const local = data.branches
    .filter((branch) => !branch.remote && matches(branch.name))
    .map((branch) => ({
      name: branch.name,
      action:
        branch.name === data.current
          ? "current"
          : branch.worktree
            ? "open"
            : "switch",
      worktree: branch.worktree || null,
      switchBlocked: data.busy || null,
    }));
  // A remote branch that already has a local namesake is reached through that one.
  const remote = data.branches
    .filter((branch) => branch.remote && matches(branch.name))
    .filter((branch) => !localNames.has(branch.name.slice(branch.name.indexOf("/") + 1)))
    .map((branch) => ({ name: branch.name, action: "switch", worktree: null, switchBlocked: data.busy || null }));
  const shown = needle || showAll ? local : local.slice(0, SHORT_LIST);
  const worktrees = (data.worktrees || []).filter((tree) => matches(`${tree.path} ${tree.branch || ""}`));
  return { local: shown, remote, hidden: local.length - shown.length, worktrees };
}
