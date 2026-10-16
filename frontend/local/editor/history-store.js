// The Editor's History: one folder's log, the commit picked in it, and the file picked in
// that commit. Every reply is checked against the request that is current when it lands,
// so a slow answer for an older folder, filter or commit never replaces a newer one.

import { createStore } from "zustand/vanilla";

export const HISTORY_PAGE = 200;

export const NO_FILTERS = Object.freeze({ branch: null, remote: false, author: "", path: "", query: "" });

/** Author and text filters drop commits without rewriting parents, so lanes would not join. */
export function graphApplies(filters) {
  return !filters.author.trim() && !filters.query.trim();
}

// `tips` names the commits the first page was walked from; later pages send it back.
const emptyLog = () => ({ loading: false, error: null, commits: [], more: false, complete: true, isRepo: true, tips: "" });
const emptyDetail = () => ({ id: null, loading: false, error: null, data: null });
const emptyFile = () => ({ id: null, path: null, loading: false, error: null, data: null });

export function createHistoryStore({ api }) {
  const store = createStore(() => ({
    root: null,
    filters: NO_FILTERS,
    log: emptyLog(),
    selected: null,
    detail: emptyDetail(),
    file: emptyFile(),
  }));
  const get = () => store.getState();
  const set = (patch) => store.setState(patch);
  let logRequest = 0;
  let detailRequest = 0;
  let fileRequest = 0;

  /** Show `root`'s history, read afresh: it is cheap, and a commit may have landed since. */
  function show(root) {
    if (!root) {
      return Promise.resolve();
    }
    moveTo(root);
    return load();
  }

  function moveTo(root, filters = NO_FILTERS) {
    if (root === get().root) {
      return;
    }
    logRequest += 1;
    detailRequest += 1;
    fileRequest += 1;
    set({ root, filters, log: emptyLog(), selected: null, detail: emptyDetail(), file: emptyFile() });
  }

  async function load({ append = false } = {}) {
    const { root, filters, log } = get();
    if (!root || (append && (log.loading || !log.more))) {
      return;
    }
    const request = ++logRequest;
    const skip = append ? log.commits.length : 0;
    set({ log: { ...log, loading: true, error: null } });
    try {
      const data = await api.history({
        root,
        branch: filters.branch || "",
        remote: filters.remote,
        author: filters.author.trim(),
        path: filters.path.trim(),
        query: filters.query.trim(),
        skip,
        limit: HISTORY_PAGE,
        tips: append ? log.tips : "",
      });
      if (request !== logRequest) {
        return;
      }
      if (data?.moved) {
        // A branch moved since the first page: the offset no longer lines up, so start over.
        set({ log: { ...get().log, loading: false } });
        await load();
        return;
      }
      const incoming = Array.isArray(data?.commits) ? data.commits : [];
      let commits = incoming;
      if (append) {
        // A commit landing between pages shifts the offset by one; drop the repeat.
        const seen = new Set(log.commits.map((commit) => commit.id));
        commits = [...log.commits, ...incoming.filter((commit) => !seen.has(commit.id))];
      }
      set({
        log: {
          loading: false,
          error: null,
          commits,
          more: Boolean(data?.more),
          complete: data?.complete !== false,
          isRepo: data?.is_repo !== false,
          tips: data?.tips || "",
        },
      });
      if (!append && get().selected && !commits.some((commit) => commit.id === get().selected)) {
        detailRequest += 1;
        fileRequest += 1;
        set({ selected: null, detail: emptyDetail(), file: emptyFile() });
      }
    } catch (error) {
      if (request === logRequest) {
        set({ log: { ...get().log, loading: false, error: error.message } });
      }
    }
  }

  /** Narrow the log. `root` is the folder the choice was made in, when it may not be shown yet. */
  function setFilters(patch, root = get().root) {
    if (root && root !== get().root) {
      moveTo(root, { ...NO_FILTERS, ...patch });
      return load();
    }
    set({ filters: { ...get().filters, ...patch } });
    return load();
  }

  async function select(id) {
    const { root } = get();
    if (!root || !id) {
      return;
    }
    const request = ++detailRequest;
    fileRequest += 1;
    set({ selected: id, detail: { id, loading: true, error: null, data: null }, file: emptyFile() });
    try {
      const data = await api.historyCommit(root, id);
      if (request === detailRequest) {
        set({ detail: { id, loading: false, error: null, data } });
      }
    } catch (error) {
      if (request === detailRequest) {
        set({ detail: { id, loading: false, error: error.message, data: null } });
      }
    }
  }

  async function openFile(file) {
    const { root, detail } = get();
    const id = detail.data?.id;
    if (!root || !id || !file?.path) {
      return;
    }
    const request = ++fileRequest;
    set({ file: { id, path: file.path, loading: true, error: null, data: null } });
    try {
      const data = await api.historyFile(root, id, file.path, file.old_path || "");
      if (request === fileRequest) {
        set({ file: { id, path: file.path, loading: false, error: null, data } });
      }
    } catch (error) {
      if (request === fileRequest) {
        set({ file: { id, path: file.path, loading: false, error: error.message, data: null } });
      }
    }
  }

  return Object.assign(store, { show, load, setFilters, select, openFile });
}
