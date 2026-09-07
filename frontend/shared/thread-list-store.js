import { createStore } from "zustand/vanilla";
import { EMPTY_THREAD_FILTER, createThreadFilter } from "./thread-filter.js";
import { EMPTY_THREAD_SELECTION, createThreadSelection } from "./thread-multi-select.js";

import {
  clearThreadListError,
  createThreadListUiState,
  failThreadListRefresh,
  finishThreadListRefresh,
  setThreadListDrawerOpen,
  setThreadListSelectedCwd,
  startThreadListRefresh,
  toggleThreadListCollapsedGroup,
  toggleThreadListExpandedGroup,
} from "./thread-list-state.js";

// The read fallback for a store that does not exist yet — the first renders of a surface
// with no relay. Frozen and shared: every write goes through a setter, so nothing mutates
// it, and a stable identity is what `useSyncExternalStore` requires.
const EMPTY_SEARCH_UI = Object.freeze({ open: false, draft: "", focusSignal: 0 });

export function createThreadListStore(initialThreadList = {}) {
  return createStore((set) => ({
    contextMenu: {
      clientX: 0,
      clientY: 0,
      threadId: null,
    },
    // The selected project, and the ONLY distinction the sidebar still draws. It used
    // to sit beside a `viewMode` that swapped the grouping axis; selecting a project
    // now PINS it to the top of a list that stays complete, so "which mode" had exactly
    // two states and one of them was "no project selected". Deleted rather than
    // defaulted, so nothing can reintroduce a second source of truth.
    //
    // Display-only — never sent to the backend — so it holds a real project id or null
    // (never the Unassigned sentinel, which is a grouping key rather than an id).
    activeProjectId:
      typeof initialThreadList.activeProjectId === "string"
        ? initialThreadList.activeProjectId
        : null,
    setActiveProject(projectId) {
      set({ activeProjectId: typeof projectId === "string" && projectId ? projectId : null });
    },
    // The bell. It narrows the list to what is actually going on; `retained` is the
    // monotonic retention map (thread id → the state it was last seen in) that stops a
    // row vanishing from under the pointer because the agent answered mid-reach. The
    // rules live in shared/thread-filter.js.
    //
    // It sits here rather than on either shell because it existed TWICE — on local's
    // plain mutable `state` object and again in remote's zustand store, the second
    // documenting itself as a port of the first. Both shells already own one of these
    // stores, so this is the one place that can hold it without a shell knowing.
    threadFilter: createThreadFilter(),
    // Turning the bell on, or changing what it covers, RESETS retention: carrying it
    // across a deliberate off/on would re-list rows that stopped being interesting long
    // ago.
    setThreadFilter(next) {
      set((state) => ({
        threadFilter: { ...state.threadFilter, ...next, retained: new Map() },
      }));
    },
    // Separate from `setThreadFilter` so accumulating cannot reset what it accumulates.
    //
    // Normalizes HERE rather than on read, because `readThreadFilter` is a
    // `useSyncExternalStore` snapshot on remote: a reader that rebuilt the object to fix
    // a bad `retained` would return a new identity every call and React would spin. Bad
    // input is therefore kept out of the state instead of patched on the way out.
    setThreadFilterRetained(retained) {
      set((state) => {
        const next = retained instanceof Map ? retained : new Map();
        // Idempotent on identity, because `nextRetainedStates` returns the SAME Map when
        // nothing changed and that identity is the caller's "did anything change?" test.
        // Both current callers already guard before calling — but leaving the obligation
        // out here means every future caller has to rediscover it, and missing it once
        // makes remote re-render forever: new object → zustand notifies →
        // `useThreadFilter` snapshot changes → effect runs → new object.
        if (next === state.threadFilter.retained) {
          return state;
        }
        return { threadFilter: { ...state.threadFilter, retained: next } };
      });
    },
    // The search FIELD's ui state — is it open, and what has been typed into it.
    //
    // Distinct from `threadSearch`, which is the EXECUTED query plus its results and stays
    // per-surface (local fetches over HTTP, remote over the broker). This is just the
    // control's own state, and it lived in two very different places: remote in a pair of
    // `useState` hooks, local in the DOM itself — `open` was read back off
    // `sidebarSearch.hidden` and the draft off `sidebarSearchInput.value`. Using the DOM as
    // the state is exactly why local could not conditionally render the field.
    // `focusSignal` is a monotonic counter, not a boolean: it is a REQUEST to take focus,
    // and requests can repeat. React can only autofocus on mount, but "focus the search
    // field" arrives just as often when the field is already mounted — ⌘F with the caret in
    // the composer. Local's old imperative `setSearchOpen` called `focus()` unconditionally
    // and covered both cases; a counter the component watches restores that with one
    // mechanism instead of two.
    searchUi: { open: false, draft: "", focusSignal: 0 },
    // Closing CLEARS. Both shells had written this rule out in prose, in slightly
    // different words, and each could have lost it independently: a hidden field still
    // narrowing the list is a sidebar that looks like it lost sessions, with the reason
    // off screen. Enforced here so neither shell has to remember it.
    //
    // Opening deliberately does not clear, so a caller may seed a term and reveal the
    // field in either order.
    setSearchOpen(open) {
      set((state) => ({
        searchUi: open
          ? // Bumped on EVERY open, including one that finds the field already open —
            // that is the ⌘F-while-open case, where nothing else changes and so nothing
            // else would tell the field to take focus.
            {
              ...state.searchUi,
              open: true,
              focusSignal: state.searchUi.focusSignal + 1,
            }
          : // Closing keeps the counter (monotonic) but clears the draft. It must not ask
            // for focus: a field that is going away should not pull the caret into itself.
            { open: false, draft: "", focusSignal: state.searchUi.focusSignal },
      }));
    },
    // Normalized to a string because this feeds a CONTROLLED `<input value>`: `null` or
    // `undefined` there makes React switch the input to uncontrolled mid-life and warn,
    // after which the field stops tracking the draft at all.
    setSearchDraft(draft) {
      set((state) => ({
        searchUi: { ...state.searchUi, draft: typeof draft === "string" ? draft : "" },
      }));
    },
    threadList: createThreadListUiState(initialThreadList),
    clearError() {
      set((state) => ({
        threadList: clearThreadListError(state.threadList),
      }));
    },
    failRefresh(message) {
      set((state) => ({
        threadList: failThreadListRefresh(state.threadList, message),
      }));
    },
    finishRefresh() {
      set((state) => ({
        threadList: finishThreadListRefresh(state.threadList),
      }));
    },
    setDrawerOpen(open) {
      set((state) => ({
        threadList: setThreadListDrawerOpen(state.threadList, open),
      }));
    },
    setSelectedCwd(cwd) {
      set((state) => ({
        threadList: setThreadListSelectedCwd(state.threadList, cwd),
      }));
    },
    startRefresh() {
      set((state) => ({
        threadList: startThreadListRefresh(state.threadList),
      }));
    },
    toggleCollapsedGroup(cwd) {
      set((state) => ({
        threadList: toggleThreadListCollapsedGroup(state.threadList, cwd),
      }));
    },
    toggleExpandedGroup(cwd) {
      set((state) => ({
        threadList: toggleThreadListExpandedGroup(state.threadList, cwd),
      }));
    },
    // Shift/Cmd multi-select over the session rows. Held here beside `contextMenu`
    // because the right-click menu reads it: a right-click inside a selection acts
    // on the whole batch. The rules are in shared/thread-multi-select.js.
    threadSelection: createThreadSelection(),
    setThreadSelection(selection) {
      set({
        threadSelection:
          selection && selection.ids instanceof Set ? selection : createThreadSelection(),
      });
    },
    // Idempotent on identity: Escape, plain clicks and every list refresh call this
    // unconditionally, and handing back a fresh object each time would re-render the
    // whole list on keystrokes that changed nothing.
    clearThreadSelection() {
      set((state) => {
        const current = state.threadSelection;
        if (!current.ids.size && !current.anchorId) {
          return state;
        }
        return { threadSelection: createThreadSelection() };
      });
    },
    closeContextMenu() {
      set({
        contextMenu: {
          clientX: 0,
          clientY: 0,
          threadId: null,
        },
      });
    },
    openContextMenu(threadId, clientX = 0, clientY = 0) {
      set({
        contextMenu: {
          clientX,
          clientY,
          threadId: threadId || null,
        },
      });
    },
  }));
}

export function readThreadListUi(store) {
  return store?.getState?.().threadList || createThreadListUiState();
}

export function readThreadListContextMenu(store) {
  return store?.getState?.().contextMenu || {
    clientX: 0,
    clientY: 0,
    threadId: null,
  };
}

/**
 * The bell's state, as a STABLE identity.
 *
 * Remote snapshots this through `useSyncExternalStore`, which requires the same object
 * back when nothing changed — so this returns what the store holds rather than building
 * a normalized copy. The setters guarantee it is well-formed; the frozen constant is only
 * for a store that does not exist yet (the first renders of a surface with no relay).
 */
export function readThreadFilter(store) {
  return store?.getState?.().threadFilter || EMPTY_THREAD_FILTER;
}

/**
 * The search field's ui state, as a STABLE identity.
 *
 * Same contract as `readThreadFilter`: remote snapshots this through
 * `useSyncExternalStore`, so it must return what the store holds rather than a fresh
 * object. The setters keep it well-formed.
 */
export function readSearchUi(store) {
  return store?.getState?.().searchUi || EMPTY_SEARCH_UI;
}

/**
 * The multi-selection, as a STABLE identity — same contract as `readThreadFilter`.
 */
export function readThreadSelection(store) {
  return store?.getState?.().threadSelection || EMPTY_THREAD_SELECTION;
}

export function readActiveProjectId(store) {
  const value = store?.getState?.().activeProjectId;
  return typeof value === "string" && value ? value : null;
}
