// Pure state machine for a surface's visible session + scoped tab sets.
//
// `location` is the single canonical answer to "what is on screen":
//   - Sessions home:        { context: { kind: "sessions" }, threadId: null }
//   - Project overview:     { context: { kind: "project", projectId }, threadId: null }
//   - A visible session:    { context, threadId }
//
// A workspace's `focusedTabId` is only its REMEMBERED focus. It becomes visible when
// SWITCH_CONTEXT restores it; SHOW_OVERVIEW can deliberately show no thread while
// preserving that memory. This distinction removes the old competition between
// `state.viewThreadId` and `workspace.focusedTabId`.
//
// This module deliberately knows nothing about DOM, React, History, transcript loading,
// or persistence. session-view-controller turns browser/backend events into commands,
// commits one transition, then performs those effects.

import {
  closeTab,
  createTabWorkspace,
  findTab,
  findTabByThread,
  focusedTab,
  layoutHasThread,
  layoutThreadIds,
  moveTab,
  openThreadTab,
  promoteTab,
  retargetThread,
  setTabPinned,
} from "./tab-layout.js";
import { SESSIONS_KEY } from "./tab-workspace-store.js";

const HISTORY_VERSION = 1;

function stringId(value) {
  return typeof value === "string" && value ? value : null;
}

function stringSet(values) {
  return new Set(
    (values instanceof Set ? [...values] : Array.isArray(values) ? values : [])
      .map(stringId)
      .filter(Boolean)
  );
}

// Two contexts, not three. `projects-home` meant "in Projects mode, with no project
// selected" — a state that only existed because a toggle could put you in that mode
// without a selection. With the toggle gone there is no way to reach it and nothing
// for it to mean: "no project selected" IS the sessions context, which is what the
// switcher calls Default Workspace.
//
// Everything that used to produce it now produces `sessions`, including a persisted
// entry naming a project that no longer exists.
// A third kind DID arrive, and it is not a project: the Task screen. It is a
// full-area non-chat view, so it never routes a thread and never owns tabs — but
// it must be a real context rather than a `data-view`, because it participates in
// history and must not inherit whichever project workspace was last open.
//
// `teamRunId` null is the task LIST; a value is one task's detail. Both are the
// same kind because they are the same screen; they differ in key so the back
// button can tell them apart.
export function normalizeSessionViewContext(context) {
  if (context?.kind === "project") {
    const projectId = stringId(context.projectId);
    return projectId ? { kind: "project", projectId } : { kind: "sessions" };
  }
  if (context?.kind === "tasks") {
    return { kind: "tasks", teamRunId: stringId(context.teamRunId) };
  }
  if (context?.kind === "teams") {
    return { kind: "teams", teamId: stringId(context.teamId) };
  }
  if (context?.kind === "usage") {
    return { kind: "usage" };
  }
  // The full-screen merge review (15a). Unlike `tasks`, a null id is not a list
  // state — the screen reviews ONE branch. Falling back keeps a truncated history
  // entry from landing on a blank screen that reads as a failed load.
  if (context?.kind === "review") {
    const teamRunId = stringId(context.teamRunId);
    return teamRunId ? { kind: "review", teamRunId } : { kind: "tasks", teamRunId: null };
  }
  // The ticket page (17b) — one run's own screen, entered from the board. Same
  // shape as `review`: a null id is not a list state, so it falls back rather
  // than landing a truncated history entry on a blank screen.
  if (context?.kind === "ticket") {
    const teamRunId = stringId(context.teamRunId);
    return teamRunId ? { kind: "ticket", teamRunId } : { kind: "tasks", teamRunId: null };
  }
  return { kind: "sessions" };
}

/**
 * The context a session row belongs to, decided by MEMBERSHIP alone.
 *
 * Total by design: it returns `{kind:"sessions"}` rather than null for a session
 * in no project, and that distinction is the whole reason it exists.
 * `setThreadRoute` reads a null context as "keep the current one", so expressing
 * "this session belongs to no project" as null silently filed unassigned sessions
 * into whichever project happened to be selected — giving them a tab in that
 * project's workspace and leaving the switcher still naming it.
 *
 * That could not happen under the old Projects mode, which listed only the
 * selected project's sessions. Pinning keeps the whole list on screen, so an
 * unassigned row now sits one click away from a pinned project at all times.
 */
export function selectOwningContext({ threadId = null, threadProjectId = null } = {}) {
  const id = stringId(threadId);
  const projectId = id ? stringId(threadProjectId?.[id]) : "";
  return projectId ? { kind: "project", projectId } : { kind: "sessions" };
}

/**
 * Where to go after deleting a project.
 *
 * Returns null when the deletion does not concern the current context — the caller must
 * not navigate at all then, or deleting a project from a list would yank you out of the
 * one you are in.
 *
 * When it IS the one you are in, the answer is the sessions context and nothing else.
 * It used to be "the first surviving project", which existed so that entering Projects
 * mode always had something to show; with no mode to enter, landing you in whichever
 * project happens to sort first is the sidebar choosing a container on your behalf —
 * and it can put the next agent you start somewhere you never looked at.
 *
 * Extracted because it was an inline branch racing `dropStaleProjectSelection`: one
 * navigated to a survivor, the other cleared the selection, and which won decided the
 * behaviour. The observable outcome happened to be the intended one, which is the
 * worst kind of correct — the code said the opposite of what shipped.
 *
 * Call it with the context as it is when the delete COMPLETES, never with a snapshot
 * taken at confirm time. The request is a full round trip and the switcher stays live
 * throughout it, so a confirm-time answer can overrule a navigation the user made in
 * between — the null branch above is what makes a late read do the right thing.
 *
 * Deliberately takes no survivor list. There is no receipt shape that changes the
 * answer, so there is none to get wrong.
 */
export function selectContextAfterProjectDelete({ context = null, deletedProjectId = "" } = {}) {
  const deleted = stringId(deletedProjectId);
  if (!deleted) {
    return null;
  }
  const current = normalizeSessionViewContext(context);
  if (current.kind !== "project" || current.projectId !== deleted) {
    return null;
  }
  return { kind: "sessions" };
}

// Sentinel prefix for the Task screen's keys. Distinct from a project id (which is
// a bare uuid) and from SESSIONS_KEY, so no context can ever alias another's tab
// workspace.
export const TASKS_KEY = "__tasks__";
export const TEAMS_KEY = "__teams__";
export const USAGE_KEY = "__usage__";
// Its own key, not a suffix on TASKS_KEY: the review screen and a task's detail
// are two destinations for the same run, and a shared key would make Back unable
// to tell them apart.
export const REVIEW_KEY = "__review__";
export const TICKET_KEY = "__ticket__";

/**
 * The full-area, non-chat screens.
 *
 * `tasks` was the first; `usage` the second; `teams` the third; `review` (the
 * full-screen merge review, mockup 15a) the fourth. Grouped because
 * every rule that applied to one applies to the others for the SAME reason —
 * they render over the whole main area, show no tab strip, route no thread, and
 * are not somewhere the Sessions button should return you TO.
 *
 * This exists as a predicate rather than as a growing `||` chain at each site
 * because those sites are exactly where the silent bugs are: a tab filed under a
 * context with no strip is unreachable, and `mainView` keeps rendering the
 * screen, so the user sees a click that does nothing. Missing ONE of eight call
 * sites reintroduces that, invisibly. Adding another such screen should be one
 * entry here, not an audit.
 */
const FULL_AREA_KINDS = new Set(["tasks", "teams", "usage", "review", "ticket"]);

export function isFullAreaContext(context) {
  return FULL_AREA_KINDS.has(context?.kind);
}

export function isTasksWorkspaceKey(key) {
  return key === TASKS_KEY || (typeof key === "string" && key.startsWith(`${TASKS_KEY}:`));
}

export function isTeamsWorkspaceKey(key) {
  return key === TEAMS_KEY || (typeof key === "string" && key.startsWith(`${TEAMS_KEY}:`));
}

/**
 * Whether a stored workspace key belongs to a full-area screen.
 *
 * Load-bearing for persistence: `validHistoryWorkspaces` is an ALLOWLIST whose
 * output is diffed against what is on disk, and every key it omits becomes a
 * DELETE. These keys are not enumerable from any fact the controller holds (there
 * is no `taskIds` the way there is a `projectIds`), so they are recognised by
 * shape. Drop a shape from here and every restore silently collects that screen's
 * stored state.
 */
export function isReviewWorkspaceKey(key) {
  return key === REVIEW_KEY || (typeof key === "string" && key.startsWith(`${REVIEW_KEY}:`));
}

export function isTicketWorkspaceKey(key) {
  return key === TICKET_KEY || (typeof key === "string" && key.startsWith(`${TICKET_KEY}:`));
}

export function isFullAreaWorkspaceKey(key) {
  return (
    isTasksWorkspaceKey(key)
    || isTeamsWorkspaceKey(key)
    || isReviewWorkspaceKey(key)
    || isTicketWorkspaceKey(key)
    || key === USAGE_KEY
  );
}

export function sessionViewContextKey(context) {
  const normalized = normalizeSessionViewContext(context);
  if (normalized.kind === "sessions") {
    return SESSIONS_KEY;
  }
  if (normalized.kind === "tasks") {
    return normalized.teamRunId ? `${TASKS_KEY}:${normalized.teamRunId}` : TASKS_KEY;
  }
  if (normalized.kind === "teams") {
    return normalized.teamId ? `${TEAMS_KEY}:${normalized.teamId}` : TEAMS_KEY;
  }
  if (normalized.kind === "usage") {
    return USAGE_KEY;
  }
  if (normalized.kind === "review") {
    return `${REVIEW_KEY}:${normalized.teamRunId}`;
  }
  if (normalized.kind === "ticket") {
    return `${TICKET_KEY}:${normalized.teamRunId}`;
  }
  return normalized.projectId;
}

/**
 * Where a thread tab may actually live.
 *
 * The Task screen is a full-area view with no tab strip, so a tab filed under its
 * context is unreachable — and because `mainView` is derived from the context, the
 * screen keeps rendering and the thread never appears at all. The user sees a
 * click that does nothing.
 *
 * `OPEN_THREAD` inherits the current context when the caller supplies none, which
 * is the right default for every context that CAN hold tabs and silently wrong for
 * the one that cannot. Callers should still pass the thread's owning context so a
 * project session lands in its project; this is the floor that stops a missing one
 * from becoming invisible, for every future call site as well as today's.
 */
function contextThatCanHoldTabs(context) {
  return isFullAreaContext(context) ? { kind: "sessions" } : context;
}

/**
 * A context worth returning TO, or null if it is not one.
 *
 * The Sessions destination restores this. A tasks context is rejected rather than
 * coerced: coercing would silently overwrite a remembered project with the default
 * workspace the moment the user moved between two task screens, which is the exact
 * loss this memory exists to prevent. Null means "keep what you had".
 */
function returnableContext(context) {
  if (!context || isFullAreaContext(context)) {
    return null;
  }
  const normalized = normalizeSessionViewContext(context);
  return isFullAreaContext(normalized) ? null : normalized;
}

/**
 * The remembered context, or the default workspace if its project is provably gone.
 *
 * Same rule `contextFromHistory` applies to a restored selection: absence is only
 * evidence of deletion once the catalogue is authoritative. `projectIdsComplete: false`
 * means the Projects payload has not landed yet, and discarding a live project because
 * a fetch is still in flight is the worse failure — it silently moves the user's tabs.
 */
function availableReturnContext(context, facts = {}) {
  if (context.kind !== "project" || facts.projectIdsComplete === false) {
    return context;
  }
  const projectIds = facts.projectIds;
  if (!Array.isArray(projectIds)) {
    return context;
  }
  return projectIds.includes(context.projectId) ? context : { kind: "sessions" };
}

function sameContext(left, right) {
  return sessionViewContextKey(left) === sessionViewContextKey(right);
}

function normalizeWorkspaces(workspaces) {
  return Object.fromEntries(
    Object.entries(workspaces || {}).map(([key, workspace]) => [
      key,
      createTabWorkspace(workspace),
    ])
  );
}

function workspaceFor(state, context) {
  return createTabWorkspace(state.workspaces[sessionViewContextKey(context)] || {});
}

function withWorkspace(state, context, workspace) {
  const key = sessionViewContextKey(context);
  return {
    ...state,
    workspaces: {
      ...state.workspaces,
      [key]: createTabWorkspace(workspace),
    },
  };
}

function focusedThreadId(workspace) {
  const tab = focusedTab(workspace);
  return tab ? layoutThreadIds(tab.layout)[0] || null : null;
}

/**
 * Normalize/repair an arbitrary snapshot.
 *
 * A routed thread is always opened and focused in its exact context. This is the core
 * invariant consumers previously had to re-establish independently after boot,
 * popstate, mode switches, deletion, and promotion.
 */
export function createSessionViewState(initial = {}) {
  const context = normalizeSessionViewContext(initial.location?.context);
  const threadId = stringId(initial.location?.threadId);
  let state = {
    location: { context, threadId },
    // Derived here only so that a hand-built or persisted snapshot is never missing
    // it. The value that actually survives a trip through Tasks is re-applied by
    // `reduceSessionView`, which is the one place that can still see where we came
    // from — every reducer case below rebuilds through this function and would
    // otherwise flatten the memory to the current location.
    returnContext: returnableContext(initial.returnContext) || contextThatCanHoldTabs(context),
    workspaces: normalizeWorkspaces(initial.workspaces),
  };

  const current = workspaceFor(state, context);
  state = withWorkspace(
    state,
    context,
    threadId ? openThreadTab(current, threadId) : current
  );
  return state;
}

function removeThread(state, threadId) {
  const target = stringId(threadId);
  if (!target) {
    return state;
  }

  const workspaces = Object.fromEntries(
    Object.entries(state.workspaces).map(([key, workspace]) => {
      const normalized = createTabWorkspace(workspace);
      const owning = findTabByThread(normalized, target);
      return [key, owning ? closeTab(normalized, owning.id) : normalized];
    })
  );

  let location = state.location;
  if (location.threadId === target) {
    location = {
      context: location.context,
      threadId: focusedThreadId(
        createTabWorkspace(workspaces[sessionViewContextKey(location.context)] || {})
      ),
    };
  }
  // Carried, not re-derived. Closing a tab says nothing about where the Sessions button
  // should go, but a rebuild that omits this re-derives it FROM THE LOCATION — and on
  // the Task screen that reads as "no project". `sweepUnavailableThreads` runs this once
  // per tombstone before every action, so for anyone who has ever deleted a session the
  // memory would be flattened before `RETURN_TO_SESSIONS` ever got to read it.
  return createSessionViewState({
    location,
    returnContext: state.returnContext,
    workspaces,
  });
}

function sweepUnavailableThreads(state, unavailableThreadIds) {
  let next = state;
  for (const threadId of stringSet(unavailableThreadIds)) {
    next = removeThread(next, threadId);
  }
  return next;
}

function contextFromHistory(
  entry,
  currentContext,
  projectIds,
  projectIdsComplete = true
) {
  const knownProjects = stringSet(projectIds);

  // Versioned entries store context only. The URL remains the canonical/shareable
  // carrier for the thread id, so it cannot disagree with a duplicate history field.
  if (entry?.version === HISTORY_VERSION && entry.context) {
    const context = normalizeSessionViewContext(entry.context);
    if (
      projectIdsComplete
      && context.kind === "project"
      && !knownProjects.has(context.projectId)
    ) {
      return { kind: "sessions" };
    }
    // A tasks context is deliberately NOT validated the same way. A project that
    // no longer exists must fall back, because the sidebar scopes itself to it and
    // would show an empty list with a name attached. A task that no longer exists
    // is information: its branch is still on disk, and the screen saying so is
    // more useful than being dropped at the sessions home with no explanation.
    return context;
  }

  // Compatibility with entries written before the state machine lands.
  if (entry?.viewMode === "sessions") {
    return { kind: "sessions" };
  }
  // `viewMode` is gone from the store, but entries written before it went are still on
  // disk and still name a mode. A project that still exists is still restorable; the
  // mode itself no longer restores to anything.
  if (entry?.viewMode === "projects") {
    const projectId = stringId(entry.projectId);
    return projectId && (!projectIdsComplete || knownProjects.has(projectId))
      ? { kind: "project", projectId }
      : { kind: "sessions" };
  }

  // Legacy `{}` / null / external links carry no context. Keep the context already
  // selected by the surface; initial boot supplies Sessions as that safe default.
  return normalizeSessionViewContext(currentContext);
}

/**
 * Apply one navigation-domain command.
 *
 * Facts are authoritative external knowledge captured by the controller for this
 * transition:
 *   - `projectIds`: projects that may be restored from untrusted history
 *   - `unavailableThreadIds`: archived/deleted threads that may not be opened
 */
/**
 * Carry "where the Sessions button goes back to" across a transition.
 *
 * Every case below rebuilds state through `createSessionViewState`, which can only
 * see the location it is handed — so the memory has to be re-applied out here, where
 * both the incoming snapshot and the outgoing state are in scope. Landing on any
 * tab-holding surface updates it; landing on Tasks leaves it alone.
 */
export function reduceSessionView(snapshot, action = {}, facts = {}) {
  const carried = returnableContext(snapshot?.returnContext);
  const next = reduceSessionViewCases(snapshot, action, facts);
  const landed = returnableContext(next.location.context);
  return { ...next, returnContext: landed || carried || { kind: "sessions" } };
}

function reduceSessionViewCases(snapshot, action = {}, facts = {}) {
  let state = sweepUnavailableThreads(
    createSessionViewState(snapshot),
    facts.unavailableThreadIds
  );

  switch (action.type) {
    case "OPEN_THREAD": {
      const threadId = stringId(action.threadId);
      if (!threadId) {
        return state;
      }
      if (stringSet(facts.unavailableThreadIds).has(threadId)) {
        return removeThread(state, threadId);
      }
      const context = contextThatCanHoldTabs(
        action.context ? normalizeSessionViewContext(action.context) : state.location.context
      );
      // Three intents, and the difference matters:
      //   preview: true   browse — reuse the one preview slot
      //   preview: false  deliberate open — keep it, promoting an existing peek
      //   omitted         route to it (boot, popstate, a new session, a fallback
      //                   after a close): a new tab is kept, an open one is left
      //                   exactly as it is. Navigation must never silently
      //                   consume or free the preview slot.
      const opened = openThreadTab(workspaceFor(state, context), threadId, {
        preview: action.preview === true,
      });
      const owning = action.preview === false ? findTabByThread(opened, threadId) : null;
      return createSessionViewState({
        location: { context, threadId },
        workspaces: withWorkspace(
          state,
          context,
          owning ? promoteTab(opened, owning.id) : opened
        ).workspaces,
      });
    }

    case "PROMOTE_TAB": {
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const current = workspaceFor(state, context);
      // Addressable either way: the tab strip knows the tab, the composer and the
      // sidebar know the session.
      const tabId =
        stringId(action.tabId)
        || findTabByThread(current, stringId(action.threadId))?.id
        || null;
      if (!tabId) {
        return state;
      }
      return createSessionViewState({
        location: state.location,
        workspaces: withWorkspace(state, context, promoteTab(current, tabId)).workspaces,
      });
    }

    // The Sessions destination. Resolving the target HERE rather than at the call site
    // is the whole point: the caller would have to read the store before its command
    // enters the queue, so a click landing on top of a not-yet-persisted project switch
    // would capture the previous project and then navigate to it, undoing the switch.
    case "RETURN_TO_SESSIONS": {
      const context = availableReturnContext(
        returnableContext(state.returnContext) || { kind: "sessions" },
        facts
      );
      return createSessionViewState({
        location: {
          context,
          threadId: focusedThreadId(workspaceFor(state, context)),
        },
        workspaces: state.workspaces,
      });
    }

    case "SWITCH_CONTEXT": {
      const context = normalizeSessionViewContext(action.context);
      return createSessionViewState({
        location: {
          context,
          threadId: focusedThreadId(workspaceFor(state, context)),
        },
        workspaces: state.workspaces,
      });
    }

    case "SHOW_OVERVIEW": {
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      return createSessionViewState({
        location: { context, threadId: null },
        workspaces: state.workspaces,
      });
    }

    case "CLOSE_TAB": {
      const tabId = stringId(action.tabId);
      if (!tabId) {
        return state;
      }
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const current = workspaceFor(state, context);
      const closing = findTab(current, tabId);
      const closesVisibleThread = Boolean(
        closing
        && sameContext(context, state.location.context)
        && state.location.threadId
        && layoutHasThread(closing.layout, state.location.threadId)
      );
      const closed = closeTab(current, tabId);
      const next = withWorkspace(state, context, closed);
      return createSessionViewState({
        location: closesVisibleThread
          ? { context: state.location.context, threadId: focusedThreadId(closed) }
          : state.location,
        workspaces: next.workspaces,
      });
    }

    case "PIN_TAB": {
      const tabId = stringId(action.tabId);
      if (!tabId) {
        return state;
      }
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const next = withWorkspace(
        state,
        context,
        setTabPinned(workspaceFor(state, context), tabId, action.pinned)
      );
      return createSessionViewState({
        location: state.location,
        workspaces: next.workspaces,
      });
    }

    case "MOVE_TAB": {
      const tabId = stringId(action.tabId);
      if (!tabId) {
        return state;
      }
      const context = action.context
        ? normalizeSessionViewContext(action.context)
        : state.location.context;
      const next = withWorkspace(
        state,
        context,
        moveTab(workspaceFor(state, context), tabId, action.toIndex)
      );
      return createSessionViewState({
        location: state.location,
        workspaces: next.workspaces,
      });
    }

    case "REMOVE_THREAD":
      return removeThread(state, action.threadId);

    case "RETARGET_THREAD": {
      const fromThreadId = stringId(action.fromThreadId);
      const toThreadId = stringId(action.toThreadId);
      if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) {
        return state;
      }
      if (stringSet(facts.unavailableThreadIds).has(toThreadId)) {
        return removeThread(removeThread(state, fromThreadId), toThreadId);
      }

      const workspaces = Object.fromEntries(
        Object.entries(state.workspaces).map(([key, workspace]) => [
          key,
          retargetThread(workspace, fromThreadId, toThreadId),
        ])
      );
      return createSessionViewState({
        location: {
          context: state.location.context,
          threadId:
            state.location.threadId === fromThreadId
              ? toThreadId
              : state.location.threadId,
        },
        workspaces,
      });
    }

    case "RESTORE_HISTORY": {
      const context = contextFromHistory(
        action.entry,
        state.location.context,
        facts.projectIds,
        facts.projectIdsComplete !== false
      );
      const urlThreadId = stringId(action.urlThreadId);
      const unavailable = stringSet(facts.unavailableThreadIds);
      if (!urlThreadId || unavailable.has(urlThreadId)) {
        return createSessionViewState({
          location: {
            context,
            threadId: urlThreadId
              ? focusedThreadId(workspaceFor(state, context))
              : null,
          },
          workspaces: state.workspaces,
        });
      }
      // The SECOND place a tab gets created, and it needs the same floor as
      // `OPEN_THREAD`. A persisted tasks context plus a `?thread=` off the URL
      // would otherwise file the tab where no strip renders it and no view shows
      // it. Not reachable through today's history writer — it drops `?thread=`
      // when nothing is routed — but the guard's claim is that it holds for the
      // call sites that do not exist yet, and one branch is not "every".
      const tabContext = contextThatCanHoldTabs(context);

      // Back/Forward retraces a browse, so it reuses the preview slot exactly as
      // the clicks it is replaying did — otherwise walking back through a browse
      // deposits one permanent tab per step, which is the accumulation the
      // preview tab exists to stop.
      //
      // Boot passes no flag, and that means "route to it, changing nothing about
      // a tab that already exists". Concretely:
      //
      //   * a link to a session you are NOT holding open  -> a new, KEPT tab.
      //     You named it on purpose, so it must not be the first thing the next
      //     peek throws away.
      //   * a refresh on a session you were only peeking at -> STILL a peek.
      //     Reload is not a gesture. Preview-ness is persisted state and has to
      //     round-trip faithfully, or refreshing the page would quietly pin
      //     whatever you happened to be looking at.
      //
      // Both fall out of one rule — `openThreadTab` only ever flags a NEW tab —
      // which is why this passes no flag rather than choosing between them here.
      const opened = openThreadTab(workspaceFor(state, tabContext), urlThreadId, {
        preview: action.preview === true,
      });
      return createSessionViewState({
        location: { context: tabContext, threadId: urlThreadId },
        workspaces: withWorkspace(state, tabContext, opened).workspaces,
      });
    }

    default:
      return state;
  }
}

/** Browser history stores context only; `?thread=` remains the thread route. */
export function sessionViewHistoryEntry(state) {
  return {
    version: HISTORY_VERSION,
    context: normalizeSessionViewContext(state?.location?.context),
  };
}

/**
 * Runtime/test diagnostic. A valid visible thread belongs to exactly the tab that the
 * current context remembers as focused. An overview/home may retain remembered focus
 * while routing no thread.
 */
export function sessionViewInvariantErrors(snapshot) {
  const errors = [];
  const context = normalizeSessionViewContext(snapshot?.location?.context);
  const threadId = stringId(snapshot?.location?.threadId);
  const workspaces = normalizeWorkspaces(snapshot?.workspaces);
  const current = createTabWorkspace(
    workspaces[sessionViewContextKey(context)] || {}
  );

  if (threadId && isFullAreaContext(context)) {
    // Stated separately from "not open in <key>", which this would also trip. The
    // generic message names the workspace key and reads like a missing tab; this
    // one names the actual fault, which is that the context can never hold one.
    // A thread routed here is invisible: the Task screen renders no tab strip,
    // and `mainView` keeps showing the Task screen because it reads the context.
    errors.push(`context ${sessionViewContextKey(context)} cannot hold a thread tab`);
  } else if (threadId) {
    const owning = findTabByThread(current, threadId);
    if (!owning) {
      errors.push(`visible thread ${threadId} is not open in ${sessionViewContextKey(context)}`);
    } else if (current.focusedTabId !== owning.id) {
      errors.push(
        `visible thread ${threadId} is not the remembered focus in ${sessionViewContextKey(context)}`
      );
    }
  }

  // The Sessions destination switches straight to this, so a tasks context here would
  // send the one button that leaves the Task screen back to the Task screen — an exit
  // that returns you to the room you were trying to leave.
  if (snapshot?.returnContext && isFullAreaContext(snapshot.returnContext)) {
    errors.push("returnContext cannot be a full-area context");
  }

  for (const [key, workspace] of Object.entries(workspaces)) {
    const normalized = createTabWorkspace(workspace);
    if (normalized.focusedTabId && !findTab(normalized, normalized.focusedTabId)) {
      errors.push(`workspace ${key} focuses a missing tab`);
    }
  }
  return errors;
}
