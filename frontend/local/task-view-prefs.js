// Whether the Tasks screen opens as the list or the board, persisted client-side.
//
// Same failure policy as `task-seen-prefs.js`: storage unavailable or corrupt
// degrades to the default, never throws. A lost preference costs one click.

const KEY = "sealwire:tasks-view-mode";
const MODES = new Set(["list", "board"]);
const DEFAULT_MODE = "list";

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // access itself can throw (privacy mode, disabled storage)
  }
}

export function loadTaskViewMode() {
  try {
    const stored = storage()?.getItem(KEY);
    return MODES.has(stored) ? stored : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/** Returns the mode actually stored, so the caller can render from it directly. */
export function saveTaskViewMode(mode) {
  const next = MODES.has(mode) ? mode : DEFAULT_MODE;
  try {
    storage()?.setItem(KEY, next);
  } catch {
    // Quota or unavailable: the returned value still drives this session.
  }
  return next;
}
