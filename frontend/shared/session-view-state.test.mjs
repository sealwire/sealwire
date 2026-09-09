import assert from "node:assert/strict";
import test from "node:test";

import { layoutThreadIds, setTabPinned, tabIdForThread } from "./tab-layout.js";
import { SESSIONS_KEY } from "./tab-workspace-store.js";
import {
  createSessionViewState,
  isFullAreaContext,
  isFullAreaWorkspaceKey,
  reduceSessionView,
  selectContextAfterProjectDelete,
  selectOwningContext,
  sessionViewContextKey,
  sessionViewHistoryEntry,
  sessionViewInvariantErrors,
  normalizeSessionViewContext,
} from "./session-view-state.js";

const sessions = () => ({ kind: "sessions" });
const project = (projectId) => ({ kind: "project", projectId });
const review = (teamRunId) => ({ kind: "review", teamRunId });
// `projects-home` is gone: it meant "in Projects mode with nothing selected", and the
// toggle that could put you there no longer exists. Everything that used to land there
// lands in the sessions context, which the switcher calls Default Workspace. The
// invariant these tests guard is unchanged — a deleted project must not hydrate its
// cold tab set — only where the fallback lands.
const projectsHome = () => ({ kind: "sessions" });

function transition(state, action, facts = {}) {
  const next = reduceSessionView(state, action, facts);
  assert.deepEqual(
    sessionViewInvariantErrors(next),
    [],
    `invariant failed after ${action.type}`
  );
  return next;
}

function workspaceThreadIds(state, key) {
  return (state.workspaces[key]?.tabs || []).flatMap((tab) => layoutThreadIds(tab.layout));
}

test("opening and switching contexts keep one canonical visible location", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-a" });
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-b" });

  assert.deepEqual(state.location, {
    context: sessions(),
    threadId: "session-b",
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["session-a", "session-b"]);

  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: project("project-1"),
  });
  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: null,
  });
  assert.deepEqual(workspaceThreadIds(state, "project-1"), []);

  state = transition(state, { type: "OPEN_THREAD", threadId: "project-session" });
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["project-session"]);
  assert.deepEqual(
    workspaceThreadIds(state, SESSIONS_KEY),
    ["session-a", "session-b"],
    "opening in a project never leaks into Sessions"
  );

  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: sessions(),
  });
  assert.deepEqual(
    state.location,
    { context: sessions(), threadId: "session-b" },
    "switching back restores that context's remembered focus"
  );
});

test("showing home or a project overview preserves remembered tabs without routing one", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-a" });
  state = transition(state, {
    type: "SHOW_OVERVIEW",
    context: sessions(),
  });

  assert.deepEqual(state.location, { context: sessions(), threadId: null });
  assert.equal(state.workspaces[SESSIONS_KEY].focusedTabId, tabIdForThread("session-a"));
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["session-a"]);

  state = transition(state, { type: "SWITCH_CONTEXT", context: sessions() });
  assert.equal(state.location.threadId, "session-a");
});

test("closing the visible tab chooses the layout neighbour; closing another leaves location alone", () => {
  let state = createSessionViewState();
  for (const threadId of ["a", "b", "c"]) {
    state = transition(state, { type: "OPEN_THREAD", threadId });
  }
  state = transition(state, { type: "OPEN_THREAD", threadId: "b" });

  state = transition(state, {
    type: "CLOSE_TAB",
    tabId: tabIdForThread("a"),
  });
  assert.equal(state.location.threadId, "b", "closing a background tab changes no route");

  state = transition(state, {
    type: "CLOSE_TAB",
    tabId: tabIdForThread("b"),
  });
  assert.equal(state.location.threadId, "c", "the right neighbour becomes visible");
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["c"]);

  state = transition(state, {
    type: "CLOSE_TAB",
    tabId: tabIdForThread("c"),
  });
  assert.deepEqual(state.location, { context: sessions(), threadId: null });
});

test("removing a thread sweeps every context and settles the visible location", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "shared" });
  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: project("project-1"),
  });
  state = transition(state, { type: "OPEN_THREAD", threadId: "project-fallback" });
  state = transition(state, { type: "OPEN_THREAD", threadId: "shared" });

  state = transition(state, { type: "REMOVE_THREAD", threadId: "shared" });

  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), []);
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["project-fallback"]);
  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: "project-fallback",
  });
});

test("promotion rekeys the same visible tab without losing pin or identity invariants", () => {
  let state = createSessionViewState();
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "claude-pending-1",
  });
  state = {
    ...state,
    workspaces: {
      ...state.workspaces,
      [SESSIONS_KEY]: setTabPinned(
        state.workspaces[SESSIONS_KEY],
        tabIdForThread("claude-pending-1"),
        true
      ),
    },
  };

  state = transition(state, {
    type: "RETARGET_THREAD",
    fromThreadId: "claude-pending-1",
    toThreadId: "claude-real-1",
  });

  assert.deepEqual(state.location, {
    context: sessions(),
    threadId: "claude-real-1",
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["claude-real-1"]);
  assert.equal(state.workspaces[SESSIONS_KEY].tabs[0].id, tabIdForThread("claude-real-1"));
  assert.equal(state.workspaces[SESSIONS_KEY].tabs[0].pinned, true);
});

test("valid move and background-context pin/move do not disturb the visible location", () => {
  let state = createSessionViewState();
  for (const threadId of ["a", "b", "c"]) {
    state = transition(state, { type: "OPEN_THREAD", threadId });
  }
  state = transition(state, {
    type: "SWITCH_CONTEXT",
    context: project("project-1"),
  });
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "project-visible",
  });

  state = transition(state, {
    type: "MOVE_TAB",
    tabId: tabIdForThread("c"),
    toIndex: 0,
    context: sessions(),
  });
  state = transition(state, {
    type: "PIN_TAB",
    tabId: tabIdForThread("a"),
    pinned: true,
    context: sessions(),
  });
  state = transition(state, {
    type: "MOVE_TAB",
    tabId: tabIdForThread("b"),
    toIndex: 1,
    context: sessions(),
  });

  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: "project-visible",
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a", "b", "c"]);
  assert.equal(state.workspaces[SESSIONS_KEY].tabs[0].pinned, true);
});

test("versioned history restores the exact context while the URL owns the thread id", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "session-a" });
  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {
        version: 1,
        context: project("project-1"),
      },
      urlThreadId: "project-session",
    },
    { projectIds: ["project-1"] }
  );

  assert.deepEqual(state.location, {
    context: project("project-1"),
    threadId: "project-session",
  });
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["project-session"]);
  assert.deepEqual(sessionViewHistoryEntry(state), {
    version: 1,
    context: project("project-1"),
  });
});

test("history preserves project context while project ids are not authoritative yet", () => {
  let state = createSessionViewState();
  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {
        version: 1,
        context: project("project-loading"),
      },
      urlThreadId: "project-session",
    },
    {
      projectIds: [],
      projectIdsComplete: false,
    }
  );

  assert.deepEqual(state.location, {
    context: project("project-loading"),
    threadId: "project-session",
  });
});

test("legacy empty history keeps the current context", () => {
  let state = createSessionViewState({
    location: {
      context: project("project-1"),
      threadId: "project-session",
    },
  });

  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {},
      urlThreadId: "project-session",
    },
    { projectIds: ["project-1"] }
  );

  assert.deepEqual(state.location.context, project("project-1"));
  assert.equal(state.location.threadId, "project-session");
});

test("history naming a deleted project falls back without creating its tab set", () => {
  const state = transition(
    createSessionViewState(),
    {
      type: "RESTORE_HISTORY",
      entry: {
        viewMode: "projects",
        projectId: "deleted-project",
      },
      urlThreadId: null,
    },
    { projectIds: ["live-project"] }
  );

  assert.deepEqual(state.location, {
    context: projectsHome(),
    threadId: null,
  });
  assert.equal(state.workspaces["deleted-project"], undefined);
  // SESSIONS_KEY, not the old NO_PROJECT_KEY: the fallback context IS the sessions
  // context now, so it keys the sessions tab set rather than a third one of its own.
  assert.equal(sessionViewContextKey(state.location.context), SESSIONS_KEY);
});

test("a tombstoned history thread is swept and falls back inside the restored context", () => {
  let state = createSessionViewState({
    location: {
      context: project("project-1"),
      threadId: "project-fallback",
    },
  });

  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: {
        version: 1,
        context: project("project-1"),
      },
      urlThreadId: "deleted-thread",
    },
    {
      projectIds: ["project-1"],
      unavailableThreadIds: ["deleted-thread"],
    }
  );

  assert.equal(state.location.threadId, "project-fallback");
  assert.ok(!workspaceThreadIds(state, "project-1").includes("deleted-thread"));
});

test("state construction repairs a routed thread into its exact context", () => {
  const state = createSessionViewState({
    location: {
      context: project("project-1"),
      threadId: "deep-link",
    },
  });

  assert.deepEqual(sessionViewInvariantErrors(state), []);
  assert.deepEqual(workspaceThreadIds(state, "project-1"), ["deep-link"]);
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), []);
});

test("the invariant diagnostic reports an unowned visible thread without repairing it first", () => {
  const errors = sessionViewInvariantErrors({
    location: {
      context: sessions(),
      threadId: "missing-tab",
    },
    workspaces: {
      [SESSIONS_KEY]: { tabs: [], focusedTabId: null },
    },
  });

  assert.deepEqual(errors, [
    `visible thread missing-tab is not open in ${SESSIONS_KEY}`,
  ]);
});

// ── Preview opens ───────────────────────────────────────────────────────────
// The sidebar's browse gesture must not accumulate tabs. `preview: true` peeks,
// `preview: false` is the deliberate open that keeps the session, and an
// unqualified OPEN_THREAD (boot, a new session, a fallback) keeps by default
// without ever demoting or promoting a tab behind the user's back.

const previewIds = (state, key) =>
  (state.workspaces[key]?.tabs || []).filter((tab) => tab.preview).flatMap((tab) => layoutThreadIds(tab.layout));

test("browsing sessions with preview opens reuses one tab", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "c", preview: true });

  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["c"]);
  assert.equal(state.location.threadId, "c", "the peeked session is still on screen");
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["c"]);
});

test("a deliberate open keeps the session and promotes its preview tab", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: false });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });

  assert.deepEqual(
    workspaceThreadIds(state, SESSIONS_KEY),
    ["a", "b"],
    "the promoted session survived the next peek"
  );
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"]);
});

test("an unqualified open keeps a new tab but never re-flags an open one", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a" });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), [], "a plain open is a kept tab");

  // Focusing a previewed session from the tab strip or the URL must leave it
  // previewed, otherwise the slot is consumed by ordinary navigation.
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "a" });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b" });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"]);
});

test("PROMOTE_TAB keeps a previewed session by thread or by tab id", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["a"]);
  state = transition(state, { type: "PROMOTE_TAB", threadId: "a" });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), []);

  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"]);
  state = transition(state, { type: "PROMOTE_TAB", tabId: tabIdForThread("b") });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), []);
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a", "b"]);

  // Unknown targets must not throw or disturb the location.
  const before = state;
  state = transition(state, { type: "PROMOTE_TAB", threadId: "missing" });
  assert.deepEqual(state.location, before.location);
});

test("each context owns its own preview slot", () => {
  let state = createSessionViewState();
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "a",
    preview: true,
    context: project("p1"),
  });
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "b",
    preview: true,
    context: project("p2"),
  });

  assert.deepEqual(workspaceThreadIds(state, "p1"), ["a"], "p1 keeps its own peek");
  assert.deepEqual(workspaceThreadIds(state, "p2"), ["b"]);
  assert.deepEqual(previewIds(state, "p1"), ["a"], "p2's peek must not consume p1's slot");
  assert.deepEqual(previewIds(state, "p2"), ["b"]);
});

// Restoring a route is not a browse gesture: a shared/reloaded `?thread=` is a
// session the user asked for by name.
test("history restore opens a kept tab", () => {
  let state = createSessionViewState();
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
  });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), []);
});

// Retracing your steps is still browsing. Back/Forward walks the peeks you just
// made, so restoring one must reuse the preview slot exactly as the original
// click did — otherwise walking back through a browse deposits one permanent tab
// per step, which is the accumulation the preview tab exists to stop.
test("stepping back through a browse reuses the preview slot", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["b"]);

  // Back onto "a": its tab was replaced by "b", so this reopens it.
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
    preview: true,
  });
  assert.deepEqual(
    workspaceThreadIds(state, SESSIONS_KEY),
    ["a"],
    "back replaced the peek instead of stacking on it"
  );
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["a"]);
  assert.equal(state.location.threadId, "a");
});

// The other half of the contract: a session you kept must survive being stepped
// over, and stepping back onto it must not make it disposable again.
test("stepping back onto a kept session leaves it kept", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: false });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
    preview: true,
  });

  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a", "b"]);
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"], "the kept session was not demoted");
});

// Reload is not a gesture. A session you were only peeking at stays a peek
// across a refresh: preview-ness is persisted state and must round-trip
// faithfully, or refreshing the page would quietly pin whatever you happened to
// be looking at. (The other half — a link to a session you are NOT already
// holding open — is covered by "history restore opens a kept tab": there is no
// existing tab there, so the new one is kept.)
test("boot does not re-flag a session that is already open", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: true });

  // Reloading on ?thread=a, with a's preview tab restored from storage.
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
  });
  assert.deepEqual(
    previewIds(state, SESSIONS_KEY),
    ["a"],
    "a refresh neither keeps nor discards; it restores what was there"
  );
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a"]);

  // ...and it is still the slot the next peek takes.
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["b"]);

  // The same restore onto a KEPT session leaves it kept, symmetrically.
  state = transition(state, { type: "OPEN_THREAD", threadId: "c", preview: false });
  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "c",
  });
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["b"], "the kept session stayed kept");
});

// Closing a tab discards it, and that includes discarding the fact that it was
// kept — the tab and its state go together. So stepping Back onto a session you
// had kept and then closed reopens it the way any other back step does: as a
// peek. Keeping it again is one double click away.
test("back onto a kept-then-closed session reopens it as a peek", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "OPEN_THREAD", threadId: "a", preview: false });
  state = transition(state, { type: "CLOSE_TAB", tabId: tabIdForThread("a") });
  state = transition(state, { type: "OPEN_THREAD", threadId: "b", preview: true });

  state = transition(state, {
    type: "RESTORE_HISTORY",
    entry: { version: 1, context: sessions() },
    urlThreadId: "a",
    preview: true,
  });
  assert.deepEqual(workspaceThreadIds(state, SESSIONS_KEY), ["a"]);
  assert.deepEqual(previewIds(state, SESSIONS_KEY), ["a"]);
});

// --- The owning context of a session row -------------------------------------
//
// Regression guard for a state bug the Project switcher introduced. Under the old
// Projects mode the sidebar showed ONLY the selected project's sessions, so "open
// this row" and "open it in the selected project" were the same thing. Pinning
// changed that: the list keeps every session, so a row for an UNASSIGNED session
// sits on screen right next to a pinned project's group.
//
// Opening one has to land in the Sessions context. Expressing that as `null` does
// not work — `setThreadRoute` reads a null context as "use the current one", so
// the unassigned session was being filed into the selected project's tab
// workspace, and the switcher went on claiming that project. The context must be
// stated, never defaulted.
test("selectOwningContext puts an unassigned session in the sessions context", () => {
  assert.deepEqual(
    selectOwningContext({ threadId: "t1", threadProjectId: {} }),
    { kind: "sessions" }
  );
});

test("selectOwningContext follows membership into the owning project", () => {
  assert.deepEqual(
    selectOwningContext({ threadId: "t1", threadProjectId: { t1: "proj_a" } }),
    { kind: "project", projectId: "proj_a" }
  );
});

test("selectOwningContext ignores which project is currently selected", () => {
  // The whole point: the answer depends on the ROW, never on the selection.
  assert.deepEqual(
    selectOwningContext({ threadId: "t_unassigned", threadProjectId: { t_other: "proj_a" } }),
    { kind: "sessions" }
  );
});

test("selectOwningContext never returns null, so no caller can fall back to current", () => {
  for (const args of [
    { threadId: "t1", threadProjectId: null },
    { threadId: "t1" },
    { threadId: null, threadProjectId: { t1: "proj_a" } },
    {},
    undefined,
  ]) {
    const context = selectOwningContext(args);
    assert.ok(context && typeof context.kind === "string", `null-ish context for ${JSON.stringify(args)}`);
  }
});

// --- where deleting a project leaves you ------------------------------------

test("deleting the project you are IN returns you to the default workspace", () => {
  assert.deepEqual(
    selectContextAfterProjectDelete({
      context: { kind: "project", projectId: "proj_a" },
      deletedProjectId: "proj_a",
    }),
    { kind: "sessions" }
  );
});

// The receipt lists every surviving project, and the old inline branch navigated to
// the first of them. Nothing here can consult that list, which is the point: there is
// no number of survivors — zero, one, many — that changes the answer.
test("deleting the project you are in ignores how many projects survive", () => {
  const answer = selectContextAfterProjectDelete({
    context: { kind: "project", projectId: "proj_a" },
    deletedProjectId: "proj_a",
  });
  assert.deepEqual(answer, { kind: "sessions" });
  assert.equal(
    selectContextAfterProjectDelete.length <= 1,
    true,
    "it takes one options object and no survivor list — a list it cannot see is a list it cannot follow"
  );
});

// Null, not `{kind:"sessions"}`: the caller reads null as "do not navigate". Returning
// the sessions context here would make deleting some OTHER project from a menu throw
// you out of the project you are working in.
test("deleting a different project does not move you", () => {
  assert.equal(
    selectContextAfterProjectDelete({
      context: { kind: "project", projectId: "proj_a" },
      deletedProjectId: "proj_b",
    }),
    null
  );
});

test("deleting a project while in the default workspace does not move you", () => {
  assert.equal(
    selectContextAfterProjectDelete({ context: { kind: "sessions" }, deletedProjectId: "proj_a" }),
    null
  );
});

test("a missing project id is never treated as a match", () => {
  for (const deletedProjectId of ["", null, undefined, 0]) {
    assert.equal(
      selectContextAfterProjectDelete({ context: { kind: "project", projectId: "proj_a" }, deletedProjectId }),
      null,
      `${JSON.stringify(deletedProjectId)} must not match a real selection`
    );
  }
});

// The same shape as "a different project", but this is the case it exists for: the
// caller reads the context AFTER the delete resolves, so a user who navigated away
// while the request was in flight presents as "you are not in the deleted project".
// Deciding at confirm time instead made a late response yank them back out.
test("a context that moved on while the delete was in flight is left alone", () => {
  const whenConfirmed = { kind: "project", projectId: "proj_deleted" };
  const whenCompleted = { kind: "project", projectId: "proj_user_went_here" };

  assert.deepEqual(
    selectContextAfterProjectDelete({ context: whenConfirmed, deletedProjectId: "proj_deleted" }),
    { kind: "sessions" },
    "the confirm-time context would have navigated"
  );
  assert.equal(
    selectContextAfterProjectDelete({ context: whenCompleted, deletedProjectId: "proj_deleted" }),
    null,
    "the completion-time context must not"
  );
});

// ---- Task screen (context.kind === "tasks") --------------------------------

const tasks = (teamRunId = null) => ({ kind: "tasks", teamRunId });

test("a tasks context survives normalization instead of collapsing to sessions", () => {
  // `normalizeSessionViewContext` is a TOTAL function whose default branch is
  // `sessions`. Every consumer funnels through it, so a kind it does not know
  // about does not fail loudly — it silently becomes the sessions home, in about
  // twenty places at once.
  assert.deepEqual(normalizeSessionViewContext({ kind: "tasks" }), {
    kind: "tasks",
    teamRunId: null,
  });
  assert.deepEqual(normalizeSessionViewContext({ kind: "tasks", teamRunId: "team-1" }), {
    kind: "tasks",
    teamRunId: "team-1",
  });
  // An empty id is the list, not a detail view of a task called "".
  assert.deepEqual(normalizeSessionViewContext({ kind: "tasks", teamRunId: "" }), {
    kind: "tasks",
    teamRunId: null,
  });
});

test("a teams context survives normalization instead of collapsing to sessions", () => {
  assert.deepEqual(normalizeSessionViewContext({ kind: "teams" }), {
    kind: "teams",
    teamId: null,
  });
  assert.deepEqual(normalizeSessionViewContext({ kind: "teams", teamId: "builtin" }), {
    kind: "teams",
    teamId: "builtin",
  });
  assert.equal(isFullAreaContext({ kind: "teams" }), true);
});

test("a review context needs a run, and falls back to the task list without one", () => {
  // Unlike `tasks`, a null id is not a list state — the screen reviews ONE
  // branch. A bare `{kind:"review"}` surviving normalization would render the
  // mount with no run: a blank main area that reads as a failed load.
  assert.deepEqual(normalizeSessionViewContext({ kind: "review" }), {
    kind: "tasks",
    teamRunId: null,
  });
  assert.deepEqual(normalizeSessionViewContext({ kind: "review", teamRunId: "" }), {
    kind: "tasks",
    teamRunId: null,
  });
  assert.deepEqual(normalizeSessionViewContext({ kind: "review", teamRunId: "team-1" }), {
    kind: "review",
    teamRunId: "team-1",
  });
});

test("the review screen is full-area, and does not alias the task it came from", () => {
  // Both halves matter. Missing `isFullAreaContext` files a thread tab under a
  // context with no tab strip — the documented silent bug. Sharing a key with
  // `tasks:<id>` makes Back unable to tell the two apart.
  assert.equal(isFullAreaContext({ kind: "review", teamRunId: "team-1" }), true);
  assert.equal(isFullAreaWorkspaceKey(sessionViewContextKey(review("team-1"))), true);
  assert.notEqual(
    sessionViewContextKey(review("team-1")),
    sessionViewContextKey(tasks("team-1"))
  );
  assert.notEqual(sessionViewContextKey(review("team-1")), SESSIONS_KEY);
});

test("a review context cannot hold a thread tab", () => {
  // `OPEN_THREAD` inherits the current context when none is passed, which on a
  // full-area screen files the tab where no strip can show it. The reducer's
  // floor must redirect it, as it already does for `tasks`.
  let state = createSessionViewState();
  state = transition(state, { type: "SHOW_OVERVIEW", context: review("team-1") });
  assert.deepEqual(state.location.context, { kind: "review", teamRunId: "team-1" });
  assert.equal(state.location.threadId, null);

  state = transition(state, { type: "OPEN_THREAD", threadId: "thread-a" });
  assert.deepEqual(
    sessionViewInvariantErrors(state),
    [],
    "a thread opened from the review screen must land somewhere it can be seen"
  );
  assert.notEqual(state.location.context.kind, "review");
});

test("the task list and one task's detail are different history entries", () => {
  // `sameLocation` compares by context KEY, and `defaultHistoryMode` only pushes
  // when the location changed. Sharing one key between the list and a detail view
  // would make opening a task invisible to the back button.
  const listKey = sessionViewContextKey(tasks());
  const detailKey = sessionViewContextKey(tasks("team-1"));
  assert.notEqual(listKey, detailKey);
  assert.notEqual(listKey, SESSIONS_KEY, "tasks must not alias the sessions workspace");
  assert.notEqual(detailKey, SESSIONS_KEY);
  assert.equal(sessionViewContextKey(tasks("team-1")), detailKey, "the key must be stable");
});

test("SHOW_OVERVIEW into tasks shows no thread but keeps each workspace's memory", () => {
  let state = createSessionViewState();
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "thread-a",
    context: sessions(),
  });
  assert.equal(state.location.threadId, "thread-a");

  state = transition(state, { type: "SHOW_OVERVIEW", context: tasks() });
  assert.deepEqual(state.location.context, { kind: "tasks", teamRunId: null });
  assert.equal(state.location.threadId, null, "a full-area screen shows no conversation");

  // Going back to sessions must restore the thread that was there.
  state = transition(state, { type: "SWITCH_CONTEXT", context: sessions() });
  assert.equal(state.location.threadId, "thread-a");
});

test("a persisted tasks context round-trips through history", () => {
  let state = createSessionViewState();
  state = transition(state, { type: "SHOW_OVERVIEW", context: tasks("team-7") });
  const entry = sessionViewHistoryEntry(state);

  let restored = createSessionViewState();
  restored = transition(
    restored,
    { type: "RESTORE_HISTORY", entry },
    { projectIds: ["project-1"], projectIdsComplete: true }
  );
  assert.deepEqual(restored.location.context, { kind: "tasks", teamRunId: "team-7" });
});

test("a tasks context is not validated against the project list", () => {
  // A project id that no longer exists must fall back to sessions, because the
  // sidebar scopes itself to it. A task id that no longer exists is different:
  // the screen can say so, and the run's branch is still on disk. Dropping the
  // user back at the sessions home would hide the fact that the task is gone.
  let state = createSessionViewState();
  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: { version: 1, context: { kind: "tasks", teamRunId: "team-vanished" } },
    },
    { projectIds: [], projectIdsComplete: true }
  );
  assert.deepEqual(state.location.context, { kind: "tasks", teamRunId: "team-vanished" });
});

test("opening a thread from the Task screen files it under the thread's own context", () => {
  // The trap: OPEN_THREAD with no explicit context inherits the current one. A
  // team node clicked on the Task screen would then get a tab in the TASKS
  // workspace — a bucket that screen never shows, so the tab is invisible and the
  // session appears not to have opened at all.
  let state = createSessionViewState();
  state = transition(state, { type: "SHOW_OVERVIEW", context: tasks("team-1") });
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "dev-thread",
    context: selectOwningContext({ threadId: "dev-thread", threadProjectId: {} }),
  });

  assert.deepEqual(state.location.context, { kind: "sessions" });
  assert.deepEqual(
    layoutThreadIds(state.workspaces[SESSIONS_KEY].tabs[0].layout),
    ["dev-thread"]
  );
  // A bucket is created lazily by `workspaceFor` and never written to disk while
  // it stays empty, so its existence is harmless. What must never happen is a TAB
  // landing in it: that tab is unreachable, because the Task screen renders no tab
  // strip, so the session would read as having failed to open.
  assert.deepEqual(
    state.workspaces[sessionViewContextKey(tasks("team-1"))]?.tabs ?? [],
    [],
    "the Task screen must never accumulate tabs"
  );
});

test("OPEN_THREAD can never file a tab into the Task screen's workspace", () => {
  // The Task screen renders no tab strip, so a tab filed there is unreachable —
  // and because `mainView` is derived from the context, the screen keeps
  // rendering and the thread never appears. Clicking a seat does nothing.
  //
  // The call site is supposed to pass the thread's OWNING context, but this is
  // the layer that can guarantee it: a tasks context cannot hold tabs, so
  // OPEN_THREAD into one resolves to the sessions home rather than a workspace
  // no UI can show. Defence in depth for every future call site, not just the
  // three that exist today.
  let state = createSessionViewState();
  state = transition(state, { type: "SHOW_OVERVIEW", context: tasks("team-1") });
  state = transition(state, { type: "OPEN_THREAD", threadId: "dev-thread" });

  assert.notEqual(
    state.location.context.kind,
    "tasks",
    "a thread must never be opened into the Task screen"
  );
  assert.equal(state.location.threadId, "dev-thread");
  assert.deepEqual(
    layoutThreadIds(state.workspaces[SESSIONS_KEY].tabs[0].layout),
    ["dev-thread"]
  );
  assert.deepEqual(state.workspaces[sessionViewContextKey(tasks("team-1"))]?.tabs ?? [], []);
});

test("an explicit context still wins when opening a thread from the Task screen", () => {
  // The guard above is a floor, not a replacement for the call site knowing where
  // the thread belongs: a session inside a project must still land in that
  // project's tab set.
  let state = createSessionViewState();
  state = transition(state, { type: "SHOW_OVERVIEW", context: tasks("team-1") });
  state = transition(state, {
    type: "OPEN_THREAD",
    threadId: "dev-thread",
    context: project("project-1"),
  });

  assert.deepEqual(state.location.context, { kind: "project", projectId: "project-1" });
  assert.deepEqual(
    layoutThreadIds(state.workspaces["project-1"].tabs[0].layout),
    ["dev-thread"]
  );
});

test("RESTORE_HISTORY cannot file a tab into the Task screen's workspace either", () => {
  // The same hole, in the other branch that creates tabs. `OPEN_THREAD` was
  // guarded; `RESTORE_HISTORY` opens a tab too, from a persisted context plus a
  // thread id off the URL. Latent today — the history adapter drops `?thread=`
  // when no thread is routed, so the pair is unwritable — but the guard's whole
  // claim is that it holds for call sites that do not exist yet.
  let state = createSessionViewState();
  state = transition(
    state,
    {
      type: "RESTORE_HISTORY",
      entry: { version: 1, context: { kind: "tasks", teamRunId: "team-1" } },
      urlThreadId: "dev-thread",
    },
    { projectIds: [], projectIdsComplete: true }
  );

  assert.notEqual(state.location.context.kind, "tasks");
  assert.deepEqual(
    layoutThreadIds(state.workspaces[SESSIONS_KEY].tabs[0].layout),
    ["dev-thread"]
  );
  assert.deepEqual(state.workspaces[sessionViewContextKey(tasks("team-1"))]?.tabs ?? [], []);
});

test("the invariant checker refuses a thread routed into a tab-less context", () => {
  // Belt to the reducer's braces: whatever produced it, a state that routes a
  // thread under a tasks context is invalid, and saying so here means a future
  // mutation path cannot introduce it quietly.
  const errors = sessionViewInvariantErrors({
    location: { context: { kind: "tasks", teamRunId: "team-1" }, threadId: "dev-thread" },
    workspaces: {},
  });
  assert.ok(
    errors.some((message) => message.includes("cannot hold a thread tab")),
    `expected the tasks-context complaint, got ${JSON.stringify(errors)}`
  );
});

test("the Sessions return memory survives every transition made while Tasks is showing", () => {
  // Three separate bugs so far were all the same shape: some helper rebuilt state
  // through `createSessionViewState` without carrying `returnContext`, so it got
  // re-derived from the location — and while Tasks is showing, the location says
  // "no project". The outer reducer repairs a case that merely LANDS somewhere, but
  // not one that READS the memory to decide where to land. This pins the seam
  // directly, so the next helper that forgets is caught here rather than by a user.
  const owning = project("project-1");
  let state = transition(
    createSessionViewState({ location: { context: owning, threadId: null } }),
    { type: "OPEN_THREAD", threadId: "thread-in-project", context: owning }
  );
  state = transition(state, { type: "SHOW_OVERVIEW", context: tasks() });
  assert.deepEqual(state.returnContext, owning, "precondition: the project is remembered");

  // A tombstone list is supplied on every real command, so every case below sweeps.
  const facts = { unavailableThreadIds: ["a-session-deleted-long-ago"] };
  const whileOnTasks = [
    { type: "SHOW_OVERVIEW", context: tasks("run-7") },
    { type: "SHOW_OVERVIEW", context: null },
    { type: "REMOVE_THREAD", threadId: "some-other-thread" },
    { type: "PIN_TAB", tabId: "no-such-tab", pinned: true },
    { type: "MOVE_TAB", tabId: "no-such-tab", toIndex: 0 },
    { type: "CLOSE_TAB", tabId: "no-such-tab" },
    { type: "PROMOTE_TAB", tabId: "no-such-tab" },
    { type: "NOT_AN_ACTION" },
  ];
  for (const action of whileOnTasks) {
    const next = reduceSessionView(state, action, facts);
    assert.deepEqual(
      next.returnContext,
      owning,
      `${action.type} flattened the return memory`
    );
  }

  // And the whole point of keeping it: the return itself still lands on the project.
  const returned = reduceSessionView(state, { type: "RETURN_TO_SESSIONS" }, facts);
  assert.deepEqual(returned.location.context, owning);
  assert.equal(returned.location.threadId, "thread-in-project");
});

// ── The ticket page (17b) ───────────────────────────────────────────────────
// A new full-area screen has to be REGISTERED, not just normalised. The module
// doc says so: "Adding another such screen should be one entry here, not an
// audit." Missing it is invisible in the markup and breaks navigation — the
// Sessions button stops returning, and every ticket collapses onto one
// undefined workspace key.
const ticket = (teamRunId) => ({ kind: "ticket", teamRunId });

test("a ticket context is a full-area screen", () => {
  assert.equal(isFullAreaContext(ticket("t1")), true);
});

test("each ticket gets its own workspace key, and it is a full-area one", () => {
  const one = sessionViewContextKey(ticket("t1"));
  const two = sessionViewContextKey(ticket("t2"));
  assert.ok(one, "a ticket context must produce a key");
  assert.notEqual(one, two, "two tickets must not share a workspace");
  assert.notEqual(one, undefined);
  assert.equal(isFullAreaWorkspaceKey(one), true);
});

// `validHistoryWorkspaces` is an allowlist and everything it omits is DELETED on
// restore, so an unrecognised shape silently drops the screen's stored state.
test("a ticket workspace key survives the persistence allowlist", () => {
  assert.equal(isFullAreaWorkspaceKey(sessionViewContextKey(ticket("t9"))), true);
});

test("Sessions returns from a ticket rather than staying on it", () => {
  assert.deepEqual(selectContextAfterProjectDelete
    ? normalizeSessionViewContext(ticket("t1"))
    : null, { kind: "ticket", teamRunId: "t1" });
  // The predicate is what every return site consults.
  assert.equal(isFullAreaContext(normalizeSessionViewContext(ticket("t1"))), true);
});
