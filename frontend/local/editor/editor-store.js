// What the Editor screen knows: which folder is on screen, its file tree, the open
// tabs, and every open document with its save state.
//
// Saving is the part with rules. Every write quotes the revision the editor last saw,
// and the relay refuses it if the file moved on (an agent wrote it), so neither side
// silently loses the other's work. Autosave only changes WHEN a save is attempted.

import { createStore } from "zustand/vanilla";

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

export function createEditorStore({
  api,
  storage = null,
  autosave = true,
  timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
  now = () => Date.now(),
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
    changes: { entries: [], sessions: [], loading: false, complete: true, isRepo: true },
    // Left panel: the file tree or the changed files.
    panelView: "files",
    // "diff" or "edit" per document; edit when absent.
    viewModes: {},
    commit: { committing: false, error: null, last: null },
    // The folder's branches and worktrees, read when the location menu opens.
    branches: { loading: false, error: null, data: null, acting: false },
    tabsByRoot: persisted.tabsByRoot && typeof persisted.tabsByRoot === "object" ? persisted.tabsByRoot : {},
    docs: {},
    autosave,
  }));
  const saveTimers = new Map();
  const draftTimers = new Map();
  let treeRefreshTimer = null;
  const composing = new Set();
  // Where the cursor was in each document, so another view of it opens at the same place.
  const cursors = new Map();

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
    return { paths, active: entry?.active || null, preview };
  }

  // `preview` is the one tab a click in Changes reuses; it is kept unless told otherwise.
  function setTabs(paths, active, root = get().root, preview = tabsOf(root).preview) {
    const kept = preview && paths.includes(preview) ? preview : null;
    set({ tabsByRoot: { ...get().tabsByRoot, [root]: { paths, active, preview: kept } } });
    persistSession();
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
            entries: view.entries,
            sessions: view.sessions || [],
            loading: false,
            complete: view.complete,
            isRepo: view.is_repo,
          },
        });
      }
    } catch {
      if (get().root === root) {
        set({ changes: { entries: [], sessions: [], loading: false, complete: false, isRepo: true } });
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
        ? { dirs: {}, expanded: { "": true }, branches: { loading: false, error: null, data: null, acting: false } }
        : {}),
    });
    persistSession();
    if (changed || !get().dirs[""]) {
      await loadDir("");
    }
    void loadChanges();
    const { paths, active } = tabsOf(root);
    for (const path of paths) {
      ensureDoc(root, path);
    }
    if (active && !paths.includes(active)) {
      setTabs(paths, paths[0] || null, root);
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
          patch.conflict = { diskText: content, diskRevision: file.revision };
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
    const { paths, active, preview: previewPath } = tabsOf(root);
    let next = paths;
    let nextPreview = previewPath;
    if (!paths.includes(path)) {
      if (preview && previewPath) {
        next = paths.map((entry) => (entry === previewPath ? path : entry));
        dropIfClean(root, previewPath);
      } else {
        const at = active ? paths.indexOf(active) + 1 : paths.length;
        next = [...paths.slice(0, at), path, ...paths.slice(at)];
      }
      nextPreview = preview ? path : previewPath;
    } else if (!preview && previewPath === path) {
      nextPreview = null;
    }
    setTabs(next, path, root, nextPreview);
    const key = ensureDoc(root, path);
    if (line) {
      setDoc(key, { revealLine: { line, at: now() } });
    }
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
    set({ panelView: view === "changes" ? "changes" : "files" });
    if (view === "changes") {
      void loadChanges();
    }
  }

  function setViewMode(key, mode) {
    set({ viewModes: { ...get().viewModes, [key]: mode === "diff" ? "diff" : "edit" } });
  }

  /** Commit exactly the ticked files. Git and the repository's hooks have the last word. */
  async function commit({ paths, message }) {
    const { root } = get();
    if (!root || !paths?.length || !message?.trim() || get().commit.committing) {
      return null;
    }
    set({ commit: { committing: true, error: null, last: get().commit.last } });
    await flushSaves();
    try {
      const receipt = await api.commit({ root, paths, message });
      set({ commit: { committing: false, error: null, last: receipt } });
      refreshTree();
      return receipt;
    } catch (error) {
      set({ commit: { committing: false, error: error.message, last: get().commit.last } });
      return null;
    }
  }

  function focusTab(path, root = get().root) {
    const { paths } = tabsOf(root);
    if (paths.includes(path)) {
      flushSaves();
      setTabs(paths, path, root);
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
    if (!doc || doc.loading || doc.binary || doc.tooLarge || doc.text === text) {
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
    const doc = get().docs[key];
    if (!doc || !doc.dirty || doc.saving || doc.conflict || doc.missing || doc.binary || doc.tooLarge) {
      return doc;
    }
    if (composing.has(key)) {
      return doc;
    }
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
    return get().docs[key];
  }

  async function loadConflict(key) {
    const doc = get().docs[key];
    const root = keyRoot(key);
    try {
      const file = await api.readFile(root, doc.path);
      setDoc(key, { conflict: { diskText: file.content ?? "", diskRevision: file.revision } });
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

  async function loadBranches() {
    const { root } = get();
    if (!root) {
      return;
    }
    set({ branches: { ...get().branches, loading: true, error: null } });
    try {
      const data = await api.branches(root);
      if (get().root === root) {
        set({ branches: { loading: false, error: null, data, acting: false }, roots: data.worktrees || get().roots });
        persistSession();
      }
    } catch (error) {
      if (get().root === root) {
        set({ branches: { ...get().branches, loading: false, error: error.message } });
      }
    }
  }

  /**
   * Switch the folder on screen to another branch. Unsaved edits are saved first; any
   * file the switch changes then reloads, or turns into a conflict if it had edits.
   */
  async function switchBranch({ branch, create = false, remote = false }) {
    const { root } = get();
    if (!root || !branch || get().branches.acting) {
      return false;
    }
    set({ branches: { ...get().branches, acting: true, error: null } });
    // The switch must see the user's last edits on disk, not race them there.
    await flushSaves();
    try {
      await api.switchBranch({ root, branch, create, remote });
      set({ branches: { ...get().branches, acting: false } });
      refreshTree();
      await checkDisk(root);
      await loadBranches();
      return true;
    } catch (error) {
      set({ branches: { ...get().branches, acting: false, error: error.message } });
      return false;
    }
  }

  /** Check a branch out in a new worktree and show that worktree. */
  async function addWorktree({ branch, create = false, remote = false }) {
    const { root } = get();
    if (!root || !branch || get().branches.acting) {
      return null;
    }
    set({ branches: { ...get().branches, acting: true, error: null } });
    try {
      const { path } = await api.addWorktree({ root, branch, create, remote });
      set({ branches: { ...get().branches, acting: false } });
      await setRoot(path);
      await loadBranches();
      return path;
    } catch (error) {
      set({ branches: { ...get().branches, acting: false, error: error.message } });
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
    setPanelView,
    setViewMode,
    commit,
    setAutosave,
  };
}
