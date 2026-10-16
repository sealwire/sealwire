// The Changes list, grouped by the session that last wrote each file. Pure, so the
// grouping rules are tested without a browser.

/** Groups in a stable order: sessions by title, then the files no session wrote. */
export function groupChanges(entries = [], sessions = []) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const groups = new Map();
  for (const entry of entries) {
    const id = entry.session && byId.has(entry.session) ? entry.session : null;
    if (!groups.has(id)) {
      const session = id ? byId.get(id) : null;
      groups.set(id, {
        id,
        title: session ? session.title || null : null,
        provider: session?.provider || null,
        entries: [],
      });
    }
    groups.get(id).entries.push(entry);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.entries.sort((a, b) => a.path.localeCompare(b.path));
  }
  return list.sort((a, b) => {
    if (!a.id !== !b.id) {
      return a.id ? -1 : 1;
    }
    return String(a.title || a.id || "").localeCompare(String(b.title || b.id || ""));
  });
}

/**
 * The ticked files after the list was read again. Nothing is ticked until the user ticks it
 * (a group's box takes a session's files in one go): a folder's changes can include files
 * nobody meant to commit, like a dev setup's swapped-in sources or an untracked scratch file.
 * Files gone from the list drop out.
 */
export function nextSelection(previous, root, paths) {
  if (!previous || previous.root !== root) {
    return { root, ticked: [] };
  }
  const ticked = new Set(previous.ticked);
  return { root, ticked: paths.filter((path) => ticked.has(path)) };
}
