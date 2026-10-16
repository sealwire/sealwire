// What the Editor screen knows: which folder is on screen, its file tree, the open
// tabs, and every open document with its save state.
//
// Saving is the part with rules. Every write quotes the revision the editor last saw,
// and the relay refuses it if the file moved on (an agent wrote it), so neither side
// silently loses the other's work. Autosave only changes WHEN a save is attempted.

import { createStore } from "zustand/vanilla";

import { nextSelection } from "./changes-model.js";

export const AUTOSAVE_DELAY_MS = 1000;
const SESSION_KEY = "sealwire:editor-session";
const DRAFTS_KEY = "sealwire:editor-drafts";

/** One document per folder + path: the same file name in two worktrees is two files. */
export function docKey(root, path) {
  return `${root}\n${path}`;
}

export function keyRoot(key) {
  return key.slice(0, key.indexOf("\n"));
}

export function keyPath(key) {
  return key.slice(key.indexOf("\n") + 1);
}

function baseName(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "";
}

/** Lines the user added between `base` and `mine`, ignoring blank ones. */
function addedLines(base, mine) {
  const pool = new Map();
  for (const line of String(base).split("\n")) {
    pool.set(line, (pool.get(line) || 0) + 1);
  }
  const added = [];
  for (const line of String(mine).split("\n")) {
    const left = pool.get(line) || 0;
    if (left > 0) {
      pool.set(line, left - 1);
    } else if (line.trim()) {
      added.push(line);
    }
  }
  return added;
}

/** Whether every line the user added is still in `next`. */
export function editsSurvive(base, mine, next) {
  const pool = new Map();
  for (const line of String(next).split("\n")) {
    pool.set(line, (pool.get(line) || 0) + 1);
  }
  for (const line of addedLines(base, mine)) {
    const left = pool.get(line) || 0;
    if (!left) {
      return false;
    }
    pool.set(line, left - 1);
  }
  return true;
}

function newDoc(path) {
  return {
    path,
    loading: true,
    error: null,
    revision: null,
    // What is on disk as far as the editor knows, and what the user has typed.
    savedText: "",
    text: "",
    dirty: false,
    saving: false,
    saveError: null,
    // { diskText, diskRevision } when a save was refused because the file changed.
    conflict: null,
    // { mine, theirs } when a change on disk replaced lines this editor had saved.
    overwritten: null,
    missing: false,
    binary: false,
    tooLarge: false,
    readonly: false,
    // Bumped whenever the store replaces the text itself, so the editor view knows to
    // take it; edits coming FROM the view never bump it.
    externalVersion: 0,
    // Bumped when a quiet reload brought in someone else's change.
    reloadedAt: 0,
    // The disk text the user's unsaved edits started from; set when the editor writes,
    // so a later rewrite can be checked against what the user actually added.
    editBase: null,
    lastWrite: null,
  };
}

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or a disabled store: the editor keeps working, it just forgets on reload.
  }
}

const EMPTY_COMMIT = { committing: false, error: null, last: null, message: "" };

export function createEditorStore({
  api,
  storage = null,
  autosave = true,
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  now = () => Date.now(),
  // Told the folder after a switch, a new worktree or a commit, for views that show its git state.
  onGitChange = null,
} = {}) {
  const persisted = readJson(storage, SESSION_KEY, {});
  const store = createStore(() => ({
    root: persisted.root || null,
    roots: Array.isArray(persisted.roots) ? persisted.roots : [],
    rootError: null,
    followedThreadId: persisted.followedThreadId || null,
    returnThreadId: null,
    dirs: {},
    expanded: { "": true },
    changedOnly: false,
    // `root` is the folder the list was read for: a commit goes there, or nowhere.
    changes: { root: null, entries: [], sessions: [], loading: false, complete: true, isRepo: true },
    // The files ticked for the next commit, for the folder the list belongs to.
    selection: { root: null, ticked: [] },
    // Left panel: the file tree, the changed files, or the branches for History.
    panelView: "files",
    // The History tab: whether it is in the tab strip, and whether it is the one shown.
    historyOpen: false,
    showingHistory: false,
    // "diff" or "edit" per document; edit when absent.
    viewModes: {},
    // The commit box of the folder on screen: its draft message and how the last try went.
    commit: EMPTY_COMMIT,
    // The folder's branches and worktrees. `failed` is the branch a refused switch was for.
    branches: { loading: false, error: null, data: null, acting: false, failed: null },
    // What the last switch or new worktree did, said once under the location.
    notice: null,
    tabsByRoot: persisted.tabsByRoot && typeof persisted.tabsByRoot === "object" ? persisted.tabsByRoot : {},
    docs: {},
    autosave,
  }));
  const saveTimers = new Map();
  const draftTimers = new Map();
  let treeRefreshTimer = null;
  const composing = new Set();
  // The save under way for each document, so anything that needs it landed can wait on it.
  const inflight = new Map();
  // Ticks for every folder visited, so going away and back keeps what the user unticked.
  const selections = new Map();
  // Where the cursor was in each document, so another view of it opens at the same place.
  const cursors = new Map();
  // Each folder's commit box, so a message or a hook's refusal stays with its folder.
  const commits = new Map();

  const get = () => store.getState();
  const set = (patch) => store.setState(patch);
  const setDoc = (key, patch) => {
    const docs = get().docs;
    if (!docs[key]) {
      return;
    }
    set({ docs: { ...docs, [key]: { ...docs[key], ...(typeof patch === "function" ? patch(docs[key]) : patch) } } });
  };

  function persistSession() {
    const { root, roots, followedThreadId, tabsByRoot } = get();
    writeJson(storage, SESSION_KEY, { root, roots, followedThreadId, tabsByRoot });
  }

  function persistDraft(key, doc) {
    timers.clearTimeout(draftTimers.get(key));
    draftTimers.delete(key);
    const drafts = readJson(storage, DRAFTS_KEY, {});
    if (doc && doc.dirty) {
      drafts[key] = { text: doc.text, revision: doc.revision, at: now() };
    } else {
      delete drafts[key];
    }
    writeJson(storage, DRAFTS_KEY, drafts);
  }

  function tabsOf(root = get().root) {
    const entry = get().tabsByRoot[root];
    const paths = Array.isArray(entry?.paths) ? entry.paths : [];
    const preview = entry?.preview && paths.includes(entry.preview) ? entry.preview : null;
    const pinned = Array.isArray(entry?.pinned) ? entry.pinned.filter((path) => paths.includes(path)) : [];
    // Tabs showing a file the working tree deleted: there is nothing on disk to load for them.
    const deleted = Array.isArray(entry?.deleted) ? entry.deleted.filter((path) => paths.includes(path)) : [];
    return { paths, active: entry?.active || null, preview, pinned, deleted };
  }

  // `preview` is the one tab a click in Changes reuses; it is kept unless told otherwise.
  function setTabs(
    paths,
    active,
    root = get().root,
    preview = tabsOf(root).preview,
    pinned = tabsOf(root).pinned,
    deleted = tabsOf(root).deleted
  ) {
    const kept = preview && paths.includes(preview) ? preview : null;
    const stays = pinned.filter((path) => paths.includes(path));
    const gone = deleted.filter((path) => paths.includes(path));
    set({ tabsByRoot: { ...get().tabsByRoot, [root]: { paths, active, preview: kept, pinned: stays, deleted: gone } } });
    persistSession();
  }

  function deletedDoc(root, path) {
    const key = docKey(root, path);
    set({ docs: { ...get().docs, [key]: { ...newDoc(path), loading: false, deleted: true, readonly: true } } });
    set({ viewModes: { ...get().viewModes, [key]: "diff" } });
    return key;
  }

  /** A deletion view whose file is back (a switch, an agent's write) becomes the file again. */
  function restoreDeleted(root, path) {
    const key = docKey(root, path);
    const docs = { ...get().docs };
    delete docs[key];
    set({ docs });
    const { paths, active, preview, pinned, deleted } = tabsOf(root);
    setTabs(paths, active, root, preview, pinned, deleted.filter((entry) => entry !== path));
    return ensureDoc(root, path);
  }

  /** Pinned tabs sit first and outlast "close others / to the right / all". */
  function setTabPinned(path, on, root = get().root) {
    const { paths, active, preview, pinned } = tabsOf(root);
    if (!paths.includes(path)) {
      return;
    }
    const rest = pinned.filter((entry) => entry !== path);
    const nextPinned = on ? [...rest, path] : rest;
    const others = paths.filter((entry) => !nextPinned.includes(entry));
    setTabs([...nextPinned, ...others], active, root, preview === path ? null : preview, nextPinned);
  }

  function setCommit(root, patch) {
    const next = { ...(commits.get(root) || EMPTY_COMMIT), ...patch };
    commits.set(root, next);
    if (get().root === root) {
      set({ commit: next });
    }
  }

  function setCommitMessage(message) {
    const { root } = get();
    if (root) {
      setCommit(root, { message: String(message ?? "") });
    }
  }

  /** Open the folders down to `path` in the file tree, so the file is in sight there. */
  function revealPath(path, root = get().root) {
    if (!path || root !== get().root) {
      return;
    }
    const parts = path.split("/");
    const expanded = { ...get().expanded };
    for (let index = 1; index < parts.length; index += 1) {
      const dir = parts.slice(0, index).join("/");
      expanded[dir] = true;
      if (!get().dirs[dir]) {
        void loadDir(dir);
      }
    }
    set({ expanded });
  }

  function clearNotice() {
    set({ notice: null });
  }

  async function loadDir(dir) {
    const { root } = get();
    if (!root) {
      return;
    }
    set({ dirs: { ...get().dirs, [dir]: { ...(get().dirs[dir] || {}), loading: true, error: null } } });
    try {
      const listing = await api.listDir(root, dir);
      if (get().root !== root) {
        return;
      }
      set({
        rootError: null,
        dirs: {
          ...get().dirs,
          [dir]: { entries: listing.entries, truncated: listing.truncated, loading: false, error: null },
        },
      });
    } catch (error) {
      if (get().root !== root) {
        return;
      }
      if (dir === "") {
        set({ rootError: error.message });
      }
      set({ dirs: { ...get().dirs, [dir]: { entries: [], loading: false, error: error.message } } });
    }
  }

  async function loadChanges() {
    const { root } = get();
    if (!root) {
      return;
    }
    set({ changes: { ...get().changes, loading: true } });
    try {
      const view = await api.changes(root);
      if (get().root === root) {
        set({
          changes: {
            root,
            entries: view.entries,
            sessions: view.sessions || [],
            loading: false,
            complete: view.complete,
            isRepo: view.is_repo,
          },
          selection: rememberSelection(nextSelection(selections.get(root) || null, root, view.entries.map((entry) => entry.path))),
        });
      }
    } catch {
      if (get().root === root) {
        set({ changes: { root, entries: [], sessions: [], loading: false, complete: false, isRepo: true } });
      }
    }
  }

  function refreshTree() {
    const dirs = Object.keys(get().dirs);
    for (const dir of dirs.length ? dirs : [""]) {
      void loadDir(dir);
    }
    void loadChanges();
  }

  // A save or a reload changes git status; one refresh shortly after covers a burst.
  function refreshTreeSoon() {
    if (treeRefreshTimer !== null) {
      return;
    }
    treeRefreshTimer = timers.setTimeout(() => {
      treeRefreshTimer = null;
      refreshTree();
    }, 600);
  }

  async function setRoot(root, { roots } = {}) {
    if (!root) {
      return;
    }
    flushSaves();
    const changed = root !== get().root;
    set({
      root,
      roots: roots || get().roots,
      rootError: null,
      ...(changed
        ? {
            dirs: {},
            expanded: { "": true },
            branches: { loading: false, error: null, data: null, acting: false, failed: null },
            changes: { root: null, entries: [], sessions: [], loading: true, complete: true, isRepo: true },
            commit: commits.get(root) || EMPTY_COMMIT,
            notice: null,
          }
        : {}),
    });
    persistSession();
    if (changed || !get().branches.data) {
      // The location names the branch as soon as the folder shows, not once the menu opens.
      void loadBranches({ quiet: true });
    }
    const firstLook = changed || !get().dirs[""];
    if (firstLook) {
      await loadDir("");
    }
    void loadChanges();
    const { paths, active, deleted } = tabsOf(root);
    for (const path of paths) {
      if (get().docs[docKey(root, path)]) {
        continue;
      }
      if (deleted.includes(path)) {
        deletedDoc(root, path);
      } else {
        ensureDoc(root, path);
      }
    }
    if (active && !paths.includes(active)) {
      setTabs(paths, paths[0] || null, root);
    } else if (active && firstLook) {
      revealPath(active, root);
    }
  }

  /**
   * Arrive at the editor. The folder follows the session the user came from, unless
   * they already picked another folder since last looking at that session.
   */
  async function enter({ threadId = null, fallbackRoot = null } = {}) {
    if (threadId) {
      set({ returnThreadId: threadId });
    }
    if (threadId && threadId !== get().followedThreadId) {
      try {
        const resolved = await api.threadWorkspace(threadId);
        const root = resolved?.cwd;
        if (root) {
          set({ followedThreadId: threadId });
          await setRoot(root, { roots: resolved.roots || [] });
          return;
        }
      } catch {
        // A session whose folder cannot be resolved leaves the current folder on screen.
      }
    }
    if (get().root) {
      await setRoot(get().root);
    } else if (fallbackRoot) {
      await setRoot(fallbackRoot);
    }
  }

  function toggleDir(dir) {
    const expanded = { ...get().expanded, [dir]: !get().expanded[dir] };
    set({ expanded });
    if (expanded[dir] && !get().dirs[dir]) {
      void loadDir(dir);
    }
  }

  function setChangedOnly(on) {
    set({ changedOnly: Boolean(on) });
    if (on) {
      void loadChanges();
    }
  }

  function ensureDoc(root, path) {
    const key = docKey(root, path);
    if (get().docs[key]) {
      return key;
    }
    set({ docs: { ...get().docs, [key]: newDoc(path) } });
    void loadDoc(root, path);
    return key;
  }

  async function loadDoc(root, path) {
    const key = docKey(root, path);
    try {
      const file = await api.readFile(root, path);
      const content = file.content ?? "";
      const draft = readJson(storage, DRAFTS_KEY, {})[key];
      const patch = {
        loading: false,
        error: null,
        revision: file.revision,
        savedText: content,
        text: content,
        dirty: false,
        binary: file.binary === true,
        tooLarge: file.too_large === true,
        readonly: file.readonly === true,
        missing: false,
      };
      if (draft && typeof draft.text === "string" && draft.text !== content) {
        if (draft.revision === file.revision) {
          // A draft from before a reload, on top of the same file: carry on with it.
          patch.text = draft.text;
          patch.dirty = true;
        } else {
          // The file moved on while the draft waited: the user decides, as in any conflict.
          // The draft keeps the revision it was written against, so until that choice is
          // made a reload can never mistake it for an edit of the newer file.
          patch.text = draft.text;
          patch.dirty = true;
          patch.revision = draft.revision;
          patch.conflict = {
            diskText: content,
            diskRevision: file.revision,
            ...(file.binary === true ? { diskBinary: true } : {}),
            ...(file.too_large === true ? { diskTooLarge: true } : {}),
            ...(file.readonly === true ? { diskReadonly: true } : {}),
          };
        }
      }
      setDoc(key, (doc) => ({ ...patch, externalVersion: doc.externalVersion + 1 }));
      if (patch.dirty && !patch.conflict) {
        scheduleSave(key);
      }
    } catch (error) {
      setDoc(key, { loading: false, error: error.message });
    }
  }

  /**
   * Open `path` in a tab beside the current one; an open file just gets focus. A preview
   * open (a click in Changes) takes over the previous preview tab instead of adding one.
   */
  function openFile(path, { line = null, root = get().root, preview = false } = {}) {
    if (!root || !path) {
      return null;
    }
    const { paths, active, preview: previewPath, pinned } = tabsOf(root);
    let next = paths;
    let nextPreview = previewPath;
    if (!paths.includes(path)) {
      if (preview && previewPath) {
        next = paths.map((entry) => (entry === previewPath ? path : entry));
        dropIfClean(root, previewPath);
      } else {
        // Beside the current tab, but never inside the pinned ones.
        const at = Math.max(active ? paths.indexOf(active) + 1 : paths.length, pinned.length);
        next = [...paths.slice(0, at), path, ...paths.slice(at)];
      }
      nextPreview = preview ? path : previewPath;
    } else if (!preview && previewPath === path) {
      nextPreview = null;
    }
    setTabs(next, path, root, nextPreview);
    leaveHistory(root);
    const key = get().docs[docKey(root, path)]?.deleted ? restoreDeleted(root, path) : ensureDoc(root, path);
    if (line) {
      setDoc(key, { revealLine: { line, at: now() } });
    }
    return key;
  }

  /**
   * A file the working tree deleted: nothing on disk to load or save, so it opens read-only
   * in the preview tab, compared with the last commit to show what went.
   */
  function openDeleted(path, root = get().root) {
    if (!root || !path) {
      return null;
    }
    const key = docKey(root, path);
    const existing = get().docs[key];
    // Unsaved text for a file deleted on disk stays in its own tab, with its own notice.
    if (existing?.dirty || existing?.conflict) {
      focusTab(path, root);
      return key;
    }
    deletedDoc(root, path);
    const { paths, active, preview: previewPath, pinned, deleted } = tabsOf(root);
    const gone = deleted.includes(path) ? deleted : [...deleted, path];
    if (paths.includes(path)) {
      // An open tab, pinned or kept, stays what it was; it only shows the deletion now.
      setTabs(paths, path, root, previewPath, pinned, gone);
    } else if (previewPath && !pinned.includes(previewPath)) {
      dropIfClean(root, previewPath);
      setTabs(paths.map((entry) => (entry === previewPath ? path : entry)), path, root, path, pinned, gone);
    } else {
      const at = Math.max(active ? paths.indexOf(active) + 1 : paths.length, pinned.length);
      setTabs([...paths.slice(0, at), path, ...paths.slice(at)], path, root, path, pinned, gone);
    }
    leaveHistory(root);
    return key;
  }

  function dropIfClean(root, path) {
    const key = docKey(root, path);
    const doc = get().docs[key];
    if (doc && !doc.dirty && !doc.conflict) {
      const docs = { ...get().docs };
      delete docs[key];
      cursors.delete(key);
      set({ docs });
    }
  }

  /** Keep a preview tab: it stops being the one the next click in Changes replaces. */
  function pinTab(path, root = get().root) {
    const { paths, active, preview } = tabsOf(root);
    if (preview === path) {
      setTabs(paths, active, root, null);
    }
  }

  function setPanelView(view) {
    const next = view === "changes" || view === "history" ? view : "files";
    set({ panelView: next });
    if (next === "changes") {
      void loadChanges();
    }
    if (next === "history") {
      showHistory();
    }
  }

  function showHistory() {
    flushSaves();
    set({ historyOpen: true, showingHistory: true });
  }

  function closeHistory() {
    set({ historyOpen: false, showingHistory: false });
  }

  // Bringing a file forward in the Editor's own folder takes the place of the History tab.
  function leaveHistory(root) {
    if (root === get().root && get().showingHistory) {
      set({ showingHistory: false });
    }
  }

  function setViewMode(key, mode) {
    set({ viewModes: { ...get().viewModes, [key]: mode === "diff" ? "diff" : "edit" } });
  }

  /**
   * Commit exactly the ticked files, as the editor shows them: their edits are saved first
   * even with autosave off. Git and the repository's hooks have the last word.
   */
  async function commit({ paths, message }) {
    const { root, changes } = get();
    if (!root || !paths?.length || !message?.trim() || get().commit.committing) {
      return null;
    }
    // The ticked paths came from the list on screen; it must be this folder's.
    if (changes.root !== root) {
      return null;
    }
    setCommit(root, { committing: true, error: null, unsaved: null });
    const files = new Set(paths.map((path) => `${root}/${path}`));
    const unsaved = await settleSaves((key) => files.has(`${keyRoot(key)}/${keyPath(key)}`), { force: true });
    if (unsaved.length) {
      setCommit(root, {
        committing: false,
        error: `${unsaved.join(", ")} could not be saved, so nothing was committed.`,
        unsaved,
      });
      return null;
    }
    try {
      const receipt = await api.commit({ root, paths, message });
      setCommit(root, { committing: false, error: null, last: receipt, message: "" });
      forgetBases(root);
      if (get().root === root) {
        refreshTree();
      }
      onGitChange?.(root);
      return receipt;
    } catch (error) {
      setCommit(root, { committing: false, error: error.message });
      return null;
    }
  }

  /** The last commit moved: diffs and change marks read it again. */
  function forgetBases(root) {
    const docs = { ...get().docs };
    let touched = false;
    for (const [key, doc] of Object.entries(docs)) {
      if (keyRoot(key) === root && doc.base) {
        docs[key] = { ...doc, base: null };
        touched = true;
      }
    }
    if (touched) {
      set({ docs });
    }
  }

  function rememberSelection(selection) {
    selections.set(selection.root, selection);
    return selection;
  }

  function setTicked(paths, on) {
    const { selection, changes } = get();
    if (selection.root !== changes.root) {
      return;
    }
    const ticked = new Set(selection.ticked);
    for (const path of paths) {
      if (on) {
        ticked.add(path);
      } else {
        ticked.delete(path);
      }
    }
    const order = changes.entries.map((entry) => entry.path);
    set({ selection: rememberSelection({ root: selection.root, ticked: order.filter((path) => ticked.has(path)) }) });
  }

  function focusTab(path, root = get().root) {
    const { paths, deleted } = tabsOf(root);
    if (paths.includes(path)) {
      flushSaves();
      setTabs(paths, path, root);
      leaveHistory(root);
      // After a reload the session panel shows tabs of a folder the Editor never opened.
      if (!get().docs[docKey(root, path)]) {
        if (deleted.includes(path)) {
          deletedDoc(root, path);
        } else {
          ensureDoc(root, path);
        }
      }
    }
  }

  function moveTab(path, toIndex, root = get().root) {
    const { paths, active } = tabsOf(root);
    const from = paths.indexOf(path);
    if (from < 0) {
      return;
    }
    const next = paths.filter((entry) => entry !== path);
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, path);
    setTabs(next, active, root);
  }

  /**
   * Close tabs. With autosave a close is a save first; a document that cannot be saved
   * (conflict, missing, failure) stays open so its text is not lost. Without autosave,
   * unsaved documents are returned for the caller to confirm, unless `discard`.
   */
  async function closeTabs(paths, { discard = false, root = get().root } = {}) {
    const docs = get().docs;
    const unsaved = paths.filter((path) => docs[docKey(root, path)]?.dirty);
    if (unsaved.length && !discard && !get().autosave) {
      return { needsConfirm: unsaved };
    }
    if (get().autosave && !discard) {
      await Promise.all(unsaved.map((path) => saveKey(docKey(root, path))));
    }
    const after = get().docs;
    const keep = discard
      ? []
      : paths.filter((path) => {
          const doc = after[docKey(root, path)];
          return doc && (doc.dirty || doc.conflict);
        });
    const closing = paths.filter((path) => !keep.includes(path));
    const { paths: open, active } = tabsOf(root);
    const remaining = open.filter((path) => !closing.includes(path));
    let nextActive = active;
    if (closing.includes(active)) {
      const index = open.indexOf(active);
      nextActive = remaining[Math.min(index, remaining.length - 1)] || null;
    }
    setTabs(remaining, nextActive, root);
    const docsNow = { ...get().docs };
    for (const path of closing) {
      const key = docKey(root, path);
      timers.clearTimeout(saveTimers.get(key));
      saveTimers.delete(key);
      delete docsNow[key];
      cursors.delete(key);
      persistDraft(key, null);
    }
    set({ docs: docsNow });
    return { closed: closing, kept: keep };
  }

  /** The editor view reports every change here. */
  function edit(path, text) {
    editKey(docKey(get().root, path), text);
  }

  function editKey(key, text) {
    const doc = get().docs[key];
    if (!doc || doc.loading || doc.binary || doc.tooLarge || doc.readonly || doc.text === text) {
      return;
    }
    // Typing in a preview tab keeps it.
    pinTab(keyPath(key), keyRoot(key));
    const dirty = text !== doc.savedText;
    setDoc(key, {
      text,
      dirty,
      saveError: null,
      editBase: doc.editBase ?? doc.savedText,
    });
    persistDraftSoon(key);
    if (dirty) {
      scheduleSave(key);
    }
  }

  // Typing rewrites the draft store at most a few times a second, not on every key.
  function persistDraftSoon(key) {
    if (draftTimers.has(key)) {
      return;
    }
    draftTimers.set(
      key,
      timers.setTimeout(() => {
        draftTimers.delete(key);
        persistDraft(key, get().docs[key]);
      }, 400)
    );
  }

  /** While an input method is composing, a save would write half a word. */
  function setComposing(path, on) {
    setComposingKey(docKey(get().root, path), on);
  }

  function setComposingKey(key, on) {
    if (on) {
      composing.add(key);
      return;
    }
    composing.delete(key);
    if (get().docs[key]?.dirty) {
      scheduleSave(key);
    }
  }

  function scheduleSave(key) {
    if (!get().autosave) {
      return;
    }
    timers.clearTimeout(saveTimers.get(key));
    saveTimers.set(
      key,
      timers.setTimeout(() => {
        saveTimers.delete(key);
        void saveKey(key);
      }, AUTOSAVE_DELAY_MS)
    );
  }

  async function saveKey(key) {
    const running = inflight.get(key);
    if (running) {
      await running;
    }
    const doc = get().docs[key];
    if (!doc || !doc.dirty || doc.saving || doc.conflict || doc.missing || doc.binary || doc.tooLarge || doc.readonly) {
      return doc;
    }
    if (composing.has(key)) {
      return doc;
    }
    const write = writeDoc(key, doc);
    inflight.set(key, write);
    try {
      await write;
    } finally {
      if (inflight.get(key) === write) {
        inflight.delete(key);
      }
    }
    return get().docs[key];
  }

  async function writeDoc(key, doc) {
    const root = keyRoot(key);
    const sent = doc.text;
    setDoc(key, { saving: true });
    try {
      const outcome = await api.writeFile({
        root,
        path: doc.path,
        content: sent,
        expectedRevision: doc.revision,
      });
      if (outcome.status === "saved") {
        setDoc(key, (current) => ({
          saving: false,
          saveError: null,
          lastSavedAt: now(),
          revision: outcome.revision,
          savedText: sent,
          dirty: current.text !== sent,
          // The base stays at the last text someone else wrote, so every line the user
          // added since then is checked, not only the last save's.
          lastWrite: {
            base: current.lastWrite?.base ?? current.editBase ?? current.savedText,
            mine: sent,
          },
          editBase: current.text !== sent ? sent : null,
        }));
        persistDraft(key, get().docs[key]);
        refreshTreeSoon();
        if (get().docs[key]?.dirty) {
          scheduleSave(key);
        }
      } else if (outcome.status === "conflict") {
        setDoc(key, { saving: false });
        await loadConflict(key);
      } else {
        setDoc(key, { saving: false, missing: true });
      }
    } catch (error) {
      setDoc(key, { saving: false, saveError: error.message });
    }
  }

  async function loadConflict(key) {
    const doc = get().docs[key];
    const root = keyRoot(key);
    try {
      const file = await api.readFile(root, doc.path);
      // A disk version the editor cannot hold is never offered as empty text to keep.
      const readable = typeof file.content === "string" && file.binary !== true && file.too_large !== true;
      setDoc(key, {
        conflict: {
          diskText: readable ? file.content : "",
          diskRevision: file.revision,
          ...(!readable && file.too_large !== true ? { diskBinary: true } : {}),
          ...(file.too_large === true ? { diskTooLarge: true } : {}),
          ...(file.readonly === true ? { diskReadonly: true } : {}),
        },
      });
    } catch (error) {
      setDoc(key, { saveError: error.message });
    }
  }

  function save(path, root = get().root) {
    return saveKey(docKey(root, path));
  }

  /**
   * Save everything with unsaved edits now: tab switch, leaving the screen, losing focus.
   * Resolves once those saves have landed, for callers that must act after them.
   */
  function flushSaves() {
    if (!get().autosave) {
      return Promise.resolve();
    }
    const saving = [];
    for (const [key, doc] of Object.entries(get().docs)) {
      if (doc.dirty) {
        timers.clearTimeout(saveTimers.get(key));
        saveTimers.delete(key);
        saving.push(saveKey(key));
      }
    }
    return Promise.all(saving);
  }

  /**
   * Wait until the edits to the files `match` picks are on disk: running saves land, pending
   * ones are sent (with autosave, or `force` for the files a commit takes). Passes repeat,
   * so a file edited while waiting counts too. Returns the paths still not on disk, for the
   * caller to refuse its action over.
   */
  async function settleSaves(match, { force = false } = {}) {
    for (let pass = 0; pass < 5; pass += 1) {
      const waits = [];
      for (const [key, doc] of Object.entries(get().docs)) {
        if (!match(key)) {
          continue;
        }
        if (inflight.has(key)) {
          waits.push(inflight.get(key));
        } else if (doc.dirty && !doc.conflict && !doc.missing && (get().autosave || force)) {
          timers.clearTimeout(saveTimers.get(key));
          saveTimers.delete(key);
          waits.push(saveKey(key));
        }
      }
      if (!waits.length) {
        break;
      }
      await Promise.all(waits);
    }
    return Object.entries(get().docs)
      .filter(([key, doc]) => match(key) && (doc.dirty || doc.saving || doc.conflict || doc.saveError))
      .map(([key]) => keyPath(key));
  }

  /**
   * Which documents a branch switch in `root` rewrites: every file in its worktree, whichever
   * folder it was opened from, except inside another worktree nested in it.
   */
  function inSwitchedTree(root) {
    const trees = (get().branches.data?.worktrees || []).map((tree) => tree.path);
    const under = (path, dir) => path === dir || path.startsWith(`${dir}/`);
    const top = trees.filter((tree) => under(root, tree)).sort((a, b) => b.length - a.length)[0] || root;
    const nested = trees.filter((tree) => tree !== top && under(tree, top));
    return (key) => {
      const file = `${keyRoot(key)}/${keyPath(key)}`;
      return under(file, top) && !nested.some((tree) => under(file, tree));
    };
  }

  function unsavedReason(paths) {
    return `${paths.join(", ")} ${paths.length === 1 ? "has" : "have"} edits that are not saved yet. Save or undo them first.`;
  }

  /** Re-check the open files of the folder on screen against the disk. */
  async function checkDisk(root = get().root) {
    if (!root) {
      return;
    }
    const open = Object.entries(get().docs).filter(
      ([key, doc]) => key.startsWith(`${root}\n`) && !doc.loading && !doc.tooLarge && !doc.saving
    );
    if (!open.length) {
      return;
    }
    let stats;
    try {
      stats = await api.statFiles(root, open.map(([, doc]) => doc.path));
    } catch {
      return;
    }
    for (const stat of stats) {
      const key = docKey(root, stat.path);
      const doc = get().docs[key];
      if (!doc || doc.saving) {
        continue;
      }
      if (doc.deleted) {
        if (!stat.missing) {
          restoreDeleted(root, stat.path);
        }
        continue;
      }
      if (stat.missing) {
        if (!doc.missing) {
          setDoc(key, { missing: true });
        }
        continue;
      }
      if (doc.missing) {
        setDoc(key, { missing: false });
      }
      if (!stat.revision || stat.revision === doc.revision) {
        continue;
      }
      if (doc.conflict) {
        if (stat.revision !== doc.conflict.diskRevision) {
          await loadConflict(key);
        }
        continue;
      }
      if (doc.dirty) {
        await loadConflict(key);
        continue;
      }
      await reloadClean(key);
    }
  }

  /** The disk changed under a document with no unsaved edits: take the new text. */
  async function reloadClean(key) {
    const doc = get().docs[key];
    const root = keyRoot(key);
    let file;
    try {
      file = await api.readFile(root, doc.path);
    } catch {
      return;
    }
    const current = get().docs[key];
    if (!current || current.dirty || current.saving) {
      return;
    }
    // Text the editor can hold, or nothing: a file that became binary or too large is shown
    // as such and can no longer be edited, never as an empty document over it.
    const readable = typeof file.content === "string" && file.binary !== true && file.too_large !== true;
    const theirs = readable ? file.content : "";
    const lastWrite = current.lastWrite;
    const overwritten =
      readable && lastWrite && !editsSurvive(lastWrite.base, lastWrite.mine, theirs)
        ? { mine: lastWrite.mine, theirs, at: now() }
        : null;
    setDoc(key, (latest) => ({
      binary: !readable && file.too_large !== true,
      tooLarge: file.too_large === true,
      readonly: file.readonly === true,
      revision: file.revision,
      savedText: theirs,
      text: theirs,
      dirty: false,
      lastWrite: null,
      editBase: null,
      overwritten: overwritten || latest.overwritten,
      externalVersion: latest.externalVersion + 1,
      reloadedAt: now(),
    }));
    refreshTreeSoon();
  }

  /** Answer a refused save: keep the disk version, or write the user's text over it. */
  function resolveConflict(path, choice, mergedText = null) {
    return resolveConflictKey(docKey(get().root, path), choice, mergedText);
  }

  async function resolveConflictKey(key, choice, mergedText = null) {
    const doc = get().docs[key];
    if (!doc?.conflict) {
      return;
    }
    const { diskText, diskRevision } = doc.conflict;
    if (choice === "theirs") {
      setDoc(key, (latest) => ({
        conflict: null,
        revision: diskRevision,
        savedText: diskText,
        text: diskText,
        dirty: false,
        editBase: null,
        binary: latest.conflict?.diskBinary === true,
        tooLarge: latest.conflict?.diskTooLarge === true,
        readonly: latest.conflict?.diskReadonly === true,
        externalVersion: latest.externalVersion + 1,
      }));
      persistDraft(key, null);
      return;
    }
    const text = choice === "merged" && typeof mergedText === "string" ? mergedText : doc.text;
    setDoc(key, (latest) => ({
      conflict: null,
      revision: diskRevision,
      savedText: diskText,
      text,
      dirty: text !== diskText,
      editBase: diskText,
      externalVersion: text === latest.text ? latest.externalVersion : latest.externalVersion + 1,
    }));
    await saveKey(key);
  }

  /** Put back the lines a change on disk replaced, as a normal checked save. */
  function restoreOverwritten(path, text = null) {
    return restoreOverwrittenKey(docKey(get().root, path), text);
  }

  /** `text` is what the user settled on in the comparison; without it, their saved lines. */
  async function restoreOverwrittenKey(key, text = null) {
    const doc = get().docs[key];
    if (!doc?.overwritten) {
      return;
    }
    const mine = typeof text === "string" ? text : doc.overwritten.mine;
    setDoc(key, (latest) => ({
      overwritten: null,
      text: mine,
      dirty: mine !== latest.savedText,
      editBase: latest.savedText,
      externalVersion: latest.externalVersion + 1,
    }));
    if (get().autosave) {
      await saveKey(key);
    }
  }

  function dismissOverwritten(path) {
    dismissOverwrittenKey(docKey(get().root, path));
  }

  function dismissOverwrittenKey(key) {
    setDoc(key, { overwritten: null });
  }

  /** `quiet`: a read the user did not ask for keeps its failure to itself. */
  async function loadBranches({ quiet = false } = {}) {
    const { root } = get();
    if (!root) {
      return;
    }
    set({ branches: { ...get().branches, loading: true, ...(quiet ? {} : { error: null }) } });
    try {
      const data = await api.branches(root);
      if (get().root === root) {
        set({
          branches: { ...get().branches, loading: false, ...(quiet ? {} : { error: null }), data, acting: false },
          roots: data.worktrees || get().roots,
        });
        persistSession();
      }
    } catch (error) {
      if (get().root === root) {
        set({ branches: { ...get().branches, loading: false, ...(quiet ? {} : { error: error.message }) } });
      }
    }
  }

  /**
   * Switch the folder on screen to another branch. Unsaved edits are saved first; any
   * file the switch changes then reloads, or turns into a conflict if it had edits.
   */
  async function switchBranch({ branch, create = false, remote = false, root: askedFor = null }) {
    const { root } = get();
    if (!root || !branch || get().branches.acting || (askedFor && askedFor !== root)) {
      return false;
    }
    set({ branches: { ...get().branches, acting: true, error: null, failed: null, unsaved: null }, notice: null });
    // The switch must see the user's last edits on disk, not race them there.
    const switched = inSwitchedTree(root);
    const unsaved = await settleSaves(switched);
    if (get().root !== root) {
      return false;
    }
    if (unsaved.length) {
      set({ branches: { ...get().branches, acting: false, error: unsavedReason(unsaved), unsaved } });
      return false;
    }
    try {
      await api.switchBranch({ root, branch, create, remote });
      // The files now are the other branch's, not a rewrite of what the user saved: what
      // they saved before the switch is no longer the thing to protect.
      const docs = { ...get().docs };
      for (const [key, doc] of Object.entries(docs)) {
        if (switched(key)) {
          docs[key] = { ...doc, lastWrite: null, overwritten: null, base: null, lastSavedAt: null };
        }
      }
      set({ docs });
      onGitChange?.(root);
      if (get().root !== root) {
        return true;
      }
      set({
        branches: { ...get().branches, acting: false },
        notice: { kind: "switched", root, branch: remote ? branch.slice(branch.indexOf("/") + 1) : branch, at: now() },
      });
      refreshTree();
      await checkDisk(root);
      if (get().root === root) {
        await loadBranches();
      }
      return true;
    } catch (error) {
      if (get().root === root) {
        set({ branches: { ...get().branches, acting: false, error: error.message, failed: { branch, remote } } });
      }
      return false;
    }
  }

  /** Check a branch out in a new worktree and show that worktree. */
  async function addWorktree({ branch, create = false, remote = false, root: askedFor = null }) {
    const { root } = get();
    if (!root || !branch || get().branches.acting || (askedFor && askedFor !== root)) {
      return null;
    }
    set({ branches: { ...get().branches, acting: true, error: null, failed: null, unsaved: null }, notice: null });
    try {
      const { path } = await api.addWorktree({ root, branch, create, remote });
      onGitChange?.(root);
      // The user may have gone to another folder meanwhile; that choice stands.
      if (get().root !== root) {
        return path;
      }
      set({ branches: { ...get().branches, acting: false } });
      await setRoot(path);
      set({ notice: { kind: "worktree", root: path, path, from: root, branch, at: now() } });
      await loadBranches();
      return path;
    } catch (error) {
      if (get().root === root) {
        set({ branches: { ...get().branches, acting: false, error: error.message } });
      }
      return null;
    }
  }

  function rememberCursor(key, position) {
    if (key && position) {
      cursors.set(key, position);
    }
  }

  function cursorOf(key) {
    return cursors.get(key) || null;
  }

  /** The committed version of a document, for the "compared with last commit" view. */
  async function loadBase(key) {
    const doc = get().docs[key];
    if (!doc) {
      return;
    }
    setDoc(key, (latest) => ({ base: { ...(latest.base || {}), loading: true, error: null } }));
    try {
      const base = await api.baseFile(keyRoot(key), keyPath(key));
      setDoc(key, {
        base: {
          loading: false,
          error: null,
          tracked: base.tracked === true,
          content: base.content ?? null,
          binary: base.binary === true,
          tooLarge: base.too_large === true,
        },
      });
    } catch (error) {
      setDoc(key, { base: { loading: false, error: error.message } });
    }
  }

  /**
   * Show a document in the Editor screen: its folder becomes the editor's, and the
   * session it came from is where Back to session returns.
   */
  async function showInEditor({ root, path, threadId = null }) {
    if (threadId) {
      set({ followedThreadId: threadId, returnThreadId: threadId });
    }
    await setRoot(root);
    if (path) {
      openFile(path, { root });
      // The file arrives in sight in the tree too, whatever the panel showed before.
      set({ panelView: "files" });
      revealPath(path, root);
    }
  }

  function setAutosave(on) {
    set({ autosave: Boolean(on) });
    if (on) {
      for (const [key, doc] of Object.entries(get().docs)) {
        if (doc.dirty) {
          scheduleSave(key);
        }
      }
    } else {
      for (const handle of saveTimers.values()) {
        timers.clearTimeout(handle);
      }
      saveTimers.clear();
    }
  }

  return {
    ...store,
    baseName,
    tabsOf,
    enter,
    setRoot,
    loadDir,
    refreshTree,
    toggleDir,
    setChangedOnly,
    openFile,
    focusTab,
    moveTab,
    closeTabs,
    edit,
    setComposing,
    save,
    saveKey,
    editKey,
    setComposingKey,
    flushSaves,
    checkDisk,
    resolveConflict,
    resolveConflictKey,
    restoreOverwritten,
    restoreOverwrittenKey,
    dismissOverwritten,
    dismissOverwrittenKey,
    rememberCursor,
    cursorOf,
    loadBase,
    showInEditor,
    loadBranches,
    switchBranch,
    addWorktree,
    pinTab,
    setTabPinned,
    revealPath,
    openDeleted,
    setCommitMessage,
    clearNotice,
    setPanelView,
    setTicked,
    showHistory,
    closeHistory,
    setViewMode,
    commit,
    setAutosave,
  };
}
