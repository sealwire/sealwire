// Transaction boundary around session-view-state.
//
// The store owns the canonical `location + tabSets` snapshot and synchronizes tab-set
// persistence. The controller captures external facts, commits one pure transition,
// then writes browser history and announces the committed result. Rendering and view
// transitions belong to the subscriber: animation must never decide whether semantic
// navigation commits.

import {
  createTabWorkspace,
  sameWorkspace,
} from "./tab-layout.js";
import {
  createSessionViewState,
  isFullAreaWorkspaceKey,
  normalizeSessionViewContext,
  reduceSessionView,
  sessionViewContextKey,
  sessionViewHistoryEntry,
} from "./session-view-state.js";

function sameLocation(left, right) {
  return (
    sessionViewContextKey(left?.context) === sessionViewContextKey(right?.context)
    && (left?.threadId || null) === (right?.threadId || null)
  );
}

function changedWorkspaceKeys(previous, next) {
  const keys = new Set([
    ...Object.keys(previous?.workspaces || {}),
    ...Object.keys(next?.workspaces || {}),
  ]);
  return [...keys].filter(
    (key) =>
      !sameWorkspace(
        previous?.workspaces?.[key],
        next?.workspaces?.[key]
      )
  );
}

function safeError(handler, error, details) {
  try {
    handler?.(error, details);
  } catch {
    // Error reporting cannot make a recoverable persistence/history failure fatal.
  }
}

function copyFacts(facts) {
  const copyIds = (values) =>
    values instanceof Set
      ? [...values]
      : Array.isArray(values)
        ? [...values]
        : [];
  return {
    projectIds: copyIds(facts?.projectIds),
    projectIdsComplete: facts?.projectIdsComplete !== false,
    unavailableThreadIds: copyIds(facts?.unavailableThreadIds),
  };
}

function materializeActionContext(action, state) {
  const contextualTypes = new Set([
    "OPEN_THREAD",
    "SHOW_OVERVIEW",
    "CLOSE_TAB",
    "PIN_TAB",
    "MOVE_TAB",
    "PROMOTE_TAB",
  ]);
  if (!contextualTypes.has(action?.type) || action.context) {
    return { ...action };
  }
  return {
    ...action,
    context: normalizeSessionViewContext(state.location.context),
  };
}

function normalizedWorkspaces(workspaces) {
  return Object.fromEntries(
    Object.entries(workspaces || {}).map(([key, workspace]) => [
      key,
      createTabWorkspace(workspace),
    ])
  );
}

function validHistoryWorkspaces(workspaces, action, facts) {
  if (
    action?.type !== "RESTORE_HISTORY"
    || facts?.projectIdsComplete === false
  ) {
    return workspaces;
  }
  // `projects-home` used to key a workspace of its own; it now normalizes to
  // `sessions`, so listing it here would add the same key twice. Any workspace still
  // stored under the old NO_PROJECT_KEY is dropped by this filter, which is the
  // intended outcome — that context has no way to be entered again.
  const validKeys = new Set([
    sessionViewContextKey({ kind: "sessions" }),
    ...(facts?.projectIds || []),
  ]);
  // The full-area screens' keys (Tasks, Usage) are not enumerable from any fact the
  // controller has — there is no `taskIds` the way there is a `projectIds`. They are
  // recognised by shape instead. Without this every stored such workspace would be DELETED from
  // IndexedDB on the next restore, silently: this filter's output is diffed against
  // what is on disk, and anything missing is a delete.
  return Object.fromEntries(
    Object.entries(workspaces).filter(
      ([key]) => validKeys.has(key) || isFullAreaWorkspaceKey(key)
    )
  );
}

function applyCommand(state, action, facts) {
  const reduced = reduceSessionView(state, action, facts);
  if (action?.type !== "RESTORE_HISTORY") {
    return reduced;
  }
  return createSessionViewState({
    location: reduced.location,
    // Rebuilt for the workspace filter alone. Everything the reducer decided has to be
    // carried over verbatim, or a history restore quietly resets it — and while the Task
    // screen is up the location cannot re-derive this, because the location IS `tasks`.
    returnContext: reduced.returnContext,
    workspaces: validHistoryWorkspaces(
      reduced.workspaces,
      action,
      facts
    ),
  });
}

function createChange(action, previous, next) {
  const workspaceKeys = changedWorkspaceKeys(previous, next);
  const locationChanged = !sameLocation(previous.location, next.location);
  return {
    action,
    previous,
    next,
    locationChanged,
    changedWorkspaceKeys: workspaceKeys,
    stateChanged: locationChanged || workspaceKeys.length > 0,
  };
}

/**
 * Canonical state store with injected atomic tab-set persistence.
 *
 * The adapter's `transact` callback receives the latest persisted workspace snapshot
 * and commits its returned write set atomically. Commands that could not be persisted
 * remain as a replayable local journal: a later successful transaction rebases those
 * commands onto the then-current shared snapshot instead of replacing them with stale
 * storage or overwriting another window's changes.
 */
export function createSessionViewStore({
  initialLocation = null,
  initialWorkspaces = {},
  persistence = null,
  onError = null,
} = {}) {
  let state = createSessionViewState({
    location: initialLocation || undefined,
    workspaces: initialWorkspaces,
  });
  if (persistence && typeof persistence.transact !== "function") {
    throw new TypeError(
      "session-view persistence must provide an atomic transact(callback) method"
    );
  }
  if (persistence && Object.keys(initialWorkspaces || {}).length) {
    throw new TypeError(
      "persisted session-view stores must hydrate workspaces inside the transaction"
    );
  }

  let pendingBaseLocation = null;
  // Captured with `pendingBaseLocation` and for the same reason: the rebase below
  // replays the journal from that base, so it has to start from the memory that was
  // current at that moment rather than whatever the location happens to imply now.
  let pendingBaseReturnContext = null;
  let pendingCommands = [];
  let dispatchQueue = Promise.resolve();

  function transitionInMemory(action, facts) {
    const previous = state;
    const materializedAction = materializeActionContext(action, previous);
    const capturedFacts = copyFacts(facts);
    const next = applyCommand(previous, materializedAction, capturedFacts);
    if (!pendingCommands.length) {
      pendingBaseLocation = previous.location;
      pendingBaseReturnContext = previous.returnContext;
    }
    pendingCommands.push({
      action: materializedAction,
      facts: capturedFacts,
    });
    state = next;
    return createChange(action, previous, next);
  }

  function transactionPlan(persistedWorkspaces, action, facts) {
    const previous = state;
    const capturedFacts = copyFacts(facts);
    const materializedAction = materializeActionContext(action, previous);
    const stored = normalizedWorkspaces(persistedWorkspaces);
    let rebased = createSessionViewState({
      location: pendingCommands.length
        ? pendingBaseLocation
        : previous.location,
      // Without this the rebase re-derives the memory from the location it was handed,
      // which on the Task screen means "the default workspace" — so every persisted
      // command issued while Tasks is up would forget the project you came from.
      returnContext: pendingCommands.length
        ? pendingBaseReturnContext
        : previous.returnContext,
      workspaces: stored,
    });
    for (const pending of pendingCommands) {
      rebased = applyCommand(rebased, pending.action, pending.facts);
    }
    const next = applyCommand(
      rebased,
      materializedAction,
      capturedFacts
    );
    const deletes = Object.keys(stored).filter(
      (key) => !Object.prototype.hasOwnProperty.call(next.workspaces, key)
    );
    const writes = Object.fromEntries(
      Object.entries(next.workspaces)
        .filter(([key, workspace]) => !sameWorkspace(stored[key], workspace))
        .map(([key, workspace]) => [key, createTabWorkspace(workspace)])
    );
    return {
      value: {
        change: createChange(action, previous, next),
        next,
      },
      writes,
      deletes,
    };
  }

  async function performDispatch(action, facts) {
    if (!persistence) {
      const previous = state;
      const next = applyCommand(
        previous,
        materializeActionContext(action, previous),
        copyFacts(facts)
      );
      state = next;
      return createChange(action, previous, next);
    }

    try {
      const result = await persistence.transact((snapshot) =>
        transactionPlan(snapshot, action, facts)
      );
      state = result.next;
      pendingBaseLocation = null;
      pendingBaseReturnContext = null;
      pendingCommands = [];
      return result.change;
    } catch (error) {
      safeError(onError, error, { phase: "persistence", action });
      return transitionInMemory(action, facts);
    }
  }

  function dispatch(action, facts = {}) {
    const operation = () => performDispatch(action, facts);
    const result = dispatchQueue.then(operation, operation);
    dispatchQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  return {
    getState() {
      return state;
    },
    dispatch,
  };
}

function defaultHistoryMode(action, change) {
  // Strip bookkeeping, not navigation: none of these move what's on screen, so
  // none of them belong in the back stack.
  if (
    action?.type === "PIN_TAB"
    || action?.type === "MOVE_TAB"
    || action?.type === "PROMOTE_TAB"
  ) {
    return "none";
  }
  if (action?.type === "RESTORE_HISTORY") {
    return "replace";
  }
  if (action?.type === "REMOVE_THREAD") {
    return change.locationChanged ? "replace" : "none";
  }
  return change.locationChanged ? "push" : "none";
}

/**
 * Command facade. All external knowledge is sampled here immediately before reduce,
 * so cross-window tombstones and project deletion cannot be hidden by module-init
 * caches.
 */
export function createSessionViewController({
  store,
  historyAdapter = null,
  getProjectIds = () => [],
  getUnavailableThreadIds = () => [],
  onCommit = null,
  onError = null,
} = {}) {
  if (!store?.dispatch || !store?.getState) {
    throw new Error("createSessionViewController requires a session view store");
  }

  const listeners = new Set();
  let queue = Promise.resolve();

  async function commitNow(action, { history = null } = {}) {
    let change;
    try {
      const projectIds = getProjectIds();
      change = await store.dispatch(action, {
        projectIds: projectIds || [],
        projectIdsComplete: projectIds != null,
        unavailableThreadIds: getUnavailableThreadIds() || [],
      });
    } catch (error) {
      safeError(onError, error, { phase: "transaction", action });
      throw error;
    }

    const historyMode = history || defaultHistoryMode(action, change);
    if (historyMode !== "none") {
      try {
        historyAdapter?.write?.({
          threadId: change.next.location.threadId,
          entry: sessionViewHistoryEntry(change.next),
          replace: historyMode === "replace",
        });
      } catch (error) {
        safeError(onError, error, { phase: "history", action });
      }
    }
    try {
      onCommit?.(change);
    } catch (error) {
      safeError(onError, error, { phase: "commit-listener", action });
    }
    for (const listener of listeners) {
      try {
        // Deliberately do not await a returned promise. A listener-triggered command
        // joins the queue behind this fully committed state/history transaction.
        listener(change);
      } catch (error) {
        safeError(onError, error, { phase: "listener", action });
      }
    }
    return change;
  }

  function commit(action, options) {
    const run = queue.then(
      () => commitNow(action, options),
      () => commitNow(action, options)
    );
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function whenIdle() {
    let observed;
    do {
      observed = queue;
      await observed;
    } while (observed !== queue);
  }

  return {
    getState: store.getState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    whenIdle,
    dispatch: commit,
    /**
     * `preview` is tri-state and forwarded verbatim: `true` peeks (reusing the
     * one preview tab), `false` is the deliberate open that keeps the session,
     * and omitting it routes without re-flagging an already-open tab. See the
     * OPEN_THREAD case in session-view-state.js.
     */
    openThread(threadId, { context = null, replace = false, preview = undefined } = {}) {
      return commit(
        { type: "OPEN_THREAD", threadId, context, preview },
        { history: replace ? "replace" : null }
      );
    },
    promoteTab(tabId, { context = null } = {}) {
      return commit({ type: "PROMOTE_TAB", tabId, context }, { history: "none" });
    },
    promoteThread(threadId, { context = null } = {}) {
      return commit({ type: "PROMOTE_TAB", threadId, context }, { history: "none" });
    },
    switchContext(context, { replace = false } = {}) {
      return commit(
        { type: "SWITCH_CONTEXT", context },
        { history: replace ? "replace" : null }
      );
    },
    /**
     * Leave the Task screen for the tab surface the user came from.
     *
     * Takes no context on purpose. The target is resolved inside the reduction, so it
     * sees the state this command actually lands on rather than whatever was published
     * when the button was clicked — a persisted dispatch only publishes after its
     * transaction settles, so a caller-side read races every in-flight navigation.
     */
    returnToSessions({ replace = false } = {}) {
      return commit(
        { type: "RETURN_TO_SESSIONS" },
        { history: replace ? "replace" : null }
      );
    },
    showOverview(context = null, { replace = false } = {}) {
      return commit(
        { type: "SHOW_OVERVIEW", context },
        { history: replace ? "replace" : null }
      );
    },
    closeTab(tabId, { context = null, replace = false } = {}) {
      return commit(
        { type: "CLOSE_TAB", tabId, context },
        { history: replace ? "replace" : null }
      );
    },
    pinTab(tabId, pinned, { context = null } = {}) {
      return commit(
        { type: "PIN_TAB", tabId, pinned, context },
        { history: "none" }
      );
    },
    moveTab(tabId, toIndex, { context = null } = {}) {
      return commit(
        { type: "MOVE_TAB", tabId, toIndex, context },
        { history: "none" }
      );
    },
    removeThread(threadId) {
      return commit({ type: "REMOVE_THREAD", threadId });
    },
    /**
     * `preview: true` marks this as Back/Forward — the browser replaying peeks the
     * user already made, so a reopened session reuses the preview slot.
     *
     * Boot passes nothing, which means "route to it and leave an existing tab
     * alone": a link to a session you are not holding open becomes a kept tab,
     * while a refresh on one you were peeking at stays a peek. See the
     * RESTORE_HISTORY case in session-view-state.js.
     */
    restoreHistory(entry, urlThreadId, { preview = undefined } = {}) {
      return commit(
        { type: "RESTORE_HISTORY", entry, urlThreadId, preview },
        { history: "replace" }
      );
    },
  };
}

/** Browser boundary used by app.js; injectable controller tests use a fake adapter. */
export function createBrowserSessionViewHistoryAdapter(browserWindow) {
  return {
    read() {
      const url = new URL(browserWindow.location.href);
      return {
        entry: browserWindow.history.state,
        threadId: url.searchParams.get("thread") || null,
      };
    },
    write({ threadId, entry, replace = false }) {
      const url = new URL(browserWindow.location.href);
      if (threadId) {
        url.searchParams.set("thread", threadId);
      } else {
        url.searchParams.delete("thread");
      }
      const next = url.pathname + url.search + url.hash;
      if (replace) {
        browserWindow.history.replaceState(entry, "", next);
      } else {
        browserWindow.history.pushState(entry, "", next);
      }
    },
  };
}
