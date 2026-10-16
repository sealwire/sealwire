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
 * The ticked files after the list was read again. A folder's first list comes ticked;
 * after that a file new to the list waits for the user to tick it, so nothing an agent
 * writes meanwhile rides along in a commit unseen. Files gone from the list drop out.
 */
export function nextSelection(previous, root, paths) {
  if (!previous || previous.root !== root) {
    return { root, ticked: [...paths] };
  }
  const ticked = new Set(previous.ticked);
  return { root, ticked: paths.filter((path) => ticked.has(path)) };
}
